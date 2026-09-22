package api

import (
	"net/http"
	"os"
	"strconv"
	"time"

	"memm/internal/media"
	"memm/internal/models"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// handleOffset reports how many bytes of this entry the server already holds,
// so a client whose connection dropped mid-recording can resume exactly.
func (s *Server) handleOffset(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	send(w, http.StatusOK, map[string]any{"offset": s.blobs.Offset(e.ID.Hex()), "status": e.Status})
}

// handleChunk appends one buffered slice of a live capture. The body is
// streamed straight to disk — nothing is held in memory — and the client sends
// its running offset so a duplicate retry is detected rather than doubled.
func (s *Server) handleChunk(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	if e.Status != models.StatusRecording {
		fail(w, http.StatusConflict, "entry is already finalized")
		return
	}
	id := e.ID.Hex()
	have := s.blobs.Offset(id)
	if v := r.Header.Get("X-Offset"); v != "" {
		want, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			fail(w, http.StatusBadRequest, "bad X-Offset header")
			return
		}
		if want != have {
			// Tell the client where we actually are; it re-slices and retries.
			w.Header().Set("X-Offset", strconv.FormatInt(have, 10))
			fail(w, http.StatusConflict, "offset mismatch")
			return
		}
	}
	defer r.Body.Close()
	size, err := s.blobs.Append(id, r.Body, s.cfg.MaxChunk)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not store chunk")
		return
	}
	// Keep endsAt moving so an in-progress recording renders with a growing
	// block on the timeline instead of a zero-width sliver.
	now := time.Now().UTC()
	s.db.Entries.UpdateByID(r.Context(), e.ID, bson.M{"$set": bson.M{
		"size": size, "endsAt": now, "updatedAt": now,
	}})
	// Let other devices watch the block grow while the take is still running.
	e.Size, e.EndsAt, e.UpdatedAt = size, now, now
	s.emitEntry(e.UserID, e)
	send(w, http.StatusOK, map[string]any{"offset": size})
}

type finishReq struct {
	EndsAt   *time.Time `json:"endsAt"`
	Mime     string     `json:"mime"`
	Title    string     `json:"title"`
	Compress bool       `json:"compress"` // re-encode server-side to shrink
	MaxW     int        `json:"maxW"`
	CRF      int        `json:"crf"`
}

// handleFinish seals a streamed capture: commit the staging file to the blob
// store, probe it, derive a thumbnail or waveform, and mark it ready.
func (s *Server) handleFinish(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	var req finishReq
	decode(r, &req)

	id := e.ID.Hex()
	if s.blobs.Offset(id) == 0 {
		s.db.Entries.UpdateByID(r.Context(), e.ID,
			bson.M{"$set": bson.M{"status": models.StatusFailed, "updatedAt": time.Now().UTC()}})
		fail(w, http.StatusBadRequest, "no data was uploaded for this entry")
		return
	}

	hash, size, err := s.blobs.Commit(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not commit upload")
		return
	}

	// Optional server-side compression pass; the client asks for it when it
	// could not (or chose not to) shrink the capture itself.
	if req.Compress && (e.Kind == models.KindVideo || e.Kind == models.KindAudio || e.Kind == models.KindImage) {
		if out, err := media.Transform(r.Context(), s.blobs.Path(hash), e.Kind,
			media.EditOp{MaxW: req.MaxW, CRF: req.CRF}); err == nil {
			if nh, ns, err := s.blobs.PutFile(out); err == nil {
				os.Remove(out)
				if nh != hash {
					s.releaseBlob(r, hash)
				}
				hash, size = nh, ns
			}
		}
	}

	set := bson.M{
		"blob": hash, "size": size, "status": models.StatusReady,
		"updatedAt": time.Now().UTC(),
	}
	if req.Mime != "" {
		set["mime"] = req.Mime
	}
	if req.Title != "" {
		set["title"] = req.Title
	}

	path := s.blobs.Path(hash)
	info, probeErr := media.Probe(r.Context(), path)
	if probeErr == nil {
		meta := map[string]any{"codec": info.Codec}
		if info.Width > 0 {
			meta["width"], meta["height"] = info.Width, info.Height
		}
		set["meta"] = meta
		// Images have no duration: keep the caller's window. For timed media
		// the decoded duration is authoritative, so endsAt is derived from it.
		if e.Kind != models.KindImage && info.DurationMS > 0 {
			set["durationMs"] = info.DurationMS
			set["endsAt"] = e.StartsAt.Add(time.Duration(info.DurationMS) * time.Millisecond)
		}
	}
	if req.EndsAt != nil && e.Kind == models.KindImage {
		set["endsAt"] = req.EndsAt.UTC()
	}

	switch e.Kind {
	case models.KindVideo, models.KindImage:
		seek := int64(0)
		if e.Kind == models.KindVideo && info.DurationMS > 2000 {
			seek = info.DurationMS / 10
		}
		if jpg, err := media.Thumbnail(r.Context(), path, seek, 480); err == nil {
			if th, _, err := s.blobs.Put(jpg); err == nil {
				set["thumb"] = th
			}
		}
	case models.KindAudio:
		if peaks, err := media.Peaks(r.Context(), path, 400); err == nil {
			set["peaks"] = peaks
		}
	}

	if _, err := s.db.Entries.UpdateByID(r.Context(), e.ID, bson.M{"$set": set}); err != nil {
		fail(w, http.StatusInternalServerError, "could not finalize entry")
		return
	}
	out, _ := s.load(r, e.ID)
	s.emitEntry(e.UserID, out)
	send(w, http.StatusOK, out)
}

type textReq struct {
	Text   string     `json:"text"`
	EndsAt *time.Time `json:"endsAt"`
}

// handleText is the markdown / stroke autosave path. These payloads are small
// and rewritten constantly, so they live in the document rather than the blob
// store, where every keystroke batch would orphan a file.
func (s *Server) handleText(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	if e.Kind != models.KindMarkdown && e.Kind != models.KindStroke {
		fail(w, http.StatusBadRequest, "this entry kind has no text body")
		return
	}
	var req textReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	now := time.Now().UTC()
	end := now
	if req.EndsAt != nil {
		end = req.EndsAt.UTC()
	}
	set := bson.M{
		"text": req.Text, "size": int64(len(req.Text)), "updatedAt": now,
		"endsAt": end, "durationMs": end.Sub(e.StartsAt).Milliseconds(),
		"status": models.StatusReady,
	}
	if _, err := s.db.Entries.UpdateByID(r.Context(), e.ID, bson.M{"$set": set}); err != nil {
		fail(w, http.StatusInternalServerError, "could not save")
		return
	}
	if fresh, err := s.load(r, e.ID); err == nil {
		s.emitEntry(e.UserID, fresh)
	}
	send(w, http.StatusOK, map[string]any{"ok": true, "savedAt": now, "size": len(req.Text)})
}

// handleEdit applies a server-side trim / crop / compress and repoints the
// entry at the new blob. This is the fallback for clients that cannot do the
// work locally (older mobile browsers, very large files).
func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	if e.Blob == "" {
		fail(w, http.StatusBadRequest, "entry has no media to edit")
		return
	}
	var q struct {
		StartMS      int64 `json:"startMs"`
		EndMS        int64 `json:"endMs"`
		CropX        int   `json:"cropX"`
		CropY        int   `json:"cropY"`
		CropW        int   `json:"cropW"`
		CropH        int   `json:"cropH"`
		MaxW         int   `json:"maxW"`
		CRF          int   `json:"crf"`
		AudioKbps    int   `json:"audioKbps"`
		KeepOriginal bool  `json:"keepOriginal"`
	}
	if err := decode(r, &q); err != nil {
		fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	out, err := media.Transform(r.Context(), s.blobs.Path(e.Blob), e.Kind, media.EditOp{
		StartMS: q.StartMS, EndMS: q.EndMS,
		CropX: q.CropX, CropY: q.CropY, CropW: q.CropW, CropH: q.CropH,
		MaxW: q.MaxW, CRF: q.CRF, AudioKbps: q.AudioKbps,
	})
	if err != nil {
		fail(w, http.StatusUnprocessableEntity, "edit failed: "+err.Error())
		return
	}
	defer os.Remove(out)

	hash, size, err := s.blobs.PutFile(out)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not store edited file")
		return
	}
	old, oldThumb := e.Blob, e.Thumb

	set := bson.M{"blob": hash, "size": size, "updatedAt": time.Now().UTC()}
	path := s.blobs.Path(hash)
	if info, err := media.Probe(r.Context(), path); err == nil {
		if info.Width > 0 {
			set["meta"] = map[string]any{"codec": info.Codec, "width": info.Width, "height": info.Height}
		}
		if e.Kind != models.KindImage && info.DurationMS > 0 {
			set["durationMs"] = info.DurationMS
			// A trim shifts the entry's real-world window: the clip now starts
			// StartMS into the original capture.
			start := e.StartsAt.Add(time.Duration(q.StartMS) * time.Millisecond)
			set["startsAt"] = start
			set["endsAt"] = start.Add(time.Duration(info.DurationMS) * time.Millisecond)
		}
	}
	switch e.Kind {
	case models.KindVideo, models.KindImage:
		if jpg, err := media.Thumbnail(r.Context(), path, 0, 480); err == nil {
			if th, _, err := s.blobs.Put(jpg); err == nil {
				set["thumb"] = th
			}
		}
	case models.KindAudio:
		if peaks, err := media.Peaks(r.Context(), path, 400); err == nil {
			set["peaks"] = peaks
		}
	}

	if _, err := s.db.Entries.UpdateByID(r.Context(), e.ID, bson.M{"$set": set}); err != nil {
		fail(w, http.StatusInternalServerError, "could not update entry")
		return
	}
	if !q.KeepOriginal {
		if old != hash {
			s.releaseBlob(r, old)
		}
		if nt, _ := set["thumb"].(string); nt != "" && nt != oldThumb {
			s.releaseBlob(r, oldThumb)
		}
	}
	res, _ := s.load(r, e.ID)
	s.emitEntry(e.UserID, res)
	send(w, http.StatusOK, res)
}
