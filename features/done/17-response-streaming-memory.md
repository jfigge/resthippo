# Feature 17 — Response streaming & history memory

## Context
Two memory concerns surfaced in review:
- Responses are held **fully in memory** in the renderer, so a large payload can
  bloat memory and stall the UI.
- `listHistory` loads **all** history metadata into memory at once
  (`src/app/store/` history module), which grows unbounded.
HTTP execution is in the main process (`src/app/main.js`).

## Goal
Avoid loading very large responses entirely into renderer memory, and paginate /
bound history loading.

## Implementation steps
1. **Large responses**: in `main.js`, when a response exceeds a size threshold,
   stream it to a temp file under `userData` instead of buffering, and hand the
   renderer a reference + preview (first N KB). The response viewer renders the
   preview and offers "view full / save to file" for the rest.
2. **History pagination**: change the history store to support paged/bounded reads
   (e.g. most-recent N + cursor) instead of loading all metadata. Update the
   history UI to page or virtualize the list.
3. **Cleanup**: ensure streamed response temp files are GC'd (tie into Feature 03's
   temp-file cleanup) and history retention respects the existing history-count
   setting (`setting-history-count`).

## Acceptance criteria
- A multi-hundred-MB response does not freeze the renderer; a preview shows and
  the full body is retrievable on demand.
- History loads a bounded page quickly regardless of total history size.
- Streamed response temp files are cleaned up; retention honors the count setting.

## Constraints
- Streaming/temp-file handling lives in the main process.
- Reuse the temp-file pattern and GC from Feature 03.

## Verify
`make fmt && make lint && make test`
