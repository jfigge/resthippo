/**
 * stream-view.js — live SSE/chunked streaming + recorded-stream summary
 * (Feature 33), extracted from ResponseViewer.
 *
 * This owns everything stream-specific: the 14 live-stream state fields, the
 * reused WsConsole live log, the wurl:stream-* event handling, the terminal
 * state, save, and the static summary render shown when a recorded stream is
 * reopened from the Timeline.
 *
 * Unlike TimelineView, live streaming is a *consumer of the host's response
 * surface* — it writes the shared Body pane and status bar, switches tabs, and
 * renders the headers/cookies/console panes from the streaming marker. So the
 * seam is wider: the host injects a `host` facade of the accessors and render
 * helpers it owns. State, by contrast, lives entirely here, which is the point
 * of the split — none of the #stream* fields remain on ResponseViewer.
 */
"use strict";

import { t, formatDate, formatNumber } from "../../i18n.js";
import { WsConsole } from "../ws-console.js";
import { buildNdjsonStreamHint } from "./body-render.js";

// Live-streaming limits (Feature 33). The DOM log is capped so an unbounded
// stream stays memory-bounded; the full stream still lives in the main-process
// spill file and can be saved. The pre-activation buffer holds the handful of
// frames that may arrive between the first byte and the streaming marker.
const STREAM_MAX_FRAMES = 5000;
const STREAM_PENDING_CAP = 2000;

export class StreamView {
  #host;

  #streaming = false; // a live stream is currently being shown
  #streamId = null; // id of the active stream (matches wurl:stream-* payloads)
  #armedStreamId = null; // id from request-loading, before we know it will stream
  #streamConsole = null; // reused WsConsole instance acting as the live log
  #streamPending = []; // stream-data items buffered before the marker activates
  #streamBytes = 0; // running total bytes received
  #streamEvents = 0; // running event/line count
  #streamEnded = false; // the stream has finished (end / error / abort)
  #streamAborted = false; // it finished because the user pressed Stop
  #streamBodyRef = null; // spill ref for "save full stream" once it ends
  #streamRequestUrl = ""; // request URL, for the save-dialog default filename
  #streamStateEl = null; // toolbar state label
  #streamDotEl = null; // toolbar state dot
  #streamCountsEl = null; // toolbar live counters

  /**
   * @param {object} host  facade onto the bits ResponseViewer owns:
   *   getActiveTab(), getBodyPane(), getStatusBar(), isLoading(),
   *   statusClass(code), formatSize(bytes), setStatus(code,text,time,size),
   *   setCurrentMethod(m), setPreviewTabVisible(b), switchTab(id),
   *   renderHeadersPane(h), renderCookiesPane(c), renderConsole(lines),
   *   teardownBinaryEphemera(), destroyHtmlPreview(), clearSearchHighlights(),
   *   setFoldReveal(fn), resetStaticBody().
   */
  constructor(host) {
    this.#host = host;
  }

  /** True while a live stream is being shown (host routes Download accordingly). */
  isStreaming() {
    return this.#streaming;
  }

  /**
   * Pre-arm a stream id from request-loading, before we know the response will
   * stream — so frames arriving before the streaming marker are buffered and
   * replayed, not dropped.
   */
  arm(streamId) {
    this.#armedStreamId = streamId ?? null;
  }

  /**
   * Enter live-streaming mode from a streaming marker (response.streaming).
   * The Body pane becomes a live-append log (reused WsConsole) fed by the
   * wurl:stream-* events; headers / cookies / console come from the marker.
   * @param {object} response  the streaming marker
   * @param {string} [requestUrl]
   */
  startStream(response, requestUrl) {
    this.#host.teardownBinaryEphemera();
    this.#host.clearSearchHighlights();
    this.#host.destroyHtmlPreview();

    this.#streaming = true;
    this.#streamId = response.streamId ?? null;
    this.#streamRequestUrl = requestUrl ?? response.request?.url ?? "";
    this.#streamEnded = false;
    this.#streamAborted = false;
    this.#streamBodyRef = null;
    this.#streamBytes = 0;
    this.#streamEvents = 0;
    this.#host.resetStaticBody(); // streaming has no static body to re-render
    this.#host.setPreviewTabVisible(false);

    if (response.request?.method)
      this.#host.setCurrentMethod(response.request.method);

    // Status bar — status code/text plus a live size readout.
    this.#host.setStatus(
      response.status ?? "",
      response.statusText ?? "",
      `${response.elapsed ?? 0} ms`,
      "",
    );
    const badge = this.#host.getStatusBar().querySelector(".res-status-badge");
    badge.className = `res-status-badge ${this.#host.statusClass(response.status ?? 0)}`;

    // Body pane — streaming toolbar + reused live log.
    this.#buildStreamPane(response);

    // Headers / cookies / console from the marker.
    this.#host.renderHeadersPane(response.headers ?? {});
    this.#host.renderCookiesPane(response.cookies ?? []);
    this.#host.renderConsole(response.consoleLog ?? []);

    // Make the live log visible.
    if (this.#host.getActiveTab() !== "body") this.#host.switchTab("body");

    // Replay any frames that arrived before the marker activated this stream.
    const pending = this.#streamPending;
    this.#streamPending = [];
    for (const d of pending) {
      if (d.streamId === this.#streamId) this.#appendStreamItem(d);
    }
  }

  /** Build the streaming Body pane: a control toolbar above the reused log. */
  #buildStreamPane(response) {
    const pane = this.#host.getBodyPane();
    this.#host.teardownBinaryEphemera();
    pane.innerHTML = "";
    pane.classList.remove("res-tab-pane--fill");
    this.#host.setFoldReveal(null);

    const wrap = document.createElement("div");
    wrap.className = "res-stream";

    const toolbar = document.createElement("div");
    toolbar.className = "res-stream-toolbar";

    const state = document.createElement("span");
    state.className = "res-stream-state";
    const dot = document.createElement("span");
    dot.className = "res-stream-dot";
    dot.dataset.state = "streaming";
    dot.setAttribute("aria-hidden", "true");
    const stateLabel = document.createElement("span");
    stateLabel.className = "res-stream-state-label";
    stateLabel.textContent = t("response.stream.streaming");
    state.append(dot, stateLabel);

    const counts = document.createElement("span");
    counts.className = "res-stream-counts";

    // Stopping and saving live on the request editor's Send→Stop button and the
    // Body tab's Download menu respectively (Feature 33); the toolbar shows only
    // the live state + counters.
    toolbar.append(state, counts);

    // Reuse one WsConsole as the live log so SSE and WebSocket look consistent;
    // its own header is hidden by CSS in favour of the toolbar above.
    if (!this.#streamConsole) {
      this.#streamConsole = new WsConsole({ maxFrames: STREAM_MAX_FRAMES });
    } else {
      this.#streamConsole.reset();
    }

    wrap.append(toolbar, this.#streamConsole.element);
    pane.appendChild(wrap);

    this.#streamStateEl = stateLabel;
    this.#streamDotEl = dot;
    this.#streamCountsEl = counts;
    this.#updateStreamCounts();

    this.#streamConsole.addFrame({
      direction: "system",
      data: response.sse
        ? t("response.stream.startedSse")
        : t("response.stream.started"),
      ts: Date.now(),
    });
  }

  /** Append one streamed event/line to the live log and bump the counters. */
  #appendStreamItem(d) {
    if (!this.#streamConsole) return;
    if (typeof d.totalBytes === "number") this.#streamBytes = d.totalBytes;
    this.#streamEvents =
      typeof d.count === "number" ? d.count : this.#streamEvents + 1;

    if (d.kind === "event") {
      const ev = d.event ?? {};
      // A named event becomes a chip; the default "message" type stays untagged.
      const tag = ev.event && ev.event !== "message" ? ev.event : "";
      this.#streamConsole.addFrame({
        direction: "received",
        data: ev.data ?? "",
        ts: d.ts,
        tag,
      });
    } else {
      this.#streamConsole.addFrame({
        direction: "received",
        data: d.data ?? "",
        ts: d.ts,
      });
    }
    this.#updateStreamCounts();
  }

  /** Refresh the toolbar counters and the status-bar size readout. */
  #updateStreamCounts() {
    const text = t("response.stream.counts", {
      count: this.#streamEvents,
      size: this.#host.formatSize(this.#streamBytes),
    });
    if (this.#streamCountsEl) this.#streamCountsEl.textContent = text;
    const sizeEl = this.#host.getStatusBar().querySelector(".res-size");
    if (sizeEl) sizeEl.textContent = this.#host.formatSize(this.#streamBytes);
  }

  onStreamData(d) {
    if (!d || d.streamId == null) return;
    if (this.#streaming && d.streamId === this.#streamId) {
      this.#appendStreamItem(d);
    } else if (d.streamId === this.#armedStreamId) {
      // Arrived before the streaming marker — buffer until startStream drains.
      if (this.#streamPending.length < STREAM_PENDING_CAP) {
        this.#streamPending.push(d);
      }
    }
  }

  onStreamEnd(d) {
    if (!d || d.streamId !== this.#streamId || this.#streamEnded) return;
    this.#finishStream(d, { aborted: d.aborted === true });
  }

  onStreamError(d) {
    if (!d || d.streamId !== this.#streamId || this.#streamEnded) return;
    this.#finishStream(d, { error: d });
  }

  /**
   * Headers-time heads-up (Feature 33): the main process saw NDJSON headers but
   * live streaming is off, so the body is buffering. Show the hint atop the
   * loading view while the request runs. It belongs only to the armed (in-flight)
   * stream, and only while the loading timer is ticking — #showResponse /
   * #showError / #showLoading wipe the body pane, so it clears the instant the
   * request settles or a new one starts.
   */
  onStreamHint(d) {
    if (!d || d.streamId !== this.#armedStreamId || !this.#host.isLoading())
      return;
    const bodyPane = this.#host.getBodyPane();
    if (!bodyPane || bodyPane.querySelector(".res-stream-hint-banner")) return;
    bodyPane.insertBefore(buildNdjsonStreamHint(), bodyPane.firstChild);
  }

  /** Common terminal handling for a stream end / error / abort. */
  #finishStream(d, { aborted = false, error = null } = {}) {
    this.#streamEnded = true;
    this.#streamAborted = aborted;
    this.#armedStreamId = null;
    this.#streamBodyRef = d.bodyRef ?? null;
    if (typeof d.totalBytes === "number") this.#streamBytes = d.totalBytes;
    if (typeof d.eventCount === "number") this.#streamEvents = d.eventCount;

    const statusBar = this.#host.getStatusBar();
    // Update the time / size status-bar slots without clearing the badge.
    if (typeof d.elapsed === "number") {
      statusBar.querySelector(".res-time").textContent = `${d.elapsed} ms`;
    }
    statusBar.querySelector(".res-size").textContent = this.#host.formatSize(
      this.#streamBytes,
    );

    const endState = error ? "error" : aborted ? "stopped" : "ended";
    if (this.#streamDotEl) this.#streamDotEl.dataset.state = endState;
    if (this.#streamStateEl) {
      this.#streamStateEl.textContent = error
        ? t("response.stream.errored")
        : aborted
          ? t("response.stream.stopped")
          : t("response.stream.ended");
    }

    if (this.#streamConsole) {
      if (error) {
        this.#streamConsole.addFrame({
          direction: "system",
          level: "error",
          data: t("response.stream.errorFrame", {
            message: d.message ?? d.name ?? t("response.stream.errored"),
          }),
          ts: d.ts,
        });
      } else {
        this.#streamConsole.addFrame({
          direction: "system",
          data: t("response.stream.endedSummary", {
            count: this.#streamEvents,
            size: this.#host.formatSize(this.#streamBytes),
          }),
          ts: d.ts,
        });
      }
    }
    this.#updateStreamCounts();
  }

  /**
   * Save the stream to a file — the full payload from the main-process spill.
   * Triggered by the Body tab's Download menu while a stream is shown (Feature
   * 33); works mid-stream (bytes so far) and after it ends (redeem the bodyRef).
   */
  saveStream() {
    if (!this.#streamId) return;
    const filename = this.#streamSaveFilename();
    if (this.#streamEnded && this.#streamBodyRef) {
      window.wurl?.http?.body?.save?.(this.#streamBodyRef, filename);
    } else {
      // Still running — save the bytes received so far.
      window.wurl?.http?.stream?.save?.(this.#streamId, filename);
    }
  }

  /** Default save filename derived from the request URL's last path segment. */
  #streamSaveFilename() {
    const base =
      (this.#streamRequestUrl || "")
        .split("?")[0]
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/[^a-zA-Z0-9._-]/g, "_") || "stream";
    return base.includes(".") ? base : `${base}.txt`;
  }

  /**
   * Tear down the live-stream UI/state. With { abort:true } a still-running
   * stream's underlying request is aborted in the main process first.
   */
  teardownStream({ abort = false } = {}) {
    if (abort && this.#streaming && !this.#streamEnded && this.#streamId) {
      window.wurl?.http?.stream?.abort?.(this.#streamId)?.catch?.(() => {});
    }
    this.#streaming = false;
    this.#streamId = null;
    this.#armedStreamId = null;
    this.#streamPending = [];
    this.#streamEnded = false;
    this.#streamAborted = false;
    this.#streamBodyRef = null;
    this.#streamBytes = 0;
    this.#streamEvents = 0;
    this.#streamStateEl = null;
    this.#streamDotEl = null;
    this.#streamCountsEl = null;
    // Keep the WsConsole instance for reuse; just empty it.
    if (this.#streamConsole) this.#streamConsole.reset();
  }

  // ── Streaming-run Timeline record (Feature 33) ─────────────────────────────

  /**
   * Render a recorded streaming run's summary into the Body pane: when it was
   * sent, how long it ran, how many events/bytes arrived, and the last events
   * captured. This is the static counterpart to the live log — shown when a
   * stream entry is reopened from the Timeline, where there is no live socket.
   *
   * @param {object} summary  response.streamSummary (see app.js _recordStreamRun)
   * @param {HTMLElement} pane the (cleared) body pane to render into
   */
  renderStreamSummary(summary, pane) {
    const {
      sentAt = 0,
      elapsed = 0,
      eventCount = 0,
      bytes = 0,
      aborted = false,
      errored = false,
      errorMessage = "",
      sse = false,
      events = [],
    } = summary ?? {};

    const wrap = document.createElement("div");
    wrap.className = "stream-summary";

    // Header — terminal state dot/label + the stream kind.
    const head = document.createElement("div");
    head.className = "stream-summary-head";
    const dot = document.createElement("span");
    dot.className = "stream-summary-dot";
    dot.dataset.state = errored ? "error" : aborted ? "stopped" : "ended";
    dot.setAttribute("aria-hidden", "true");
    const stateLabel = document.createElement("span");
    stateLabel.className = "stream-summary-state";
    stateLabel.textContent = errored
      ? t("response.streamRecord.stateError")
      : aborted
        ? t("response.streamRecord.stateStopped")
        : t("response.streamRecord.stateEnded");
    const proto = document.createElement("span");
    proto.className = "stream-summary-proto";
    proto.textContent = sse
      ? t("response.streamRecord.sse")
      : t("response.streamRecord.chunked");
    head.append(dot, stateLabel, proto);
    wrap.appendChild(head);

    // Stats — sent time, duration, event count, bytes.
    const stats = document.createElement("dl");
    stats.className = "stream-summary-stats";
    const addStat = (label, value) => {
      const dt = document.createElement("dt");
      dt.className = "stream-summary-label";
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.className = "stream-summary-value";
      dd.textContent = value;
      stats.append(dt, dd);
    };
    addStat(t("response.streamRecord.sent"), sentAt ? formatDate(sentAt) : "—");
    addStat(t("response.streamRecord.duration"), this.#formatDuration(elapsed));
    addStat(t("response.streamRecord.events"), formatNumber(eventCount));
    addStat(t("response.streamRecord.bytes"), this.#host.formatSize(bytes));
    wrap.appendChild(stats);

    if (errored && errorMessage) {
      const err = document.createElement("p");
      err.className = "stream-summary-error";
      err.textContent = t("response.streamRecord.errorMessage", {
        message: errorMessage,
      });
      wrap.appendChild(err);
    }

    // Last events captured (or a note when none arrived).
    if (!events.length) {
      const empty = document.createElement("p");
      empty.className = "stream-summary-empty";
      empty.textContent = t("response.streamRecord.noEvents");
      wrap.appendChild(empty);
    } else {
      const evHead = document.createElement("h3");
      evHead.className = "stream-summary-events-head";
      evHead.textContent = t("response.streamRecord.lastEvents", {
        count: events.length,
      });
      wrap.appendChild(evHead);

      const list = document.createElement("div");
      list.className = "stream-summary-events";
      for (const ev of events)
        list.appendChild(this.#buildStreamSummaryRow(ev));
      wrap.appendChild(list);
    }

    pane.appendChild(wrap);
  }

  /** Build one captured-event row: timestamp, optional type chip, and payload. */
  #buildStreamSummaryRow(ev) {
    const row = document.createElement("div");
    row.className = "stream-summary-event";

    const time = document.createElement("span");
    time.className = "stream-summary-event-time";
    time.textContent = ev?.ts ? formatDate(ev.ts, { timeStyle: "medium" }) : "";

    const isEvent = ev?.kind === "event";
    const data = isEvent ? (ev.event?.data ?? "") : (ev?.data ?? "");
    const type = isEvent ? ev.event?.event : "";

    const main = document.createElement("div");
    main.className = "stream-summary-event-main";
    // A named SSE event (not the default "message") gets a chip. Both the chip
    // token and the body are untrusted server text → textContent, never HTML.
    if (type && type !== "message") {
      const chip = document.createElement("span");
      chip.className = "stream-summary-event-tag";
      chip.textContent = type;
      main.appendChild(chip);
    }
    const body = document.createElement("pre");
    body.className = "stream-summary-event-body";
    body.textContent = String(data);
    main.appendChild(body);

    row.append(time, main);
    return row;
  }

  /** Compact human duration: "350 ms", "2.4 s", "1 m 5 s". */
  #formatDuration(ms) {
    const n = Math.max(0, Math.round(ms || 0));
    if (n < 1000) return `${n} ms`;
    const secs = n / 1000;
    if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)} s`;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m} m ${s} s`;
  }
}
