# Feature 67 — Protocol breadth: gRPC and Socket.IO

## Context
Rest Hippo now speaks four transports: HTTP/1.1 (`http:execute`), WebSocket (Feature 32 — `ws:open`/
`ws:send`/`ws:close` + `ws:message`/`ws:status` push, socket lifecycle in `src/app/ipc/websocket.js`), and
Server-Sent Events / chunked streaming (Feature 33 — `http:stream:*`, parser in `src/app/net/sse.js`). The
streaming UI is shared: `src/web/scripts/components/ws-console.js` (`WsConsole`) is reused by SSE and the
`response/stream-view.js`. Request kind is carried on the tree node as `protocol` (e.g. `"websocket"`), and
persisted documents are schema-versioned (`src/app/store/migrations.js`).

Two high-value transports are still missing, both shipped by Postman/Insomnia:
- **gRPC** — unary + streaming RPC over HTTP/2 with protobuf. No support at all.
- **Socket.IO** — the event/ack layer many web apps use on top of WebSocket; a raw `ws://` client can't
  speak its handshake/framing.

## Goal
Add two new request kinds — **gRPC** (`protocol: "grpc"`) and **Socket.IO** (`protocol: "socketio"`) — that
reuse the existing tree/editor, variable resolution, streaming console, and TLS/mTLS/proxy plumbing, so a
user can invoke an RPC or emit/observe Socket.IO events without leaving the app.

## Implementation steps
1. **gRPC — main process.** Add `@grpc/grpc-js` + `@grpc/proto-loader` (main-process deps). Load a
   user-supplied `.proto` (or a directory / server **reflection**), enumerate services + methods and their
   input/output message shapes. Support all four call types: unary, server-streaming, client-streaming,
   bidi. Carry request **metadata** (headers grid), a **deadline** (timeout), and reuse Feature 37 mTLS +
   Feature 44 proxy settings for the channel credentials. New IPC: `grpc:load-proto`, `grpc:invoke`,
   `grpc:send` (for client/bidi streams), `grpc:cancel`, plus push channels `grpc:message`/`grpc:status`.
   Register in `main.js`, expose in `preload.js`.
2. **gRPC — UI.** A `.proto` / reflection source picker; service + method dropdowns; a request-message
   editor (JSON that is encoded to protobuf, with `{{var}}` resolution via the pill editor); a metadata
   grid; and a streaming console (reuse `WsConsole`) that distinguishes sent/received/trailer/status frames
   with timestamps. Show the resolved status code + trailers on completion.
3. **Socket.IO — main process.** Add `socket.io-client`. Connect to a Socket.IO endpoint with an optional
   **namespace**; support `emit(event, payload)` with optional **ack** callbacks, subscribe to arbitrary
   named events, and reconnection state. Reuse/extend the WebSocket IPC surface where practical (a
   `socketio:*` sibling of `ws:*`), honoring proxy/TLS/auth from the handshake headers.
4. **Socket.IO — UI.** An event composer (event name + JSON payload with `{{var}}` resolution), an
   event-subscription list, and the shared streaming console showing emitted/received/ack/system frames.
5. **Persistence & schema.** Persist proto source path / reflection flag / selected method / metadata
   (gRPC) and namespace / last events (Socket.IO) as additive, schema-versioned fields on the request node;
   add a migration. The live frame log stays session-scoped like WS/SSE.
6. **Import/export & code-gen.** At minimum, don't break the existing formats when these kinds are present
   (round-trip them or skip cleanly). Stretch: a gRPCurl / `grpc_cli` snippet in the code-gen targets.
7. **User guide.** Add a protocols page (or extend the existing WebSocket/SSE page) covering gRPC and
   Socket.IO.

## Acceptance criteria
- A user can load a `.proto` (or use reflection), pick a unary method, send a JSON message, and see the
  decoded response + status/trailers; a server-streaming method shows frames arriving live.
- A user can connect to a Socket.IO server in a namespace, emit an event with an ack, and see incoming
  events in the console; sent/received/ack/system frames are visually distinct and timestamped.
- Variable interpolation works in gRPC messages and Socket.IO payloads; mTLS/proxy settings are honored.
- Disconnect/cancel tears down the channel/socket and all listeners with no leaks.
- Existing HTTP/WS/SSE requests are unaffected; `make fmt && make lint && make test` is green.

## Constraints
- All socket/channel lifecycle lives in the **main process**; the renderer talks only over `window.hippo.*`
  IPC. Keep `main.js`/`preload.js` in sync for every new channel.
- Reuse `WsConsole`/`stream-view.js` for the frame log, the pill editor for message bodies, and the
  Feature 37/44 TLS/proxy paths — do **not** fork a second streaming or TLS stack.
- New request fields are additive + schema-versioned (coordinate with `migrations.js`); persisted history
  shape stays backward-compatible.
- Every new dependency is main-process only and vetted; no renderer bundling of protobuf/socket.io.
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`; every user string via `t()` and
  translated into all seven catalogs.

## Verify
`make fmt && make lint && make test`, then `make debug`: invoke a unary + a server-streaming gRPC method and
emit/receive a Socket.IO event against a local echo server.
