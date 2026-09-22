# Memm

A journal that records **when** as carefully as **what**.

Memm stores audio, video, images, markdown notes and handwritten strokes, each
with a real start and end instant rather than a single timestamp. You read it
back either as a **timeline** — one zoomable time axis, a lane per kind, every
entry drawn at its true duration — or as a **list** grouped by day.

```
Memm/
├── Server/     Go + MongoDB API, also serves the client on the same port
└── Client/     HTML / CSS / JS front end, no build step
```

Both halves live in this one repository because they ship together on one
port; a single clone is everything you need.

## Quick start

```sh
# 1. dependencies
brew tap mongodb/brew
brew install mongodb-community ffmpeg
brew services start mongodb-community

# 2. run
git clone <this-repo> Memm
cd Memm/Server
cp .env.example .env
./scripts/gencert.sh          # self-signed cert for local https
go run ./cmd/memm
```

Open <https://localhost:5050> and create an account — just a username and a
password. Your browser will warn
about the self-signed certificate; accept it. To skip TLS while testing, set
`TLS=0` in `.env` and use <http://localhost:5050>.

Requirements: Go 1.24+, MongoDB 6+, and **ffmpeg/ffprobe**, which the server
requires at startup for probing, thumbnails, waveforms and server-side
editing.

## What it does

**Time is the organising principle.** Every instant is stored as UTC, and each
entry additionally records the wall-clock zone it was captured in. A trip
abroad can therefore be read on your own clock or on the clock it actually
felt like at the time — one chip in the filter strip switches between them.

**Captures stream while they happen.** Audio and video record in the browser
and upload in two-second slices against a byte offset the server tracks, so a
dropped connection resumes exactly instead of losing the take. Markdown notes
and drawings autosave as you work.

**Files are trimmed, cropped and compressed on either side.** Images are
downscaled in the browser before they are sent. Anything the browser cannot
handle — and any later edit — is done server-side with ffmpeg, which replaces
the entry's file and adjusts its time window to match the trim.

**Storage is content-addressed.** Media bytes live on disk under their
SHA-256, so two identical uploads share one file, and a blob is deleted only
when the last entry referencing it goes away. Metadata stays in MongoDB.
Serving is a plain file read, so video seeking works through HTTP Range
requests without copying through application memory.

## Documentation

- [`Server/README.md`](Server/README.md) — configuration, API reference,
  storage model, package layout
- [`Client/README.md`](Client/README.md) — file layout, the two views,
  capture, keyboard and pointer shortcuts

## History

The server and client were built as separate repositories and merged here
with their commit histories intact, so `git log --follow` still works through
the move into `Server/` and `Client/`.
