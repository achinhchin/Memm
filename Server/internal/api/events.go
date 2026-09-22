package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"memm/internal/models"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// hub is an in-process fan-out of entry changes, keyed by user. One account
// recording from several devices needs every other device to notice, and this
// is the smallest thing that does that without a message broker.
//
// Uploads deliberately stay on plain HTTP: they are bulk, resumable byte
// ranges that benefit from independent requests, HTTP/2 multiplexing and
// native Range semantics. Only the change notifications need a push channel,
// and one-way Server-Sent Events cover that with automatic client reconnects.
type hub struct {
	mu   sync.RWMutex
	subs map[bson.ObjectID]map[chan []byte]struct{}
}

func newHub() *hub { return &hub{subs: map[bson.ObjectID]map[chan []byte]struct{}{}} }

func (h *hub) sub(uid bson.ObjectID) chan []byte {
	ch := make(chan []byte, 32)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[uid] == nil {
		h.subs[uid] = map[chan []byte]struct{}{}
	}
	h.subs[uid][ch] = struct{}{}
	return ch
}

func (h *hub) unsub(uid bson.ObjectID, ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m := h.subs[uid]; m != nil {
		delete(m, ch)
		if len(m) == 0 {
			delete(h.subs, uid)
		}
	}
	close(ch)
}

// publish never blocks: a subscriber that has fallen behind drops the event
// rather than stalling an upload. The client re-reads its window on the next
// pan or poll, so a missed frame is a cosmetic delay, not lost data.
func (h *hub) publish(uid bson.ObjectID, payload []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs[uid] {
		select {
		case ch <- payload:
		default:
		}
	}
}

// emitEntry announces a created or changed entry. The text body is stripped:
// markdown autosaves fire often and every other device only needs to know
// that the entry moved, not to receive the whole note.
func (s *Server) emitEntry(uid bson.ObjectID, e *models.Entry) {
	if e == nil {
		return
	}
	light := *e
	light.Text = ""
	s.emit(uid, "entry", light)
}

func (s *Server) emitDelete(uid bson.ObjectID, id bson.ObjectID) {
	s.emit(uid, "delete", map[string]string{"id": id.Hex()})
}

func (s *Server) emit(uid bson.ObjectID, kind string, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.events.publish(uid, []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", kind, body)))
}

// handleEvents is the SSE stream. It is excluded from response compression,
// because a gzip writer buffers and would hold events back indefinitely.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	u := user(r)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no") // defeat proxy buffering
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "retry: 3000\n\n")
	flusher.Flush()

	ch := s.events.sub(u.ID)
	defer s.events.unsub(u.ID, ch)

	// A comment line every 25s keeps intermediaries from reaping an idle
	// stream, and surfaces a dead connection to the client promptly.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case msg, open := <-ch:
			if !open {
				return
			}
			w.Write(msg)
			flusher.Flush()
		}
	}
}
