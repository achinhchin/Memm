package api

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"memm/internal/config"
	"memm/internal/db"
	"memm/internal/models"
	"memm/internal/store"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const sessionCookie = "memm_session"
const sessionTTL = 30 * 24 * time.Hour

type Server struct {
	cfg    config.Config
	db     *db.DB
	blobs  *store.Store
	bundle *bundler
	events *hub
}

func New(cfg config.Config, database *db.DB, blobs *store.Store) *Server {
	return &Server{cfg: cfg, db: database, blobs: blobs,
		bundle: newBundler(cfg.ClientDir, cfg.Dev), events: newHub()}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/auth/signup", s.handleSignup)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.auth(s.handleLogout))
	mux.HandleFunc("GET /api/auth/me", s.auth(s.handleMe))

	mux.HandleFunc("GET /api/entries", s.auth(s.handleList))
	mux.HandleFunc("POST /api/entries", s.auth(s.handleCreate))
	mux.HandleFunc("GET /api/entries/{id}", s.auth(s.handleGet))
	mux.HandleFunc("PATCH /api/entries/{id}", s.auth(s.handlePatch))
	mux.HandleFunc("DELETE /api/entries/{id}", s.auth(s.handleDelete))

	// Streaming capture: append while recording, then finalize.
	mux.HandleFunc("GET /api/entries/{id}/offset", s.auth(s.handleOffset))
	mux.HandleFunc("PUT /api/entries/{id}/chunk", s.auth(s.handleChunk))
	mux.HandleFunc("POST /api/entries/{id}/finish", s.auth(s.handleFinish))
	// Markdown / stroke autosave.
	mux.HandleFunc("PUT /api/entries/{id}/text", s.auth(s.handleText))
	// Server-side trim / crop / compress.
	mux.HandleFunc("POST /api/entries/{id}/edit", s.auth(s.handleEdit))

	// Live change feed, so one account recording on several devices stays in
	// sync without any of them polling.
	mux.HandleFunc("GET /api/events", s.auth(s.handleEvents))

	mux.HandleFunc("GET /api/blob/{hash}", s.auth(s.handleBlob))
	mux.HandleFunc("GET /api/stats", s.auth(s.handleStats))

	mux.HandleFunc("/", s.serveClient)

	return logging(compressing(mux))
}

// ---- middleware -----------------------------------------------------------

type ctxKey int

const userKey ctxKey = 1

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			fail(w, http.StatusUnauthorized, "not signed in")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		var sess models.Session
		if err := s.db.Sessions.FindOne(ctx, bson.M{"_id": c.Value}).Decode(&sess); err != nil {
			s.clearCookie(w)
			fail(w, http.StatusUnauthorized, "session expired")
			return
		}
		var u models.User
		if err := s.db.Users.FindOne(ctx, bson.M{"_id": sess.UserID}).Decode(&u); err != nil {
			fail(w, http.StatusUnauthorized, "no such user")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, &u)))
	}
}

func user(r *http.Request) *models.User { u, _ := r.Context().Value(userKey).(*models.User); return u }

type gzWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g gzWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

var gzPool = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed); return w }}

// compressing gzips text responses only. Media blobs are already compressed,
// and gzipping them would break Range support for no gain.
func compressing(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Blobs are already compressed and gzip would break Range; the event
		// stream must not be buffered by a compressor at all.
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			strings.HasPrefix(r.URL.Path, "/api/blob/") ||
			r.URL.Path == "/api/events" {
			next.ServeHTTP(w, r)
			return
		}
		gz := gzPool.Get().(*gzip.Writer)
		defer gzPool.Put(gz)
		gz.Reset(w)
		defer gz.Close()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		next.ServeHTTP(gzWriter{w, gz}, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (s *statusWriter) WriteHeader(c int) { s.code = c; s.ResponseWriter.WriteHeader(c) }
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{w, 200}
		next.ServeHTTP(sw, r)
		if (!strings.HasPrefix(r.URL.Path, "/api/blob/") && r.URL.Path != "/api/events") || sw.code >= 400 {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.code, time.Since(start).Round(time.Millisecond))
		}
	})
}

// ---- helpers --------------------------------------------------------------

func send(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	send(w, code, map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v)
}

func (s *Server) setCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", HttpOnly: true,
		Secure: s.cfg.TLS, SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds()),
	})
}

func (s *Server) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: s.cfg.TLS, SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
}

func objID(r *http.Request) (bson.ObjectID, error) { return bson.ObjectIDFromHex(r.PathValue("id")) }
