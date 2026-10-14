/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * timeline-handlers.js — non-destructive run-history (timeline) event-bus
 * handlers: view a past run, delete one entry, and clear a request's history.
 *
 * The destructive `hippo:timeline-restore` handler (which replays a snapshot
 * back into the editor and mutates the selected node) stays in app.js with the
 * request-lifecycle core; these three only read the selected node and mutate
 * the history maps, so they live here and reach shared state through the bus
 * context (`ctx`, built by buildBusContext() in app.js).
 *
 * @param {object} ctx
 * @param {(requestUrl: string, response: object, timestamp?: number|null) => void} ctx.viewTimelineResponse
 * @param {Map} ctx.requestHistory                per-request in-memory history
 * @param {Set} ctx.historyLoaded                 request ids whose history is loaded
 * @param {Function} ctx.deleteHistory            delete one on-disk history entry
 * @param {Function} ctx.clearHistory             remove all on-disk history for a request
 * @param {Function} ctx.dispatchTimelineUpdate
 * @param {() => object|null} ctx.getSelectedNode
 */
export function installTimelineHandlers(ctx) {
  // Selecting a timeline entry is non-destructive: show its response, but leave
  // the live request editor untouched (the snapshot is shown in the timeline
  // detail panel instead).
  window.addEventListener("hippo:timeline-select", (e) => {
    const { requestUrl = "", response, timestamp = null } = e.detail;
    ctx.viewTimelineResponse(requestUrl, response, timestamp);
  });

  // Remove a single timeline entry (the ✕ on a timeline row). Updates the
  // in-memory list, deletes the on-disk metadata + response payload, then
  // re-dispatches so the timeline pane re-renders.
  window.addEventListener("hippo:timeline-delete-entry", (e) => {
    const { requestId, historyId } = e.detail ?? {};
    if (!requestId || !historyId) return;
    const entries = ctx.requestHistory.get(requestId);
    if (entries) {
      const idx = entries.findIndex((en) => en.id === historyId);
      if (idx >= 0) entries.splice(idx, 1);
    }
    ctx.deleteHistory(requestId, historyId);
    if (requestId === ctx.getSelectedNode()?.id)
      ctx.dispatchTimelineUpdate(requestId);
  });

  // Clear a request's entire run history. Fired by the "Delete All" button on
  // the latest timeline entry and by the tree "Clear Run History" context item.
  // Removes every on-disk history + response file for the request.
  window.addEventListener("hippo:timeline-clear", (e) => {
    const requestId = e.detail?.requestId;
    if (!requestId) return;
    ctx.requestHistory.set(requestId, []);
    ctx.historyLoaded.add(requestId);
    ctx.clearHistory(requestId);
    if (requestId === ctx.getSelectedNode()?.id)
      ctx.dispatchTimelineUpdate(requestId);
  });
}
