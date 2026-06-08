// ws-console.js — live WebSocket frame log (Feature 32).
//
// Mounted in the Response pane and shown in place of the Response viewer while a
// WebSocket request is selected. It renders a connection-status header and a
// scrolling, timestamped log of frames: outgoing (sent), incoming (received) and
// system/lifecycle events are visually distinct. The live log is session-scoped
// — nothing here is persisted.
//
// Frame payloads originate from the remote server and are therefore untrusted:
// every payload is written via textContent (never innerHTML) so a malicious
// frame cannot inject markup into the renderer.

/** Lifecycle states → header dot modifier + human label. */
const STATE_LABELS = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Open",
  closing: "Closing…",
  closed: "Closed",
  error: "Error",
};

/** Zero-pad a number to width 2 (or 3 for milliseconds). */
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** Format an epoch-ms timestamp as HH:MM:SS.mmm in local time. */
function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

/** Pretty-print a text payload when it parses as JSON; otherwise return as-is. */
function maybePrettyJson(text) {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

export class WsConsole {
  #el;
  #headerDot;
  #headerLabel;
  #headerMeta;
  #logEl;
  #emptyEl;
  #frameCount = 0;

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "ws-console";

    // ── Status header ──────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "ws-console-header";

    const status = document.createElement("div");
    status.className = "ws-console-status";

    this.#headerDot = document.createElement("span");
    this.#headerDot.className = "ws-console-dot";
    this.#headerDot.dataset.state = "idle";
    this.#headerDot.setAttribute("aria-hidden", "true");

    this.#headerLabel = document.createElement("span");
    this.#headerLabel.className = "ws-console-state";
    this.#headerLabel.textContent = STATE_LABELS.idle;

    this.#headerMeta = document.createElement("span");
    this.#headerMeta.className = "ws-console-meta";

    status.append(this.#headerDot, this.#headerLabel, this.#headerMeta);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "ws-console-clear";
    clearBtn.textContent = "Clear";
    clearBtn.setAttribute("aria-label", "Clear frame log");
    clearBtn.addEventListener("click", () => this.clear());

    header.append(status, clearBtn);

    // ── Frame log ──────────────────────────────────────────────────────────
    this.#logEl = document.createElement("div");
    this.#logEl.className = "ws-console-log";
    this.#logEl.setAttribute("role", "log");
    this.#logEl.setAttribute("aria-live", "polite");

    this.#emptyEl = document.createElement("div");
    this.#emptyEl.className = "ws-console-empty";
    this.#emptyEl.textContent =
      "No frames yet. Connect, then send a message to see it echoed here.";
    this.#logEl.appendChild(this.#emptyEl);

    this.#el.append(header, this.#logEl);
  }

  /** Root element — mount into the response pane. */
  get element() {
    return this.#el;
  }

  /**
   * Apply a status object pushed from the main process (or a renderer-side
   * lifecycle transition). Lifecycle states update the header; closed/error also
   * drop a system frame, and `system`/`ping`/`pong` events become system frames.
   *
   * @param {{ state: string, code?: number, reason?: string, message?: string,
   *           protocol?: string, ts?: number }} status
   */
  applyStatus(status = {}) {
    const { state } = status;
    switch (state) {
      case "connecting":
        this.#setHeader("connecting");
        break;
      case "open":
        this.#setHeader("open");
        this.addFrame({
          direction: "system",
          data: status.protocol
            ? `Connected · subprotocol "${status.protocol}"`
            : "Connected",
          ts: status.ts,
        });
        break;
      case "closing":
        this.#setHeader("closing");
        break;
      case "closed": {
        const meta =
          status.code != null
            ? `code ${status.code}${status.reason ? ` · ${status.reason}` : ""}`
            : "";
        this.#setHeader("closed", meta);
        this.addFrame({
          direction: "system",
          data: `Connection closed${meta ? ` (${meta})` : ""}`,
          ts: status.ts,
        });
        break;
      }
      case "error":
        this.#setHeader("error", status.code != null ? `${status.code}` : "");
        this.addFrame({
          direction: "system",
          data: `Error: ${status.message ?? "connection failed"}`,
          ts: status.ts,
          level: "error",
        });
        break;
      case "system":
      case "ping":
      case "pong":
        this.addFrame({
          direction: "system",
          data: status.message ?? state,
          ts: status.ts,
        });
        break;
      default:
        break;
    }
  }

  /**
   * Append a frame row.
   * @param {{ direction: "sent"|"received"|"system", data: string,
   *           ts?: number, binary?: boolean, level?: "error" }} frame
   */
  addFrame({ direction, data, ts, binary = false, level } = {}) {
    if (this.#emptyEl.parentNode) this.#emptyEl.remove();

    const stick = this.#isScrolledToBottom();

    const row = document.createElement("div");
    row.className = `ws-frame ws-frame--${direction}`;
    if (level === "error") row.classList.add("ws-frame--error");

    const time = document.createElement("span");
    time.className = "ws-frame-time";
    time.textContent = formatTime(ts);

    const glyph = document.createElement("span");
    glyph.className = "ws-frame-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent =
      direction === "sent" ? "↑" : direction === "received" ? "↓" : "ⓘ";

    const label = document.createElement("span");
    label.className = "ws-frame-sr";
    label.textContent =
      direction === "sent"
        ? "sent"
        : direction === "received"
          ? "received"
          : "system";

    const body = document.createElement("pre");
    body.className = "ws-frame-body";
    // Untrusted server payload → textContent, never innerHTML.
    body.textContent =
      binary && direction === "received"
        ? `[binary frame — ${atobLen(data)} bytes]`
        : direction === "system"
          ? String(data ?? "")
          : maybePrettyJson(String(data ?? ""));

    row.append(time, glyph, label, body);
    this.#logEl.appendChild(row);
    this.#frameCount++;

    if (stick) this.#scrollToBottom();
  }

  /** Remove every frame row and restore the empty-state hint. */
  clear() {
    this.#logEl.replaceChildren(this.#emptyEl);
    this.#frameCount = 0;
  }

  /** Clear the log and reset the header to the idle state. */
  reset() {
    this.clear();
    this.#setHeader("idle");
  }

  /** Number of frames currently shown (used by tests / callers). */
  get frameCount() {
    return this.#frameCount;
  }

  // ── internals ────────────────────────────────────────────────────────────
  #setHeader(state, meta = "") {
    this.#headerDot.dataset.state = state;
    this.#headerLabel.textContent = STATE_LABELS[state] ?? state;
    this.#headerMeta.textContent = meta;
  }

  #isScrolledToBottom() {
    const el = this.#logEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  #scrollToBottom() {
    this.#logEl.scrollTop = this.#logEl.scrollHeight;
  }
}

/** Decoded byte length of a base64 string, for the binary-frame summary. */
function atobLen(b64) {
  try {
    return atob(String(b64)).length;
  } catch {
    return String(b64 ?? "").length;
  }
}
