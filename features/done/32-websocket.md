# Feature 32 — WebSocket client (ws/wss)

## Context
Rest Hippo speaks **HTTP/1.1 request→response only**. The single transport is Node `http`/`https` via
`lib.request()` in `src/app/main.js`, exposed as the one IPC channel `http:execute`
(`window.hippo.http.execute`). There is no WebSocket support — the string `"websocket"` appears only as an
autocomplete suggestion for the `Upgrade` header. Realtime/bidirectional APIs cannot be tested at all.
Postman and Insomnia both ship first-class WebSocket clients.

## Goal
Add a WebSocket request type: connect to `ws://`/`wss://`, send messages, and view a live, timestamped
frame log, with connection lifecycle controls.

## Implementation steps
1. **Request type**: introduce a WebSocket request kind in the tree/editor (a `protocol`/`type` on the
   request node). Reuse the URL pill editor, headers grid, and auth where applicable (e.g. bearer in the
   handshake). Persist alongside HTTP requests in the existing stores.
2. **Connection (main process)**: implement the WS client in main (the renderer is sandboxed and can't open
   raw sockets cleanly). Add IPC: `ws:open`, `ws:send`, `ws:close`, and a push channel
   (`ws:message`/`ws:status`) streaming frames + state to the renderer. Register in `main.js` + expose in
   `preload.js`. Evaluate a vetted `ws` dependency vs. Node primitives; honor proxy/TLS settings
   (Features 37/42/44).
3. **UI**: a connect/disconnect control, a message composer (text/JSON, with `{{var}}` resolution), and a
   scrolling frame log distinguishing sent/received/system frames with timestamps. Support ping/pong and
   close codes; show connection status.
4. **History/persistence**: persist the last message(s) and connection settings; the live frame log is
   session-scoped.

## Acceptance criteria
- A user can connect to a `wss://` echo endpoint, send a message, and see the echoed frame in the log.
- Sent/received/system frames are visually distinct and timestamped; status reflects open/closing/closed.
- Variable interpolation works in outgoing messages; proxy/TLS settings are honored.
- Disconnecting cleans up the socket and listeners with no leaks.

## Constraints
- Socket lifecycle lives in the **main process**; renderer talks only over IPC.
- Keep `main.js`/`preload.js` in sync for every new channel.
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`. Share streaming-viewer infrastructure
  with Feature 33 (SSE) where practical.

## Verify
`make fmt && make lint && make test`
