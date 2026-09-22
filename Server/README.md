# Memm — Server

Part of the [Memm](../README.md) repository.

Go + MongoDB backend for Memm, a journal that records **when** as carefully as
**what**. It stores audio, video, images, markdown and handwritten strokes,
each with a real start and end time, and serves the client on the same port.

## Requirements

| | |
|---|---|
| Go | 1.24+ |
| MongoDB | 6+ running locally (`mongodb://localhost:27017`) |
| ffmpeg / ffprobe | **required** — probing, thumbnails, waveforms and server-side editing |
| openssl | only to generate a local TLS certificate |

```sh
brew tap mongodb/brew
brew install mongodb-community ffmpeg
brew services start mongodb-community
```

## Run

```sh
git clone <this-repo> Memm
cd Memm/Server
cp .env.example .env                # then edit if needed
./scripts/gencert.sh                # self-signed cert for https
go run ./cmd/memm
```

Open <https://localhost:5050>. For plain http while testing, set `TLS=0`.

### Configuration (`.env`, or real environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ADDR` | `:5050` | listen address; client and API share this port |
| `MONGO_URI` | `mongodb://localhost:27017` | connection string |
| `MONGO_DB` | `memm` | database name |
| `CLIENT_DIR` | `../Client` | path to the client, a sibling directory in this repo |
| `TLS` | `1` | `0` serves plain http |
| `CERT_FILE` / `KEY_FILE` | `./certs/cert.pem`, `./certs/key.pem` | TLS material |
| `DATA_DIR` | `./data` | blob storage root |
| `MAX_CHUNK` | `16777216` | largest accepted upload chunk |
| `DEV` | `0` | `1` rebuilds the client bundle on every request |

## How it stores things

**Metadata in MongoDB, bytes on disk.** Each entry document points at a blob by
its SHA-256; the bytes live at `data/blobs/ab/cd/abcd…`. Content addressing
means two identical uploads share one file, and serving is a plain `os.Open`
so `http.ServeContent` answers Range requests (video seeking) with no copying
through application memory. A blob is deleted only when the last entry
referencing it goes away.

Markdown and stroke notes are the exception: they are small and rewritten on
every autosave, so they live inline in the document rather than orphaning a
blob per keystroke batch.

**Streaming capture.** A recording opens an entry in `recording` status, then
`PUT /chunk` appends slices as they arrive. The request body is streamed
straight to a staging file — never buffered whole — and the server is the
source of truth for the byte offset, so a dropped connection resumes exactly
rather than duplicating audio. `POST /finish` hashes the staging file into the
blob store, probes it with ffprobe, derives a thumbnail (video/image) or a
400-point waveform (audio), and marks it ready.

**Time.** Every instant is stored as UTC. Each entry also records `tzOffset`,
the wall-clock zone it was captured in (minutes east of UTC, so `420` is
UTC+7). The client can therefore show a trip abroad either on your clock or on
the clock it actually felt like at the time.

## API

An account is a **username and a password**, nothing else. Usernames are 3–32
characters of letters, digits, dots, dashes or underscores, stored folded to
lower case so capitalisation cannot split an account in two.

All routes except signup/login require the `memm_session` cookie
(httpOnly, `Secure` under TLS, argon2id-hashed passwords, opaque tokens with a
MongoDB TTL index so logout and expiry are immediate). A failed login returns
the same message and takes comparable time whether or not the username exists.

A database created before accounts dropped the email field is migrated on
startup: the old unique index is dropped, `email` is renamed to `username`,
and the stale display name is removed, so existing logins keep working.

```
POST   /api/auth/signup            {username,password,tzOffset}
POST   /api/auth/login             {username,password,tzOffset}
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/entries                ?from&to&kind&q&before&limit&full
POST   /api/entries                open an entry
GET    /api/entries/{id}
PATCH  /api/entries/{id}           {title,tags,startsAt,endsAt}
DELETE /api/entries/{id}

GET    /api/entries/{id}/offset    resume point for an interrupted upload
PUT    /api/entries/{id}/chunk     append bytes (X-Offset header)
POST   /api/entries/{id}/finish    commit, probe, thumbnail/waveform
PUT    /api/entries/{id}/text      markdown / stroke autosave
POST   /api/entries/{id}/edit      server-side trim / crop / compress

GET    /api/events                 SSE feed of this account's entry changes
GET    /api/blob/{sha256}          Range-capable, immutable, owner-only
GET    /api/stats
```

`GET /api/entries` also accepts `minMs`/`maxMs` (duration bounds), `tag`
(comma-separated, matching any) and `status`.

### Live updates across devices

One account can record from several devices at once, so `GET /api/events` is a
per-user Server-Sent Events feed of created, changed and deleted entries.
Another device sees a recording appear and its block grow without polling.

Uploads deliberately stay on ordinary HTTP rather than moving to a WebSocket:
chunked `PUT`s get independent retry, HTTP/2 multiplexing, native Range
semantics and resumability for free, where one socket would serialise
transfers and force us to reimplement framing, backpressure and resume. Only
the notifications need pushing, and SSE reconnects on its own.

`GET /api/entries?from&to` returns entries **overlapping** the window rather
than contained in it, so a long recording stays visible when you zoom inside
it. Passing `full=1` includes markdown bodies; the timeline omits them.

## Layout

```
cmd/memm/main.go        startup, TLS, graceful shutdown
internal/config         .env + environment
internal/db             Mongo connection and indexes
internal/auth           argon2id hashing, session tokens
internal/models         Entry, User, Session
internal/store          content-addressed blob store
internal/media          ffmpeg/ffprobe: probe, thumbnail, peaks, transform
internal/api            HTTP handlers, middleware, client bundler
```

The client is served from the same port: `internal/api/client.go` inlines the
client's split CSS/JS into one HTML document and caches it in RAM, so the
browser makes a single request with no waterfall. Set `DEV=1` to rebuild it on
each request while editing.
