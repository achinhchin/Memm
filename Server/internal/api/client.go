package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// bundler inlines the client's split CSS/JS sources into a single HTML
// document and keeps it in RAM. The client stays many small files on disk for
// editing, but ships as one request with no waterfall.
type bundler struct {
	dir string
	dev bool

	mu   sync.RWMutex
	html []byte
	etag string
	at   time.Time
}

var (
	linkRe   = regexp.MustCompile(`(?i)<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>`)
	scriptRe = regexp.MustCompile(`(?i)<script[^>]+src=["']([^"']+)["'][^>]*>\s*</script>`)
)

func newBundler(dir string, dev bool) *bundler { return &bundler{dir: dir, dev: dev} }

func (b *bundler) get() ([]byte, string, error) {
	if !b.dev {
		b.mu.RLock()
		html, etag := b.html, b.etag
		b.mu.RUnlock()
		if html != nil {
			return html, etag, nil
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.dev && b.html != nil {
		return b.html, b.etag, nil
	}
	html, err := b.build()
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(html)
	b.html, b.etag, b.at = html, `"`+hex.EncodeToString(sum[:8])+`"`, time.Now()
	return b.html, b.etag, nil
}

func (b *bundler) build() ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(b.dir, "index.html"))
	if err != nil {
		return nil, err
	}
	out := linkRe.ReplaceAllFunc(raw, func(m []byte) []byte {
		return b.inline(linkRe.FindSubmatch(m)[1], "<style>", "</style>", m)
	})
	out = scriptRe.ReplaceAllFunc(out, func(m []byte) []byte {
		return b.inline(scriptRe.FindSubmatch(m)[1], "<script>", "</script>", m)
	})
	return out, nil
}

// inline swaps a tag for its file contents; remote URLs are left alone.
func (b *bundler) inline(src []byte, open, close string, orig []byte) []byte {
	p := string(src)
	if strings.HasPrefix(p, "http") || strings.HasPrefix(p, "//") {
		return orig
	}
	body, err := os.ReadFile(filepath.Join(b.dir, filepath.Clean("/"+p)))
	if err != nil {
		return orig
	}
	// A literal </script> inside JS would close the tag early.
	if open == "<script>" {
		body = bytes.ReplaceAll(body, []byte("</script"), []byte(`<\/script`))
	}
	var buf bytes.Buffer
	buf.WriteString(open)
	buf.Write(body)
	buf.WriteString(close)
	return buf.Bytes()
}

// serveClient serves real files from the client directory when they exist
// (icons, manifest, anything fetched at runtime) and otherwise returns the
// inlined single-file app, so deep links work.
func (s *Server) serveClient(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		fail(w, http.StatusNotFound, "no such endpoint")
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	if clean != "/" && clean != "/index.html" {
		p := filepath.Join(s.cfg.ClientDir, clean)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			w.Header().Set("Cache-Control", "public, max-age=3600")
			http.ServeFile(w, r, p)
			return
		}
	}

	html, etag, err := s.bundle.get()
	if err != nil {
		http.Error(w, "client bundle unavailable: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(html)
}
