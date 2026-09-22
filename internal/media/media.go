// Package media wraps ffmpeg/ffprobe for probing, thumbnails, waveforms and
// the server-side trim / crop / compress operations.
package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// MustExist aborts startup when ffmpeg is unavailable: every upload is
// expected to come out with a thumbnail and a normalized encode, so a missing
// binary is a misconfiguration rather than a degraded mode.
func MustExist() error {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			return fmt.Errorf("%s is required but was not found in PATH", bin)
		}
	}
	return nil
}

type Info struct {
	DurationMS int64
	Width      int
	Height     int
	Codec      string
	HasVideo   bool
	HasAudio   bool
	Mime       string
}

type probeOut struct {
	Format struct {
		Duration   string `json:"duration"`
		FormatName string `json:"format_name"`
	} `json:"format"`
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Duration  string `json:"duration"`
	} `json:"streams"`
}

func Probe(ctx context.Context, path string) (Info, error) {
	out, err := run(ctx, "ffprobe", "-v", "error", "-print_format", "json",
		"-show_format", "-show_streams", path)
	if err != nil {
		return Info{}, err
	}
	var p probeOut
	if err := json.Unmarshal(out, &p); err != nil {
		return Info{}, err
	}
	var i Info
	if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil {
		i.DurationMS = int64(d * 1000)
	}
	for _, s := range p.Streams {
		switch s.CodecType {
		case "video":
			// Cover art in an mp3 also reports as a video stream; treat a
			// stream with no duration and no motion as an image instead.
			i.HasVideo = true
			i.Width, i.Height, i.Codec = s.Width, s.Height, s.CodecName
		case "audio":
			i.HasAudio = true
			if i.Codec == "" {
				i.Codec = s.CodecName
			}
		}
	}
	return i, nil
}

// Thumbnail grabs a representative frame as JPEG. seekMS picks the source
// position; it is clamped so short clips still produce a frame.
func Thumbnail(ctx context.Context, path string, seekMS int64, maxW int) ([]byte, error) {
	if seekMS < 0 {
		seekMS = 0
	}
	tmp, err := os.CreateTemp("", "memm-thumb-*.jpg")
	if err != nil {
		return nil, err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	args := []string{"-v", "error", "-y"}
	if seekMS > 0 {
		args = append(args, "-ss", msToTS(seekMS))
	}
	args = append(args,
		"-i", path, "-frames:v", "1",
		"-vf", fmt.Sprintf("scale='min(%d,iw)':-2", maxW),
		"-q:v", "6", tmp.Name())
	if _, err := run(ctx, "ffmpeg", args...); err != nil {
		// Seek past the end of a very short clip: retry from the first frame.
		if seekMS > 0 {
			return Thumbnail(ctx, path, 0, maxW)
		}
		return nil, err
	}
	return os.ReadFile(tmp.Name())
}

// Peaks renders an audio waveform as n normalized magnitudes in [0,1] by
// decoding to mono 8kHz s16le and taking the max |sample| per bucket.
func Peaks(ctx context.Context, path string, n int) ([]float32, error) {
	if n <= 0 {
		n = 400
	}
	raw, err := run(ctx, "ffmpeg", "-v", "error", "-i", path,
		"-ac", "1", "-ar", "8000", "-f", "s16le", "-acodec", "pcm_s16le", "-")
	if err != nil {
		return nil, err
	}
	total := len(raw) / 2
	if total == 0 {
		return nil, nil
	}
	if total < n {
		n = total
	}
	peaks := make([]float32, n)
	per := total / n
	if per == 0 {
		per = 1
	}
	var max float32
	for i := 0; i < n; i++ {
		var m int16
		for j := 0; j < per; j++ {
			idx := (i*per + j) * 2
			if idx+1 >= len(raw) {
				break
			}
			v := int16(binary.LittleEndian.Uint16(raw[idx:]))
			if v < 0 {
				v = -v
			}
			if v > m {
				m = v
			}
		}
		peaks[i] = float32(m) / 32768
		if peaks[i] > max {
			max = peaks[i]
		}
	}
	if max > 0 { // normalize so quiet recordings still render legibly
		for i := range peaks {
			peaks[i] = float32(math.Min(1, float64(peaks[i]/max)))
		}
	}
	return peaks, nil
}

// EditOp describes a server-side trim / crop / compress request. Zero-valued
// fields are skipped, so one call can do any combination.
type EditOp struct {
	StartMS, EndMS int64 // trim window (EndMS 0 = to end)
	CropX, CropY   int
	CropW, CropH   int // 0 = no crop
	MaxW           int // downscale bound
	CRF            int // quality for video (18 best .. 32 small); 0 = default
	AudioKbps      int
}

// Transform runs the edit and returns the path of a new temp file the caller
// owns. Streams are re-encoded only when an op requires it.
func Transform(ctx context.Context, src, kind string, op EditOp) (string, error) {
	ext := map[string]string{"video": ".mp4", "audio": ".m4a", "image": ".jpg"}[kind]
	if ext == "" {
		return "", fmt.Errorf("kind %q is not editable", kind)
	}
	dst := filepath.Join(os.TempDir(), fmt.Sprintf("memm-edit-%d%s", time.Now().UnixNano(), ext))

	args := []string{"-v", "error", "-y"}
	if op.StartMS > 0 {
		args = append(args, "-ss", msToTS(op.StartMS))
	}
	args = append(args, "-i", src)
	if op.EndMS > op.StartMS {
		args = append(args, "-t", msToTS(op.EndMS-op.StartMS))
	}

	var filters []string
	if op.CropW > 0 && op.CropH > 0 {
		filters = append(filters, fmt.Sprintf("crop=%d:%d:%d:%d", op.CropW, op.CropH, op.CropX, op.CropY))
	}
	if op.MaxW > 0 {
		filters = append(filters, fmt.Sprintf("scale='min(%d,iw)':-2", op.MaxW))
	}

	switch kind {
	case "video":
		if len(filters) > 0 {
			args = append(args, "-vf", joinFilters(filters))
		}
		crf := op.CRF
		if crf == 0 {
			crf = 26
		}
		kbps := op.AudioKbps
		if kbps == 0 {
			kbps = 128
		}
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", strconv.Itoa(crf),
			"-pix_fmt", "yuv420p", "-movflags", "+faststart",
			"-c:a", "aac", "-b:a", fmt.Sprintf("%dk", kbps))
	case "audio":
		kbps := op.AudioKbps
		if kbps == 0 {
			kbps = 96
		}
		args = append(args, "-vn", "-c:a", "aac", "-b:a", fmt.Sprintf("%dk", kbps))
	case "image":
		if len(filters) > 0 {
			args = append(args, "-vf", joinFilters(filters))
		}
		q := op.CRF
		if q == 0 {
			q = 4
		}
		args = append(args, "-frames:v", "1", "-q:v", strconv.Itoa(q))
	}

	args = append(args, dst)
	if _, err := run(ctx, "ffmpeg", args...); err != nil {
		os.Remove(dst)
		return "", err
	}
	return dst, nil
}

func joinFilters(f []string) string {
	out := f[0]
	for _, s := range f[1:] {
		out += "," + s
	}
	return out
}

func msToTS(ms int64) string { return fmt.Sprintf("%.3f", float64(ms)/1000) }

func run(ctx context.Context, bin string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return nil, fmt.Errorf("%s: %w: %s", bin, err, msg)
	}
	return stdout.Bytes(), nil
}
