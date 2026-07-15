# Design 03 — Give `window-state.json` the atomic-write guarantee

## Context
Every JSON file the app persists goes through `src/app/store/io.js`, which writes via a
temp-file-then-rename (`atomicWrite`/`writeJSON`) so a crash mid-write can't corrupt the
file. The one exception is window state: `saveWindowState` (`main.js:2275-2279`) and
`loadWindowState` (`main.js:2236`) use raw `fs.writeFileSync` / `fs.readFileSync` +
`JSON.parse`. A crash mid-write can therefore corrupt `window-state.json`, unlike every
other JSON file in the app.

The file is deliberately kept separate from the manifest (see the comment at
`main.js:2183-2187`); that separation should stay — only the write/read mechanism should
change.

## Goal
Window-state persistence uses the same atomic write and tolerant read as the rest of the
storage layer.

## Implementation steps
1. Route `saveWindowState` through `io.writeJSON` (atomic temp-then-rename) instead of raw
   `fs.writeFileSync`.
2. Route `loadWindowState` through `io.readJSON` (with a sensible default) instead of raw
   `fs.readFileSync` + `JSON.parse`, matching how stores read with a fallback so a
   missing/corrupt file degrades gracefully to defaults.
3. Keep the file location and "separate from the manifest" design exactly as-is; only the
   I/O path changes.

## Acceptance criteria
- `window-state.json` is written atomically (a temp file appears then is renamed; no
  partial writes).
- A corrupt or missing `window-state.json` loads cleanly to defaults rather than throwing.
- Window position/size still persist and restore across restarts.

## Constraints
- Reuse `io.js`; do not introduce a second JSON read/write helper.
- All filesystem I/O stays in the main process.

## Verify
`make fmt && make lint && make test`
