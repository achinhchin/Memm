package api

import (
	"net/http"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var hashRe = regexp.MustCompile(`^[a-f0-9]{64}$`)

// handleBlob streams stored bytes. http.ServeContent does the heavy lifting:
// Range requests (video seeking), If-Modified-Since and HEAD all come free,
// and the response is never gzipped so byte ranges stay meaningful.
func (s *Server) handleBlob(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	if !hashRe.MatchString(hash) {
		fail(w, http.StatusBadRequest, "bad blob id")
		return
	}
	// A blob is only readable by someone who owns an entry pointing at it.
	n, err := s.db.Entries.CountDocuments(r.Context(), bson.M{
		"userId": user(r).ID,
		"$or":    []bson.M{{"blob": hash}, {"thumb": hash}},
	}, options.Count().SetLimit(1))
	if err != nil || n == 0 {
		fail(w, http.StatusNotFound, "blob not found")
		return
	}

	f, st, err := s.blobs.Open(hash)
	if err != nil {
		fail(w, http.StatusNotFound, "blob not found")
		return
	}
	defer f.Close()

	if mime := r.URL.Query().Get("mime"); mime != "" {
		w.Header().Set("Content-Type", mime)
	}
	// Content-addressed bytes never change, so they can be cached forever.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+hash+`"`)
	w.Header().Set("Accept-Ranges", "bytes")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+hash[:12]+`"`)
	}
	http.ServeContent(w, r, "", st.ModTime().UTC().Truncate(time.Second), f)
}
