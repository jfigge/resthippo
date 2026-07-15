# Feature 45 — Response timing waterfall (DNS / TCP / TLS / TTFB)

## Context
Only a single wall-clock duration is captured: `elapsed = Date.now() - startTime` (`src/app/main.js`
~796), shown as `${elapsed} ms` in the response status bar. The execution path already *logs* socket
lifecycle events (`socket.on("lookup")`, connect, `secureConnect`, first byte) to the Console (~906-944)
but never **times** them, and nothing surfaces a breakdown. Diagnosing *where* latency lives (slow DNS? TLS
handshake? server think-time?) is impossible. Postman shows a full timing waterfall.

## Goal
Capture per-phase timings (DNS lookup, TCP connect, TLS handshake, time-to-first-byte, content download)
and display them as a breakdown/waterfall in the response viewer.

## Implementation steps
1. **Instrument (main)**: timestamp the socket lifecycle events already hooked in the execution path —
   request start, `lookup` (DNS), `connect` (TCP), `secureConnect` (TLS), first response byte (TTFB), and
   `end` (download complete). Compute phase durations and include them in the response result object.
2. **Carry to renderer**: add the timing object to the response payload (and persist it in the history
   entry so past runs show their breakdown).
3. **UI**: render a compact waterfall/segmented bar in the response status area (or a small "Timing"
   popover/tab) using `theme.css` tokens, with absolute ms per phase and a total. Handle cached/redirected/
   proxied cases gracefully (some phases may be absent).

## Acceptance criteria
- After a request, the user can see DNS / TCP / TLS / TTFB / download timings that sum to ≈ the total.
- The breakdown persists in history and shows when replaying a Timeline entry.
- Requests without TLS (plain HTTP) or with a reused connection render sensibly (missing phases handled).
- The existing single `elapsed` total remains correct.

## Constraints
- Timing capture lives in the **main process** execution path; the renderer only displays.
- Additive to the response/history shape (coordinate with schema versioning); don't break existing history.
- Plain DOM + class-based ES module; CSS tokens from `theme.css`.

## Verify
`make fmt && make lint && make test`
