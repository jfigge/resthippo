/**
 * settings-handlers.js — settings, theme, and history-trim event-bus handlers.
 *
 * All of these persist a settings delta and/or re-apply settings to the live
 * DOM. They reach shared state and the settings popup through the bus context
 * (`ctx`, built by buildBusContext() in app.js). See the hippo:* registry at the
 * top of app.js for payload shapes.
 *
 * @param {object} ctx
 * @param {() => object} ctx.getSettings          live currentSettings
 * @param {(delta: object) => any} ctx.updateSettings  merge + persist a delta (returns the save result)
 * @param {(settings: object) => void} ctx.applySettings  re-apply settings to the DOM
 * @param {(vars: object) => void} ctx.applyCustomThemeVars  preview custom theme vars
 * @param {object} ctx.settingsPopup              the SettingsPopup singleton
 * @param {() => number} ctx.getMaxHistory
 * @param {(n: number) => void} ctx.setMaxHistory
 * @param {Map} ctx.requestHistory                per-request in-memory history
 * @param {Function} ctx.deleteHistory            delete one on-disk history entry
 * @param {Function} ctx.trimHistory              sweep on-disk history to the max
 * @param {Function} ctx.dispatchTimelineUpdate
 * @param {() => object|null} ctx.getSelectedNode
 */
export function installSettingsHandlers(ctx) {
  // Persist settings immediately whenever any control in the popup changes.
  // Merge into currentSettings so fields not emitted by the popup (splitters,
  // selectedRequestIds, historyCount) are not silently dropped on each save.
  window.addEventListener("hippo:settings-changed", (e) => {
    const prevLocale = ctx.getSettings().locale ?? "system";
    const saved = ctx.updateSettings(e.detail);
    ctx.applySettings(ctx.getSettings());
    if (e.detail.historyCount !== undefined) {
      ctx.setMaxHistory(e.detail.historyCount);
    }
    // A language change can't be retro-applied to already-rendered, imperatively
    // built DOM piecemeal, so reload the window: every string re-resolves against
    // the new catalog at startup (main reads settings.locale — hence the reload
    // waits for the save to settle). Settings persist above and request edits
    // autosave, so the reload loses nothing.
    if (e.detail.locale !== undefined && e.detail.locale !== prevLocale) {
      Promise.resolve(saved).finally(() => window.location.reload());
    }
  });

  // Trim all per-request histories to the new max (fired only on settings Close click)
  window.addEventListener("hippo:history-trim", (e) => {
    const max = Math.max(
      0,
      Math.min(10, e.detail?.historyCount ?? ctx.getMaxHistory()),
    );
    ctx.setMaxHistory(max);
    for (const [id, entries] of ctx.requestHistory.entries()) {
      while (entries.length > max) {
        const old = entries.pop();
        if (old?.id) ctx.deleteHistory(id, old.id);
      }
      if (max === 0) ctx.requestHistory.delete(id);
    }
    // Sweep on-disk history for requests not yet loaded into requestHistory.
    ctx.trimHistory(max).catch(console.error);
    ctx.dispatchTimelineUpdate(ctx.getSelectedNode()?.id);
  });

  window.addEventListener("hippo:theme-preview", (e) => {
    if (e.detail) ctx.applyCustomThemeVars(e.detail);
    else ctx.applySettings(ctx.getSettings());
  });

  window.addEventListener("hippo:custom-themes-changed", (e) => {
    ctx.updateSettings({ customThemes: e.detail });
    ctx.settingsPopup.refreshThemeList(e.detail);
  });

  window.addEventListener("hippo:theme-apply", (e) => {
    ctx.updateSettings({ theme: e.detail });
    ctx.applySettings(ctx.getSettings());
    ctx.settingsPopup.load({
      theme: e.detail,
      customThemes: ctx.getSettings().customThemes,
    });
  });

  // When the request editor fires a preference change (e.g. List Headers toggle),
  // merge into currentSettings and persist.
  window.addEventListener("hippo:editor-setting-changed", (e) => {
    ctx.updateSettings(e.detail);
  });
}
