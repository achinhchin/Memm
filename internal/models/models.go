package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Entry kinds. New kinds only need a constant here plus a client renderer.
const (
	KindAudio    = "audio"
	KindVideo    = "video"
	KindImage    = "image"
	KindMarkdown = "markdown"
	KindStroke   = "stroke"
)

// Entry lifecycle.
const (
	StatusRecording = "recording" // open for chunk appends / text autosave
	StatusReady     = "ready"
	StatusFailed    = "failed"
)

type User struct {
	ID        bson.ObjectID `bson:"_id,omitempty"       json:"id"`
	Email     string        `bson:"email"               json:"email"`
	Name      string        `bson:"name"                json:"name"`
	Hash      string        `bson:"hash"                json:"-"`
	TZOffset  int           `bson:"tzOffset"            json:"tzOffset"` // minutes east of UTC
	CreatedAt time.Time     `bson:"createdAt"           json:"createdAt"`
}

type Session struct {
	Token     string        `bson:"_id"`
	UserID    bson.ObjectID `bson:"userId"`
	CreatedAt time.Time     `bson:"createdAt"`
	ExpiresAt time.Time     `bson:"expiresAt"`
}

// Entry is one journal item. Binary media lives in the blob store (Blob is its
// sha256); markdown and stroke data are small and mutate on every autosave, so
// they are kept inline in Text to avoid rewriting blobs constantly.
type Entry struct {
	ID       bson.ObjectID `bson:"_id,omitempty"  json:"id"`
	UserID   bson.ObjectID `bson:"userId"         json:"-"`
	Kind     string        `bson:"kind"           json:"kind"`
	Title    string        `bson:"title"          json:"title"`
	Status   string        `bson:"status"         json:"status"`

	Blob string `bson:"blob,omitempty"  json:"blob,omitempty"` // sha256 hex
	Mime string `bson:"mime,omitempty"  json:"mime,omitempty"`
	Size int64  `bson:"size"            json:"size"`
	Text string `bson:"text,omitempty"  json:"text,omitempty"` // markdown / stroke JSON

	// Times are always stored as UTC instants. TZOffset records the wall-clock
	// zone the entry was captured in (minutes east of UTC, e.g. 420 = UTC+7)
	// so the timeline can render local time for cross-country journalling.
	StartsAt   time.Time `bson:"startsAt"          json:"startsAt"`
	EndsAt     time.Time `bson:"endsAt"            json:"endsAt"`
	TZOffset   int       `bson:"tzOffset"          json:"tzOffset"`
	DurationMS int64     `bson:"durationMs"        json:"durationMs"`

	Thumb string         `bson:"thumb,omitempty"  json:"thumb,omitempty"` // sha256 of jpeg
	Peaks []float32      `bson:"peaks,omitempty"  json:"peaks,omitempty"` // audio waveform
	Meta  map[string]any `bson:"meta,omitempty"   json:"meta,omitempty"`
	Tags  []string       `bson:"tags,omitempty"   json:"tags,omitempty"`

	CreatedAt time.Time `bson:"createdAt" json:"createdAt"`
	UpdatedAt time.Time `bson:"updatedAt" json:"updatedAt"`
}
