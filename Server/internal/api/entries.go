package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"memm/internal/models"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// handleList powers both views. The timeline asks for everything overlapping a
// window; the list view pages backwards from a cursor.
//
//	?from,to      RFC3339 window (overlap, not containment)
//	?kind         comma-separated kinds
//	?before       pagination cursor (RFC3339 startsAt)
//	?limit        default 200, max 1000
//	?q            title/tag/text substring
//	?minMs,maxMs  duration bounds in milliseconds
//	?tag          comma-separated tags, matching any of them
//	?status       recording | ready | failed
func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	filter := bson.M{"userId": user(r).ID}

	from, hasFrom := parseTime(q.Get("from"))
	to, hasTo := parseTime(q.Get("to"))
	switch {
	case hasFrom && hasTo:
		// Overlap: an entry that starts before the window ends and ends after
		// it begins. Lets a long recording show up in a zoomed-in view.
		filter["startsAt"] = bson.M{"$lt": to}
		filter["endsAt"] = bson.M{"$gt": from}
	case hasFrom:
		filter["endsAt"] = bson.M{"$gt": from}
	case hasTo:
		filter["startsAt"] = bson.M{"$lt": to}
	}

	if k := q.Get("kind"); k != "" {
		kinds := strings.Split(k, ",")
		filter["kind"] = bson.M{"$in": kinds}
	}
	if before, ok := parseTime(q.Get("before")); ok {
		filter["startsAt"] = mergeLT(filter["startsAt"], before)
	}
	if dur := durationRange(q.Get("minMs"), q.Get("maxMs")); dur != nil {
		filter["durationMs"] = dur
	}
	if t := q.Get("tag"); t != "" {
		tags := []string{}
		for _, v := range strings.Split(t, ",") {
			if v = strings.TrimSpace(v); v != "" {
				tags = append(tags, v)
			}
		}
		if len(tags) > 0 {
			filter["tags"] = bson.M{"$in": tags}
		}
	}
	switch st := q.Get("status"); st {
	case models.StatusRecording, models.StatusReady, models.StatusFailed:
		filter["status"] = st
	}
	if term := strings.TrimSpace(q.Get("q")); term != "" {
		rx := bson.M{"$regex": regexQuote(term), "$options": "i"}
		filter["$or"] = []bson.M{{"title": rx}, {"tags": rx}, {"text": rx}}
	}

	limit := int64(200)
	if n, err := strconv.ParseInt(q.Get("limit"), 10, 64); err == nil && n > 0 && n <= 1000 {
		limit = n
	}

	opts := options.Find().SetSort(bson.D{{Key: "startsAt", Value: -1}}).SetLimit(limit)
	// The timeline never needs the full markdown body, only the block; drop it
	// from the wire so a window with long notes stays small.
	if q.Get("full") != "1" {
		opts.SetProjection(bson.M{"text": 0})
	}

	cur, err := s.db.Entries.Find(r.Context(), filter, opts)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not read entries")
		return
	}
	entries := []models.Entry{}
	if err := cur.All(r.Context(), &entries); err != nil {
		fail(w, http.StatusInternalServerError, "could not decode entries")
		return
	}
	var next string
	if int64(len(entries)) == limit && len(entries) > 0 {
		next = entries[len(entries)-1].StartsAt.Format(time.RFC3339Nano)
	}
	send(w, http.StatusOK, map[string]any{"entries": entries, "next": next})
}

type createReq struct {
	Kind     string    `json:"kind"`
	Title    string    `json:"title"`
	Mime     string    `json:"mime"`
	StartsAt time.Time `json:"startsAt"`
	EndsAt   time.Time `json:"endsAt"`
	TZOffset int       `json:"tzOffset"`
	Text     string    `json:"text"`
	Tags     []string  `json:"tags"`
}

// handleCreate opens an entry. Media entries come back in "recording" status
// and are filled by chunk uploads; markdown and stroke entries are usable
// immediately and autosave through /text.
func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var c createReq
	if err := decode(r, &c); err != nil {
		fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	if !validKind(c.Kind) {
		fail(w, http.StatusBadRequest, "unknown entry kind")
		return
	}
	now := time.Now().UTC()
	if c.StartsAt.IsZero() {
		c.StartsAt = now
	}
	if c.EndsAt.IsZero() {
		c.EndsAt = c.StartsAt
	}
	e := models.Entry{
		UserID: user(r).ID, Kind: c.Kind, Title: strings.TrimSpace(c.Title),
		Mime: c.Mime, Text: c.Text, Tags: c.Tags,
		StartsAt: c.StartsAt.UTC(), EndsAt: c.EndsAt.UTC(), TZOffset: c.TZOffset,
		DurationMS: c.EndsAt.Sub(c.StartsAt).Milliseconds(),
		Status:     models.StatusRecording,
		CreatedAt:  now, UpdatedAt: now,
	}
	if c.Kind == models.KindMarkdown || c.Kind == models.KindStroke {
		e.Status = models.StatusReady
		e.Size = int64(len(c.Text))
	}
	res, err := s.db.Entries.InsertOne(r.Context(), e)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not create entry")
		return
	}
	e.ID = res.InsertedID.(bson.ObjectID)
	s.emitEntry(e.UserID, &e)
	send(w, http.StatusCreated, e)
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	send(w, http.StatusOK, e)
}

type patchReq struct {
	Title    *string    `json:"title"`
	Tags     *[]string  `json:"tags"`
	StartsAt *time.Time `json:"startsAt"`
	EndsAt   *time.Time `json:"endsAt"`
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	var p patchReq
	if err := decode(r, &p); err != nil {
		fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	set := bson.M{"updatedAt": time.Now().UTC()}
	if p.Title != nil {
		set["title"] = strings.TrimSpace(*p.Title)
	}
	if p.Tags != nil {
		set["tags"] = *p.Tags
	}
	start, end := e.StartsAt, e.EndsAt
	if p.StartsAt != nil {
		start = p.StartsAt.UTC()
		set["startsAt"] = start
	}
	if p.EndsAt != nil {
		end = p.EndsAt.UTC()
		set["endsAt"] = end
	}
	if p.StartsAt != nil || p.EndsAt != nil {
		if end.Before(start) {
			fail(w, http.StatusBadRequest, "end time is before start time")
			return
		}
		set["durationMs"] = end.Sub(start).Milliseconds()
	}
	if _, err := s.db.Entries.UpdateByID(r.Context(), e.ID, bson.M{"$set": set}); err != nil {
		fail(w, http.StatusInternalServerError, "could not update entry")
		return
	}
	e, _ = s.load(r, e.ID)
	s.emitEntry(user(r).ID, e)
	send(w, http.StatusOK, e)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	e, ok := s.own(w, r)
	if !ok {
		return
	}
	if _, err := s.db.Entries.DeleteOne(r.Context(), bson.M{"_id": e.ID}); err != nil {
		fail(w, http.StatusInternalServerError, "could not delete entry")
		return
	}
	s.blobs.Discard(e.ID.Hex())
	s.releaseBlob(r, e.Blob)
	s.releaseBlob(r, e.Thumb)
	s.emitDelete(user(r).ID, e.ID)
	send(w, http.StatusOK, map[string]bool{"ok": true})
}

// releaseBlob drops a blob once no entry references it. Content addressing
// means two entries can legitimately share one file.
func (s *Server) releaseBlob(r *http.Request, hash string) {
	if hash == "" {
		return
	}
	n, err := s.db.Entries.CountDocuments(r.Context(),
		bson.M{"$or": []bson.M{{"blob": hash}, {"thumb": hash}}}, options.Count().SetLimit(1))
	if err == nil && n == 0 {
		s.blobs.Remove(hash)
	}
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	cur, err := s.db.Entries.Aggregate(r.Context(), []bson.M{
		{"$match": bson.M{"userId": user(r).ID}},
		{"$group": bson.M{"_id": "$kind", "count": bson.M{"$sum": 1}, "bytes": bson.M{"$sum": "$size"},
			"first": bson.M{"$min": "$startsAt"}, "last": bson.M{"$max": "$endsAt"}}},
	})
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not compute stats")
		return
	}
	rows := []bson.M{}
	cur.All(r.Context(), &rows)
	send(w, http.StatusOK, map[string]any{"kinds": rows})
}

// ---- helpers --------------------------------------------------------------

func (s *Server) load(r *http.Request, id bson.ObjectID) (*models.Entry, error) {
	var e models.Entry
	err := s.db.Entries.FindOne(r.Context(), bson.M{"_id": id, "userId": user(r).ID}).Decode(&e)
	return &e, err
}

// own loads the entry and enforces that it belongs to the caller.
func (s *Server) own(w http.ResponseWriter, r *http.Request) (*models.Entry, bool) {
	id, err := objID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad entry id")
		return nil, false
	}
	e, err := s.load(r, id)
	if err != nil {
		fail(w, http.StatusNotFound, "entry not found")
		return nil, false
	}
	return e, true
}

func validKind(k string) bool {
	switch k {
	case models.KindAudio, models.KindVideo, models.KindImage, models.KindMarkdown, models.KindStroke:
		return true
	}
	return false
}

// durationRange builds a durationMs constraint from the two bounds, returning
// nil when neither is usable so the field is left unfiltered.
func durationRange(minV, maxV string) bson.M {
	m := bson.M{}
	if n, err := strconv.ParseInt(minV, 10, 64); err == nil && n > 0 {
		m["$gte"] = n
	}
	if n, err := strconv.ParseInt(maxV, 10, 64); err == nil && n > 0 {
		m["$lte"] = n
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

func parseTime(v string) (time.Time, bool) {
	if v == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

func mergeLT(existing any, t time.Time) bson.M {
	m, ok := existing.(bson.M)
	if !ok {
		m = bson.M{}
	}
	if cur, ok := m["$lt"].(time.Time); !ok || t.Before(cur) {
		m["$lt"] = t
	}
	return m
}

var regexSpecial = strings.NewReplacer(
	`\`, `\\`, `.`, `\.`, `*`, `\*`, `+`, `\+`, `?`, `\?`, `(`, `\(`, `)`, `\)`,
	`[`, `\[`, `]`, `\]`, `{`, `\{`, `}`, `\}`, `^`, `\^`, `$`, `\$`, `|`, `\|`)

func regexQuote(s string) string { return regexSpecial.Replace(s) }
