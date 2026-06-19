/**
 * timeline-view.js — the response viewer's Timeline (run-history) tab.
 *
 * Extracted from ResponseViewer as a delegated sub-component: it owns the
 * run-history list + master/detail DOM and the live "Xs ago" timestamp ticker,
 * and reports user actions (select / restore / delete / clear) by dispatching
 * the same window `hippo:timeline-*` events app.js already listens for — so the
 * host stays a thin forwarder.
 *
 * The host (ResponseViewer) still owns tab lifecycle and the response panes, so
 * it injects the few things this view reads back: which tab is active, the
 * timeline pane element, and the shared `placeholder` / `statusClass` /
 * `formatSize` render helpers. State (`#timelineEntries` / `#timelineSelected` /
 * `#requestId` / `#timestampTimer`) lives entirely here.
 */
"use strict";

import { t, formatDate } from "../../i18n.js";
import { icon } from "../../icons.js";

const SVG_COPY = icon("copy", { size: 18 });
const SVG_CHECK = icon("check", { size: 18 });

export class TimelineView {
  #getActiveTab;
  #getPane;
  #placeholder;
  #statusClass;
  #formatSize;

  #timelineEntries = []; // current list of HistoryEntry objects (newest first)
  #timelineSelected = -1; // index of the selected entry (-1 = none)
  #requestId = null; // id of the request whose timeline is shown (for delete/clear)
  #timestampTimer = null; // setInterval handle for live timestamp updates

  /**
   * @param {object} deps
   * @param {() => string} deps.getActiveTab     the host's current tab id
   * @param {() => HTMLElement|null} deps.getPane the #res-tab-timeline pane
   * @param {(opts: object) => HTMLElement} deps.placeholder shared placeholder builder
   * @param {(code: number) => string} deps.statusClass status → CSS class
   * @param {(bytes: number) => string} deps.formatSize byte count → human string
   */
  constructor({ getActiveTab, getPane, placeholder, statusClass, formatSize }) {
    this.#getActiveTab = getActiveTab;
    this.#getPane = getPane;
    this.#placeholder = placeholder;
    this.#statusClass = statusClass;
    this.#formatSize = formatSize;
  }

  /**
   * Replace the cached run history and re-render. Selection resets to "none"
   * (the detail panel then previews the latest entry). Called by the host on
   * every `hippo:timeline-update`.
   */
  update(entries, requestId) {
    this.#timelineEntries = entries ?? [];
    this.#requestId = requestId ?? null;
    this.#timelineSelected = -1;
    this.#renderTimeline();
  }

  /** Re-render the timeline pane (host calls this when entering the tab). */
  render() {
    this.#renderTimeline();
  }

  // ── Timeline rendering ────────────────────────────────────────────────────

  /**
   * Re-render the timeline pane from the cached #timelineEntries array. The pane
   * is a master/detail split: a list of run entries on the left and the selected
   * entry's request snapshot on the right.
   */
  #renderTimeline() {
    if (this.#getActiveTab() !== "timeline") return;

    const pane = this.#getPane();
    if (!pane) return;
    pane.innerHTML = "";

    if (!this.#timelineEntries.length) {
      pane.appendChild(
        this.#placeholder({
          icon: "🕓",
          text: t("response.placeholder.historyEmpty"),
        }),
      );
      return;
    }

    const split = document.createElement("div");
    split.className = "timeline-pane";

    const list = document.createElement("div");
    list.className = "timeline-list";
    this.#timelineEntries.forEach((entry, idx) =>
      list.appendChild(this.#buildTimelineRow(entry, idx)),
    );

    const detail = document.createElement("div");
    detail.className = "timeline-detail";
    this.#renderTimelineDetail(detail);

    split.appendChild(list);
    split.appendChild(detail);
    pane.appendChild(split);
  }

  /** Build one timeline list row for the entry at `idx`. */
  #buildTimelineRow(entry, idx) {
    const {
      status = 0,
      statusText = "",
      elapsed = 0,
      size = 0,
    } = entry.response ?? {};
    const item = document.createElement("button");
    item.className = "timeline-item";
    item.setAttribute("type", "button");
    if (idx === this.#timelineSelected)
      item.classList.add("timeline-item--selected");
    if (idx === 0) item.classList.add("timeline-item--latest");

    const ts = document.createElement("span");
    ts.className = "timeline-timestamp";
    ts.textContent = this.#formatTimestamp(entry.timestamp);

    const record = document.createElement("div");
    record.className = "timeline-record";

    const badge = document.createElement("span");
    badge.className = `timeline-badge ${this.#statusClass(status)}`;
    badge.textContent = status || "ERR";

    const text = document.createElement("span");
    text.className = "timeline-text";
    text.textContent = statusText || (status ? "" : "Error");

    const meta = document.createElement("span");
    meta.className = "timeline-meta";

    const time = document.createElement("span");
    time.className = "timeline-time";
    time.textContent = elapsed ? `${elapsed} ms` : "";

    const sizeEl = document.createElement("span");
    sizeEl.className = "timeline-size";
    sizeEl.textContent = size ? this.#formatSize(size) : "";

    meta.appendChild(time);
    meta.appendChild(sizeEl);
    record.appendChild(badge);
    record.appendChild(text);
    record.appendChild(meta);
    item.appendChild(ts);
    item.appendChild(record);

    // Left-click selects the entry: highlight it, render its request snapshot in
    // the detail panel, and load that run's response into the other tabs. This
    // is non-destructive — it never overwrites the live request. Use the
    // right-click "Restore" action for that.
    item.addEventListener("click", () => this.#selectTimelineEntry(idx));

    // Right-click opens the OS-native actions menu (restore / copy / delete).
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#selectTimelineEntry(idx);
      this.#showTimelineContextMenu(entry, e.clientX, e.clientY);
    });

    return item;
  }

  /**
   * Select a timeline entry: highlight the row, render its request snapshot in
   * the detail panel, and dispatch hippo:timeline-select so app.js loads that
   * run's response into the body/headers/cookies tabs. Non-destructive — the
   * live request editor is left untouched.
   */
  #selectTimelineEntry(idx) {
    this.#timelineSelected = idx;
    this.#renderTimeline();
    const entry = this.#timelineEntries[idx];
    if (!entry) return;
    window.dispatchEvent(
      new CustomEvent("hippo:timeline-select", {
        detail: {
          requestUrl: entry.requestUrl ?? "",
          response: entry.response,
        },
      }),
    );
  }

  /**
   * OS-native right-click menu for a timeline entry. "Restore" replays the
   * snapshot back into the request editor (the one destructive action, now
   * explicit); the rest cover copy and history lifecycle.
   */
  async #showTimelineContextMenu(entry, x, y) {
    const items = [
      { id: "restore", label: t("menu.restoreEntry") },
      { type: "separator" },
      { id: "delete", label: t("menu.deleteEntry") },
      { id: "delete-all", label: t("menu.deleteAllHistory") },
    ];
    const clickedId = await window.hippo.ui.contextMenu.show({ items, x, y });
    if (clickedId === "restore") {
      window.dispatchEvent(
        new CustomEvent("hippo:timeline-restore", {
          detail: {
            requestNode: entry.requestNode,
            requestUrl: entry.requestUrl ?? "",
            response: entry.response,
          },
        }),
      );
    } else if (clickedId === "delete") {
      this.#deleteTimelineEntry(entry.id);
    } else if (clickedId === "delete-all") {
      this.#clearTimeline();
    }
  }

  /**
   * Delete a single timeline entry. Delegates to app.js (owner of history
   * state + storage) which removes the on-disk files and re-dispatches
   * hippo:timeline-update so the pane re-renders.
   */
  #deleteTimelineEntry(historyId) {
    if (!this.#requestId || !historyId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:timeline-delete-entry", {
        detail: { requestId: this.#requestId, historyId },
      }),
    );
  }

  /** Clear the entire run history for the current request (delegated to app.js). */
  #clearTimeline() {
    if (!this.#requestId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:timeline-clear", {
        detail: { requestId: this.#requestId },
      }),
    );
  }

  // ── Timeline detail panel ─────────────────────────────────────────────────

  /**
   * Render the selected entry's request snapshot into the detail `container`.
   * With no explicit selection (-1) the latest entry is previewed. Shows what
   * the run was sent with: method, URL, params, headers, auth — each section
   * with a copy button. (Disabled rows render greyed, prefixed with "# ".)
   */
  #renderTimelineDetail(container) {
    const idx = this.#timelineSelected >= 0 ? this.#timelineSelected : 0;
    const snapshot = this.#timelineEntries[idx]?.requestNode;
    if (!snapshot) {
      const ph = document.createElement("div");
      ph.className = "timeline-detail-empty";
      ph.textContent = t("response.timeline.selectEntry");
      container.appendChild(ph);
      return;
    }

    // Method — no copy
    this.#appendDetailSection(container, t("response.timeline.method"));
    this.#appendDetailValue(container, snapshot.method ?? "GET");

    // URL — copy if present
    const url = (snapshot.url ?? "").trim();
    this.#appendDetailSection(
      container,
      t("response.timeline.url"),
      url || null,
    );
    this.#appendDetailValue(
      container,
      url || t("response.timeline.emptyValue"),
    );

    // Parameters (already bulk-edit format)
    const paramsBulk = (snapshot.params ?? "").trim();
    this.#appendDetailSection(
      container,
      t("response.timeline.parameters"),
      paramsBulk || null,
    );
    if (!paramsBulk) {
      this.#appendDetailNone(container);
    } else {
      this.#appendDetailBulkLines(container, paramsBulk);
    }

    // Headers (already bulk-edit format)
    const headersBulk = (snapshot.headers ?? "").trim();
    this.#appendDetailSection(
      container,
      t("response.timeline.headers"),
      headersBulk || null,
    );
    if (!headersBulk) {
      this.#appendDetailNone(container);
    } else {
      this.#appendDetailBulkLines(container, headersBulk);
    }

    // Auth
    const authCopy = this.#buildAuthCopyText(snapshot);
    this.#appendDetailSection(container, t("response.timeline.auth"), authCopy);
    this.#appendDetailAuth(container, snapshot);
  }

  #buildAuthCopyText(snapshot) {
    const type = snapshot.authType ?? "none";
    const bulk = (snapshot.auth ?? "").trim();
    if (type === "none") return null;
    const lines = [`type: ${type}`];
    if (bulk) lines.push(...bulk.split("\n").filter((l) => l.trim()));
    return lines.join("\n");
  }

  #appendDetailSection(parent, label, copyText = null) {
    const row = document.createElement("div");
    row.className = "timeline-detail-section";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    row.appendChild(lbl);
    if (copyText) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "timeline-detail-copy-btn";
      btn.title = t("response.timeline.copyTitle", { label });
      btn.innerHTML = SVG_COPY;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(copyText)
          .then(() => {
            btn.innerHTML = SVG_CHECK;
            btn.classList.add("timeline-detail-copy-btn--copied");
            setTimeout(() => {
              btn.innerHTML = SVG_COPY;
              btn.classList.remove("timeline-detail-copy-btn--copied");
            }, 1500);
          })
          .catch(() => {
            /* clipboard denied — leave the copy icon as-is */
          });
      });
      row.appendChild(btn);
    }
    parent.appendChild(row);
  }

  #appendDetailValue(parent, text) {
    const el = document.createElement("div");
    el.className = "timeline-detail-value";
    el.textContent = text;
    parent.appendChild(el);
  }

  #appendDetailNone(parent) {
    const el = document.createElement("div");
    el.className = "timeline-detail-none";
    el.textContent = t("response.timeline.none");
    parent.appendChild(el);
  }

  #appendDetailAuth(parent, snapshot) {
    const type = snapshot.authType ?? "none";
    if (type === "none") {
      this.#appendDetailNone(parent);
      return;
    }
    this.#appendDetailLine(parent, `type: ${type}`);
    const bulk = (snapshot.auth ?? "").trim();
    if (bulk) this.#appendDetailBulkLines(parent, bulk);
  }

  /** Render each non-empty line of a bulk-format string as an indented row. */
  #appendDetailBulkLines(parent, bulk) {
    for (const line of bulk.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      this.#appendDetailLine(parent, t, !t.startsWith("# "));
    }
  }

  #appendDetailLine(parent, text, enabled = true) {
    const el = document.createElement("div");
    el.className =
      "timeline-detail-kv" + (enabled ? "" : " timeline-detail-kv--disabled");
    el.textContent = text;
    parent.appendChild(el);
  }

  // ── Timestamp updater ─────────────────────────────────────────────────────

  startTimestampUpdater() {
    this.stopTimestampUpdater();
    this.#timestampTimer = setInterval(
      () => this.#updateTimestampLabels(),
      10_000,
    );
    // This background "Xs ago" ticker must never keep a process alive: under
    // `node --test` (jsdom) a viewer left on the timeline tab would otherwise
    // hang the runner forever. unref() exists on Node's Timeout; in the
    // Electron/Chromium renderer setInterval returns a number, so the optional
    // call is a harmless no-op there (the interval still fires every 10s).
    this.#timestampTimer?.unref?.();
  }

  stopTimestampUpdater() {
    if (this.#timestampTimer !== null) {
      clearInterval(this.#timestampTimer);
      this.#timestampTimer = null;
    }
  }

  #updateTimestampLabels() {
    const pane = this.#getPane();
    if (!pane) return;
    pane.querySelectorAll(".timeline-item").forEach((item, idx) => {
      const entry = this.#timelineEntries[idx];
      if (!entry) return;
      const tsEl = item.querySelector(".timeline-timestamp");
      if (tsEl) tsEl.textContent = this.#formatTimestamp(entry.timestamp);
    });
  }

  #formatTimestamp(ts) {
    if (!ts) return "";
    const delta = Date.now() - ts;
    const secs = delta / 1000;
    const mins = secs / 60;

    if (secs < 10) return t("response.time.justNow");
    if (mins < 1) return t("response.time.lessThanMinute");
    if (mins < 5) return t("response.time.last5Minutes");
    if (mins < 30) return t("response.time.lastHalfHour");
    if (mins < 60) return t("response.time.lastHour");

    const then = new Date(ts);
    const todayMid = new Date();
    todayMid.setHours(0, 0, 0, 0);
    const thenMid = new Date(then);
    thenMid.setHours(0, 0, 0, 0);
    const daysDiff = Math.round((todayMid - thenMid) / 86400000);

    if (daysDiff === 0) return t("response.time.today");
    if (daysDiff === 1) return t("response.time.yesterday");

    // Start of the current calendar week (Sunday = day 0)
    const weekStart = new Date(todayMid);
    weekStart.setDate(todayMid.getDate() - todayMid.getDay());
    if (thenMid >= weekStart) return t("response.time.thisWeek");

    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    if (thenMid >= lastWeekStart) return t("response.time.lastWeek");

    // Older than two weeks: a fully locale-formatted absolute date/time (Intl
    // handles weekday/month names, ordinals, and 12/24-hour clock per locale).
    return formatDate(then, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}
