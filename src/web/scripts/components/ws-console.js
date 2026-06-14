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

import { t } from "../i18n.js";

// Lifecycle states → header dot modifier + i18n key for the human label. Keys
// (not text) live at module scope; t() resolves them at render — the catalog
// isn't loaded when this module is first evaluated.
const STATE_LABEL_KEYS = {
  idle: "wsConsole.state.idle",
  connecting: "wsConsole.state.connecting",
  open: "wsConsole.state.open",
  closing: "wsConsole.state.closing",
  closed: "wsConsole.state.closed",
  error: "wsConsole.state.error",
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
  #maxFrames;

  /**
   * @param {{ maxFrames?: number }} [opts]
   *   maxFrames caps the number of rows retained in the DOM (oldest are trimmed
   *   as new ones arrive) so an unbounded stream stays memory-bounded. Defaults
   *   to Infinity — the WebSocket console keeps every frame, as before.
   */
  constructor({ maxFrames = Infinity } = {}) {
    this.#maxFrames = maxFrames;
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
    this.#headerLabel.textContent = t("wsConsole.state.idle");

    this.#headerMeta = document.createElement("span");
    this.#headerMeta.className = "ws-console-meta";

    status.append(this.#headerDot, this.#headerLabel, this.#headerMeta);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "ws-console-clear";
    clearBtn.textContent = t("wsConsole.clear");
    clearBtn.setAttribute("aria-label", t("wsConsole.clearAria"));
    clearBtn.addEventListener("click", () => this.clear());

    header.append(status, clearBtn);

    // ── Frame log ──────────────────────────────────────────────────────────
    this.#logEl = document.createElement("div");
    this.#logEl.className = "ws-console-log";
    this.#logEl.setAttribute("role", "log");
    this.#logEl.setAttribute("aria-live", "polite");

    this.#emptyEl = document.createElement("div");
    this.#emptyEl.className = "ws-console-empty";
    this.#emptyEl.textContent = t("wsConsole.empty");
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
            ? t("wsConsole.connectedProtocol", { protocol: status.protocol })
            : t("wsConsole.connected"),
          ts: status.ts,
        });
        break;
      case "closing":
        this.#setHeader("closing");
        break;
      case "closed": {
        let meta = "";
        if (status.code != null) {
          meta = status.reason
            ? t("wsConsole.closeCodeReason", {
                code: status.code,
                reason: status.reason,
              })
            : t("wsConsole.closeCode", { code: status.code });
        }
        this.#setHeader("closed", meta);
        this.addFrame({
          direction: "system",
          data: meta
            ? t("wsConsole.connectionClosedMeta", { meta })
            : t("wsConsole.connectionClosed"),
          ts: status.ts,
        });
        break;
      }
      case "error":
        this.#setHeader("error", status.code != null ? `${status.code}` : "");
        this.addFrame({
          direction: "system",
          data: t("wsConsole.errorFrame", {
            message: status.message ?? t("wsConsole.errorDefault"),
          }),
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
   *           ts?: number, binary?: boolean, level?: "error", tag?: string }} frame
   *   tag renders a small chip above the body (e.g. the SSE event type); it is
   *   untrusted server text, so it is written via textContent.
   */
  addFrame({ direction, data, ts, binary = false, level, tag = "" } = {}) {
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
        ? t("wsConsole.srSent")
        : direction === "received"
          ? t("wsConsole.srReceived")
          : t("wsConsole.srSystem");

    const body = document.createElement("pre");
    body.className = "ws-frame-body";
    // Untrusted server payload → textContent, never innerHTML.
    body.textContent =
      binary && direction === "received"
        ? t("wsConsole.binaryFrame", { bytes: atobLen(data) })
        : direction === "system"
          ? String(data ?? "")
          : maybePrettyJson(String(data ?? ""));

    // A tagged frame (e.g. a named SSE event) wraps the tag chip + body in the
    // body column so the surrounding grid stays a clean three columns.
    if (tag) {
      const main = document.createElement("div");
      main.className = "ws-frame-main";
      const chip = document.createElement("span");
      chip.className = "ws-frame-tag";
      chip.textContent = tag; // untrusted server token → textContent
      main.append(chip, body);
      row.append(time, glyph, label, main);
    } else {
      row.append(time, glyph, label, body);
    }
    this.#logEl.appendChild(row);
    this.#frameCount++;

    // Trim the oldest rows once the cap is exceeded so a long-running stream
    // stays memory-bounded (the full stream still lives in the spill file).
    while (this.#frameCount > this.#maxFrames && this.#logEl.firstChild) {
      this.#logEl.removeChild(this.#logEl.firstChild);
      this.#frameCount--;
    }

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
    this.#headerLabel.textContent = STATE_LABEL_KEYS[state]
      ? t(STATE_LABEL_KEYS[state])
      : state;
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
