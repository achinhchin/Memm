// Package store is a content-addressed blob store on the local filesystem.
//
// Bytes land in <root>/blobs/<aa>/<bb>/<sha256>. Addressing by hash means two
// identical uploads share one file for free, and serving is a plain os.Open so
// http.ServeContent can satisfy Range requests with sendfile-style copies.
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type Store struct{ root string }

func New(root string) (*Store, error) {
	s := &Store{root: root}
	return s, os.MkdirAll(s.blobDir(), 0o750)
}

func (s *Store) blobDir() string { return filepath.Join(s.root, "blobs") }
func (s *Store) tmpDir() string  { return filepath.Join(s.root, "tmp") }

// Path is the on-disk location for a hash. Sharding on the first two byte
// pairs keeps any single directory small enough for fast lookups.
func (s *Store) Path(hash string) string {
	if len(hash) < 4 {
		return ""
	}
	return filepath.Join(s.blobDir(), hash[0:2], hash[2:4], hash)
}

// TempPath is the staging file an in-progress (streamed) upload appends to.
func (s *Store) TempPath(id string) string { return filepath.Join(s.tmpDir(), id+".part") }

// Append streams r onto the end of the staging file for id and returns the new
// total size. Used for live audio/video capture: the client keeps PUTing
// buffered chunks while recording, and a dropped connection just resumes from
// the size reported by Offset.
func (s *Store) Append(id string, r io.Reader, limit int64) (int64, error) {
	if err := os.MkdirAll(s.tmpDir(), 0o750); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(s.TempPath(id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	if _, err := io.Copy(f, io.LimitReader(r, limit)); err != nil {
		return 0, err
	}
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func (s *Store) Offset(id string) int64 {
	if st, err := os.Stat(s.TempPath(id)); err == nil {
		return st.Size()
	}
	return 0
}

// Commit hashes the staging file and moves it into the blob store. If a blob
// with that hash already exists the staging file is simply dropped.
func (s *Store) Commit(id string) (hash string, size int64, err error) {
	return s.commitFile(s.TempPath(id), true)
}

// PutFile ingests an existing file (e.g. an ffmpeg output) into the store.
func (s *Store) PutFile(path string) (hash string, size int64, err error) {
	return s.commitFile(path, false)
}

func (s *Store) commitFile(path string, move bool) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	size, err := io.Copy(h, f)
	f.Close()
	if err != nil {
		return "", 0, err
	}
	hash := hex.EncodeToString(h.Sum(nil))
	dst := s.Path(hash)
	if _, err := os.Stat(dst); err == nil { // dedupe hit
		if move {
			os.Remove(path)
		}
		return hash, size, nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return "", 0, err
	}
	if err := os.Rename(path, dst); err != nil {
		// Rename fails across devices; fall back to a copy.
		if err := copyFile(path, dst); err != nil {
			return "", 0, err
		}
		if move {
			os.Remove(path)
		}
	}
	return hash, size, nil
}

// Put stores an in-memory blob (thumbnails, small payloads).
func (s *Store) Put(b []byte) (string, int64, error) {
	sum := sha256.Sum256(b)
	hash := hex.EncodeToString(sum[:])
	dst := s.Path(hash)
	if _, err := os.Stat(dst); err == nil {
		return hash, int64(len(b)), nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return "", 0, err
	}
	return hash, int64(len(b)), os.WriteFile(dst, b, 0o640)
}

func (s *Store) Open(hash string) (*os.File, os.FileInfo, error) {
	p := s.Path(hash)
	if p == "" {
		return nil, nil, errors.New("bad hash")
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, st, nil
}

// Remove deletes a blob. Callers must confirm no entry still references it.
func (s *Store) Remove(hash string) error {
	if p := s.Path(hash); p != "" {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func (s *Store) Discard(id string) { os.Remove(s.TempPath(id)) }

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
