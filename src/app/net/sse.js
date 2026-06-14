// sse.js — Server-Sent Events frame parsing (Feature 33).
//
// A small, dependency-free state machine that turns a `text/event-stream` byte
// stream into discrete events, following the WHATWG SSE parsing rules:
//
//   • lines are separated by CRLF, LF, or a lone CR;
//   • a blank line dispatches the buffered event;
//   • fields are `name: value` (one optional leading space after the colon is
//     stripped); a line with no colon is a field with an empty value; a line
//     beginning with a colon is a comment and is ignored;
//   • `event` sets the event type, `data` appends a line (joined with "\n"),
//     `id` updates the last-event-id (ignored if it contains a NUL), and
//     `retry` sets the reconnection time when it is all ASCII digits.
//
// The parser works on strings; the caller decodes the socket's bytes as UTF-8
// (via a StringDecoder so multi-byte characters split across chunks survive).
// `LineBuffer` is the simpler sibling used for non-SSE chunked streams — an
// application/x-ndjson response when the global "Stream NDJSON responses live"
// setting is on — where each newline-delimited line is surfaced as its own row.

"use strict";

/** True when a Content-Type names an SSE stream (parameters after `;` ignored). */
function isEventStream(contentType) {
  return /^\s*text\/event-stream\b/i.test(String(contentType || ""));
}

/**
 * True when a Content-Type names an NDJSON stream (application/x-ndjson, or the
 * unprefixed application/ndjson variant; parameters after `;` ignored). Gated by
 * the global streamNdjson setting at the call site — NDJSON only auto-streams
 * when the user opted in.
 */
function isNdjson(contentType) {
  return /^\s*application\/(x-)?ndjson\b/i.test(String(contentType || ""));
}

class SseParser {
  constructor() {
    this._buf = ""; // partial line after the last terminator, awaiting more
    this._pendingCR = false; // last chunk ended on CR — swallow a leading LF next
    this._data = ""; // accumulated `data:` lines for the in-progress event
    this._eventType = ""; // current `event:` type (defaults to "message")
    this._lastId = ""; // last seen `id:` — persists across events per the spec
    this._retry = undefined; // `retry:` reconnection time seen in this event, if any
  }

  /**
   * Feed a decoded text chunk and return every event completed by it.
   * @param {string} chunk
   * @returns {Array<{ event: string, data: string, id: string, retry?: number }>}
   */
  feed(chunk) {
    // A CR that ended the previous chunk may be the first half of a CRLF whose
    // LF leads this one — drop that LF so the line break counts once.
    if (this._pendingCR) {
      this._pendingCR = false;
      if (chunk[0] === "\n") chunk = chunk.slice(1);
    }
    this._buf += chunk;
    const events = [];

    let start = 0;
    let i = 0;
    while (i < this._buf.length) {
      const c = this._buf[i];
      if (c === "\n") {
        this.#processLine(this._buf.slice(start, i), events);
        i += 1;
        start = i;
      } else if (c === "\r") {
        this.#processLine(this._buf.slice(start, i), events);
        if (i + 1 < this._buf.length) {
          // Consume a following LF (CRLF) here; a lone CR advances by one.
          i += this._buf[i + 1] === "\n" ? 2 : 1;
        } else {
          // CR is the last byte — its line is already terminated; remember to
          // swallow a CRLF's LF if it arrives at the head of the next chunk.
          this._pendingCR = true;
          i += 1;
        }
        start = i;
      } else {
        i += 1;
      }
    }
    this._buf = this._buf.slice(start);
    return events;
  }

  /**
   * Flush at end-of-stream. A final block not terminated by a blank line is
   * discarded per the spec, so this only clears state and returns nothing.
   * @returns {Array}
   */
  flush() {
    this._buf = "";
    this._pendingCR = false;
    this._data = "";
    this._eventType = "";
    this._retry = undefined;
    return [];
  }

  #processLine(line, events) {
    if (line === "") {
      this.#dispatch(events);
      return;
    }
    if (line[0] === ":") return; // comment

    const colon = line.indexOf(":");
    let field;
    let value;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value[0] === " ") value = value.slice(1);
    }

    switch (field) {
      case "event":
        this._eventType = value;
        break;
      case "data":
        this._data += value + "\n";
        break;
      case "id":
        // A NUL in the id is a hard error per the spec — ignore the field.
        if (!value.includes("\u0000")) this._lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this._retry = Number(value);
        break;
      default:
        break; // unknown field — ignored
    }
  }

  #dispatch(events) {
    // An empty data buffer means a stray blank line (or a comment-only block):
    // reset the per-event fields and emit nothing.
    if (this._data === "") {
      this._eventType = "";
      this._retry = undefined;
      return;
    }
    // The accumulation appends a trailing "\n" per data line; strip the last.
    const data = this._data.endsWith("\n")
      ? this._data.slice(0, -1)
      : this._data;
    const ev = {
      event: this._eventType || "message",
      data,
      id: this._lastId,
    };
    if (this._retry !== undefined) ev.retry = this._retry;
    events.push(ev);

    // lastId persists; event type, data and retry reset for the next event.
    this._data = "";
    this._eventType = "";
    this._retry = undefined;
  }
}

/**
 * Newline splitter for non-SSE streaming bodies (NDJSON / plain chunked logs).
 * Surfaces each complete line; a CR before the LF is trimmed.
 */
class LineBuffer {
  constructor() {
    this._buf = "";
  }

  /** Feed a decoded chunk; return the complete lines it produced. */
  feed(chunk) {
    this._buf += chunk;
    const lines = [];
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      let line = this._buf.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      this._buf = this._buf.slice(idx + 1);
    }
    return lines;
  }

  /** Return any trailing partial line (no terminating newline), then clear. */
  flush() {
    let line = this._buf;
    this._buf = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line === "" ? [] : [line];
  }
}

module.exports = { SseParser, LineBuffer, isEventStream, isNdjson };
