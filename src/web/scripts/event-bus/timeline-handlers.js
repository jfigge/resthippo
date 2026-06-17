/**
 * timeline-handlers.js — non-destructive run-history (timeline) event-bus
 * handlers: view a past run, delete one entry, and clear a request's history.
 *
 * The destructive `wurl:timeline-restore` handler (which replays a snapshot
 * back into the editor and mutates the selected node) stays in app.js with the
 * request-lifecycle core; these three only read the selected node and mutate
 * the history maps, so they live here and reach shared state through the bus
 * context (`ctx`, built by buildBusContext() in app.js).
 *
 * @param {object} ctx
 * @param {(requestUrl: string, response: object) => void} ctx.viewTimelineResponse
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
  window.addEventListener("wurl:timeline-select", (e) => {
    const { requestUrl = "", response } = e.detail;
    ctx.viewTimelineResponse(requestUrl, response);
  });

  // Remove a single timeline entry (the ✕ on a timeline row). Updates the
  // in-memory list, deletes the on-disk metadata + response payload, then
  // re-dispatches so the timeline pane re-renders.
  window.addEventListener("wurl:timeline-delete-entry", (e) => {
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
  window.addEventListener("wurl:timeline-clear", (e) => {
    const requestId = e.detail?.requestId;
    if (!requestId) return;
    ctx.requestHistory.set(requestId, []);
    ctx.historyLoaded.add(requestId);
    ctx.clearHistory(requestId);
    if (requestId === ctx.getSelectedNode()?.id)
      ctx.dispatchTimelineUpdate(requestId);
  });
}
