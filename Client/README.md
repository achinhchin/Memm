# Memm — Client

Part of the [Memm](../README.md) repository.

Dark, minimal front end for Memm. Plain HTML, CSS and JavaScript — no build
step, no framework, no runtime dependencies. The files are split for editing;
the server inlines them into a single cached HTML document before sending, so
the browser makes one request.

## Run

The client is not served on its own — the Go server inlines and serves it:

```sh
git clone <this-repo> Memm
cd Memm/Server && go run ./cmd/memm
```

The server finds these files through `CLIENT_DIR`, which defaults to
`../Client` and so resolves correctly from `Server/` in this repository.

Then open <https://localhost:5050>. While editing, run the server with `DEV=1`
so the bundle is rebuilt on every request instead of cached.

## Layout

```
index.html            shell; lists the stylesheets and scripts to inline
styles/base.css       design tokens, reset, typography
styles/layout.css     app shell, nav, capture dock, responsive rules
styles/components.css buttons, inputs, modals, toasts, glass surfaces
styles/timeline.css   timeline lanes and list cards

scripts/icons.js      inline SVG icon set
scripts/ui.js         DOM helpers, time formatting, modals, markdown
scripts/api.js        fetch wrapper + chunked upload
scripts/store.js      state, entry cache, windowed loading
scripts/auth.js       sign in / sign up
scripts/timeline.js   zoomable time axis with stacked lanes
scripts/list.js       entries grouped by day
scripts/capture.js    recording, image import, markdown, stroke pad
scripts/viewer.js     playback, metadata, trim / crop / compress
scripts/app.js        shell, filters, view switching, bootstrap
```

Scripts are classic (non-module) and load in the order `index.html` lists
them, each attaching to the single global `M`. That is what lets the server
concatenate them into one inline `<script>` without a bundler.

## The two views

**Timeline** is the point of the app. A single horizontal time axis, one lane
per kind, and each entry drawn as a block whose width is its real duration.
Entries that overlap in time stack into sub-rows within their lane, the way
clips stack on tracks in an editor — packing is computed from time rather than
pixels, so rows do not reshuffle while you zoom. The range runs from about two
seconds to ten years across the screen.

- scroll — zoom around the pointer
- ctrl/⌘ + scroll or pinch — zoom
- drag — pan time horizontally and the lane stack vertically
- shift + scroll — scroll lanes
- `+` / `-` zoom, `F` fit everything, arrows nudge

**List** groups entries by local day with thumbnails, waveforms and note
snippets, and pages backwards as you scroll.

Both views respect the kind filters and the search box. The clock chip in the
filter strip switches between your own time zone and the zone each entry was
captured in.

## Capture

The dock at the bottom opens each kind. Audio and video record through
`MediaRecorder` and stream to the server in two-second slices while recording,
so nothing is lost if the tab closes mid-take. Images are downscaled and
re-encoded in the browser before upload, with the server re-encoding only when
the canvas path is unavailable. Markdown and drawings autosave as you work.

Strokes are stored in normalised 0–1 coordinates, so a note drawn on a phone
replays correctly on a desktop canvas.

## UI notes

Colours are desaturated slate with one restrained accent; surfaces use
backdrop blur over a soft ambient wash. Icons are inline SVG, never emoji.
Type is the system font stack, so nothing is fetched at runtime. The layout
works from small phones up, honours safe-area insets, and respects
`prefers-reduced-motion`.
