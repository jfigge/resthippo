# Feature 33 — Server-Sent Events & streaming responses

## Context
HTTP execution buffers the whole response: the main process reads to `res.on("end")` before returning, and
even the large-response path spills to disk and returns only a 256 KB preview. There is **no streaming
delivery to the renderer** — a `text/event-stream` response can't be consumed live, and a chunked log/LLM
token stream can't be watched as it arrives. Streaming/SSE APIs (notably LLM endpoints) are now mainstream
and are unusable here as live streams.

## Goal
Detect and consume streaming responses (`text/event-stream` and chunked streams) by appending data to the
response viewer **as it arrives**, with start/stop controls.

## Implementation steps
1. **Streaming execution (main)**: when the response is `text/event-stream` (or the user marks the request
   as streaming), keep the connection open and forward chunks to the renderer over a push channel
   (`http:stream:data` / `http:stream:end` / `http:stream:error`) instead of buffering. Parse SSE frames
   (`event:`/`data:`/`id:`/`retry:`) into discrete events. Register channels in `main.js` + `preload.js`.
2. **Viewer**: add a streaming mode to `response-viewer.js` that appends events/lines live (timestamped),
   with autoscroll and a Stop button to abort the request (`req.destroy`). Show byte/event counters.
3. **Backpressure & limits**: cap retained in-memory stream buffer (reuse the spill threshold philosophy);
   offer "save full stream to file." Ensure aborting tears down the socket cleanly.
4. **Reuse**: share the live-append viewer surface with Feature 32 (WebSocket) so both realtime modes look
   consistent.

## Acceptance criteria
- Hitting an SSE endpoint shows events appearing incrementally, not all-at-once at the end.
- A long/never-ending stream can be stopped, and stopping aborts the underlying request.
- Memory stays bounded for large streams; the full stream can be saved to disk.
- Non-streaming responses are unaffected.

## Constraints
- Streaming/socket handling lives in the **main process**; renderer consumes via IPC push events.
- Keep `main.js`/`preload.js` in sync; reuse Feature 32's streaming-viewer components.
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`.

## Verify
`make fmt && make lint && make test`
