# PROJECT.md — orientation for an AI working on Memm

Read this first. It is the map; the code is the territory. Between them you
should not need to grep the whole tree to make a change.

## What Memm is

A personal journal where **time is the primary key**. Entries are audio,
video, images, markdown notes and handwritten strokes, each with a real start
*and end* instant. They are read back on a zoomable timeline (lanes, blocks
sized by duration) or as a day-grouped list. One account, many devices,
recording at the same time.

## Shape

```
Server/          Go 1.24, MongoDB, ffmpeg. Serves API *and* client on :5050.
  cmd/memm/main.go        startup, TLS, graceful shutdown
  internal/config         .env + environment
  internal/db             Mongo connection, indexes, schema migrations
  internal/auth           argon2id hashing, opaque session tokens
  internal/models         Entry, User, Session  <- read this first
  internal/store          content-addressed blob store on disk
  internal/media          ffmpeg/ffprobe: probe, thumbnail, peaks, transform
  internal/api            handlers, middleware, SSE hub, client bundler
Client/          Plain HTML/CSS/JS. No build step, no framework, no deps.
  index.html              lists the files to inline, in load order
  styles/*.css            tokens / layout / components / timeline
  scripts/*.js            one global `M`, classic scripts, order matters
```

## Non-obvious rules

These are the things that will bite you.

1. **Client scripts are classic, not modules.** They load in the order
   `index.html` lists them and each hangs off the single global `M`. The
   server concatenates them into one inline `<script>`; an `import` would
   break that. Add a new file to `index.html` *after* its dependencies.

2. **`M.ui.el(tag, attrs, html)` treats booleans specially.** `true` on an
   `aria-*`/`data-*` attribute writes the string `"true"`; on anything else it
   writes a bare attribute (`disabled`). `false` on `aria-*`/`data-*` writes
   `"false"`; elsewhere the attribute is dropped. CSS selects on
   `[aria-pressed="true"]`, so getting this wrong silently breaks every
   toggle's appearance.

3. **Times.** Every instant on the wire and in Mongo is UTC. `tzOffset` on an
   entry is minutes east of UTC at capture (`420` = UTC+7). The client renders
   either the viewer's zone or the entry's own, toggled by the clock chip. Use
   `M.ui.shifted/offsetFor`, never `toLocaleString`.

4. **Timeline queries return entries that *overlap* the window**, not ones
   contained in it, so a long recording stays visible when you zoom inside it.
   `?full=1` is the only way to get markdown bodies; the timeline omits them.

5. **Bytes live on disk, metadata in Mongo.** `Entry.Blob` is a SHA-256;
   the file is `data/blobs/ab/cd/<hash>`. Identical uploads share one file, so
   **never delete a blob without checking for other referrers** — use
   `releaseBlob`. Markdown and stroke bodies are the exception: they live
   inline in `Entry.Text` because autosave would orphan a blob per keystroke.

6. **Uploads are chunked HTTP, and the server owns the offset.** `PUT
   /chunk` with an `X-Offset` header; a mismatch returns `409` plus the true
   offset in the response header so the client re-slices. Do not "simplify"
   this into a single POST — it is what makes a dropped connection resumable.

7. **SSE, not WebSocket.** `GET /api/events` is a per-user fan-out
   (`internal/api/events.go`) for change notifications only. It is excluded
   from the gzip middleware — a compressor buffers and would hold events
   forever. Uploads stay on plain HTTP on purpose; see "Why not WebSocket".

8. **Video must carry its own audio.** The MediaRecorder mime string has to
   name an audio codec (`video/mp4;codecs=avc1.42E01E,mp4a.40.2`), not just
   the video one. `isTypeSupported` happily accepts a video-only string and
   then records silence. Camera and microphone belong in **one** file; never
   create a separate audio entry alongside a video.

9. **ffmpeg is required**, not optional. The server refuses to start without
   it. Adding a code path that assumes it is missing is wrong.

10. **Strokes are normalised 0–1 coordinates** so a phone drawing replays on a
    desktop canvas. An eraser stroke is a normal stroke with `e:1`, replayed
    with `globalCompositeOperation='destination-out'`. Both the pad
    (`capture.js`) and the viewer (`viewer.js`) must stay in step.

## Data model

```go
Entry{ ID, UserID, Kind, Title, Status,
       Blob, Mime, Size, Text,           // Text only for markdown/stroke
       StartsAt, EndsAt, TZOffset, DurationMS,
       Thumb, Peaks, Meta, Tags, CreatedAt, UpdatedAt }
```
`Kind`: `audio|video|image|markdown|stroke`. `Status`:
`recording|ready|failed`. Adding a kind means a constant in `models`, a
client renderer, and an entry in `KINDS` in `store.js` — nothing else.

## API

```
POST   /api/auth/signup|login   {username,password,tzOffset}   POST /logout, GET /me
GET    /api/entries             ?from&to&kind&q&before&limit&full&minMs&maxMs&tag&status
POST   /api/entries             open an entry
GET|PATCH|DELETE /api/entries/{id}
GET    /api/entries/{id}/offset resume point
PUT    /api/entries/{id}/chunk  append bytes (X-Offset)
POST   /api/entries/{id}/finish commit, probe, thumbnail/waveform
PUT    /api/entries/{id}/text   markdown/stroke autosave
POST   /api/entries/{id}/edit   server-side trim/crop/compress
GET    /api/events              SSE change feed
GET    /api/blob/{sha256}       Range-capable, immutable, owner-only
GET    /api/stats
```
Auth is a `memm_session` httpOnly cookie. Accounts are **username +
password only** — no email, no display name. Usernames are lower-cased,
3–32 chars of `[a-z0-9._-]`.

## Why not WebSocket

Asked and decided. Bulk media upload stays on HTTP because chunked `PUT`s get
independent retry, HTTP/2 multiplexing, native Range semantics and resumability
for free; a single socket would serialise transfers behind one another and
force us to reimplement framing, backpressure and resume. Only *notifications*
need pushing, and one-way SSE does that with automatic client reconnect and no
extra protocol. Revisit only if bidirectional low-latency control is needed.

## Running and testing

```sh
cd Server && cp .env.example .env && ./scripts/gencert.sh && go run ./cmd/memm
```
`TLS=0` for plain http. `DEV=1` rebuilds the client bundle per request.
`CLIENT_DIR` defaults to `../Client`.

There is no test framework. The client is verified by booting it in Node
against a hand-written DOM shim, and the server by driving the real HTTP API
with curl against a live MongoDB. When you change behaviour, exercise it
that way rather than trusting a read-through — several real bugs in this
codebase (a compound index passed as a map, a `.gitignore` pattern that
excluded `cmd/memm/`, a migration ordered so it collided on `email: null`)
were only caught by actually running it.

## Conventions

Go: standard library only where practical; the sole dependencies are the
Mongo driver and `x/crypto`. Handlers validate, then delegate. Comments
explain *why*, never *what*.

JS/CSS: compact but not golfed. Colours and spacing come from the tokens in
`base.css` — no hard-coded hex in components. Dark theme, desaturated slate,
one accent. Icons are inline SVG from `icons.js`; **never emoji**. Every
surface must work from a small phone up, with safe-area insets honoured.
