/* icons.js — single source of truth for inline SVG icons.
 *
 * Every icon in the UI is built from this registry so that path data lives in
 * exactly one place. Components import `icon(name, opts)` and render the
 * returned markup string into a template literal, exactly as they did with the
 * old hand-inlined `const ICON_* = \`<svg…>\`` blocks.
 *
 * House style for line icons: viewBox "0 0 24 24", fill none, stroke
 * currentColor, stroke-width 2, round caps/joins. An icon may override any of
 * these per-entry (e.g. the solid caret and drag dots are fill-only).
 *
 *   icon("check")                       → 16px check at the house stroke-width
 *   icon("trash", { size: 13 })         → 13px trash
 *   icon("folderClosed", { size: 14, className: "tree-folder-icon" })
 */

// Per-icon inner markup plus any overrides of the line-icon defaults.
const ICONS = {
  // ── Entity / action glyphs ────────────────────────────────────────────────
  check: {
    inner: '<polyline points="20 6 9 17 4 12"/>',
    strokeWidth: 2.5,
  },
  // Pencil — used for both "rename" and "edit" affordances.
  rename: {
    inner:
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
      '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  },
  // Question mark in a circle — the armed state of a trash delete awaiting a
  // confirming second click (see delete-confirm.js).
  question: {
    inner:
      '<circle cx="12" cy="12" r="10"/>' +
      '<path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>',
  },
  // Diagonal X — close buttons and entity-delete glyphs.
  close: {
    inner:
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '<line x1="18" y1="6" x2="6" y2="18"/>',
  },
  // Waste bin — per-row data deletion (distinct from the close X).
  trash: {
    inner:
      '<polyline points="3 6 5 6 21 6"/>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      '<line x1="10" y1="11" x2="10" y2="17"/>' +
      '<line x1="14" y1="11" x2="14" y2="17"/>',
  },
  add: {
    inner:
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>',
  },
  copy: {
    inner:
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  },
  // Curly braces "{ }" — marks a path-parameter row (vs the query checkbox).
  braces: {
    inner:
      '<path d="M8 3a3 3 0 0 0-3 3v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a3 3 0 0 0 3 3"/>' +
      '<path d="M16 3a3 3 0 0 1 3 3v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a3 3 0 0 1-3 3"/>',
  },
  // "Aa" lettering — marks a form-data row as a plain TEXT field. Drawn as a
  // filled glyph (not strokes); inherits the surrounding UI font.
  text: {
    inner:
      '<text x="12" y="13" text-anchor="middle" dominant-baseline="central"' +
      ' font-size="22.5" font-weight="400">Aa</text>',
    fill: "currentColor",
    stroke: "none",
  },
  // Document with a folded corner — marks a form-data row as a FILE upload.
  file: {
    inner:
      '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>' +
      '<polyline points="13 2 13 9 20 9"/>',
  },
  // "{ }" braces — marks a WebSocket message as JSON. Drawn as a filled glyph
  // like `text` so the two states of the format toggle read as a matched pair.
  json: {
    inner:
      '<text x="12" y="12" text-anchor="middle" dominant-baseline="central"' +
      ' font-size="24" font-weight="800">{ }</text>',
    fill: "currentColor",
    stroke: "none",
  },
  // Open eye — the "reveal" affordance on a masked secret field.
  eye: {
    inner:
      '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>' +
      '<circle cx="12" cy="12" r="3"/>',
  },
  // Eye with a slash — the "hide" affordance once a secret is revealed.
  eyeOff: {
    inner:
      '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>',
  },
  // Closed padlock — marks a variable as secure (encrypted at rest).
  lock: {
    inner:
      '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  },
  // Open padlock — the "not secure" state of the per-row secure toggle.
  lockOpen: {
    inner:
      '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
      '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  },

  // ── Notification levels (toast glyphs) ────────────────────────────────────
  // Filled circle with an exclamation — error toasts.
  error: {
    inner:
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="8" x2="12" y2="12"/>' +
      '<line x1="12" y1="16" x2="12.01" y2="16"/>',
  },
  // Triangle with an exclamation — warning toasts.
  warning: {
    inner:
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>',
  },
  // Circle with an "i" — informational toasts.
  info: {
    inner:
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="16" x2="12" y2="12"/>' +
      '<line x1="12" y1="8" x2="12.01" y2="8"/>',
  },

  // ── Tree folders ──────────────────────────────────────────────────────────
  folderClosed: {
    inner:
      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  },
  folderOpen: {
    inner:
      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' +
      '<polyline points="2 10 12 10 17 15 22 10"/>',
  },

  // ── Directional chevrons (stroked) ────────────────────────────────────────
  chevronUp: {
    inner: '<polyline points="18 15 12 9 6 15"/>',
    strokeWidth: 2.5,
  },
  chevronDown: {
    inner: '<polyline points="6 9 12 15 18 9"/>',
    strokeWidth: 2.5,
  },

  // ── Filled affordances ────────────────────────────────────────────────────
  // Solid down-caret used by dropdown selects. Sized by CSS (6×4) so callers
  // typically pass { size: null } to omit width/height attributes.
  caret: {
    inner: '<path d="M0 0 6 0 3 4Z"/>',
    viewBox: "0 0 6 4",
    fill: "currentColor",
    stroke: "none",
  },
  // Six-dot vertical drag affordance.
  drag: {
    inner:
      '<circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/>' +
      '<circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/>' +
      '<circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>',
    viewBox: "0 0 10 16",
    fill: "currentColor",
    stroke: "none",
  },
  // Bottom-right corner grip on resizable popups.
  resizeGrip: {
    inner:
      '<circle cx="9" cy="9" r="1.4"/><circle cx="5" cy="9" r="1.4"/>' +
      '<circle cx="9" cy="5" r="1.4"/>',
    viewBox: "0 0 10 10",
    fill: "currentColor",
    stroke: "none",
  },
  // ── Layout / pane-split glyphs ────────────────────────────────────────────
  // Frame split into two side-by-side columns — "place panes side by side".
  columns: {
    inner:
      '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
      '<line x1="12" y1="4" x2="12" y2="20"/>',
  },
  // Frame split into two stacked rows — "stack panes top and bottom".
  rows: {
    inner:
      '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
      '<line x1="3" y1="12" x2="21" y2="12"/>',
  },
};

/**
 * Build an inline SVG markup string for a named icon.
 *
 * @param {string} name  Key into the icon registry.
 * @param {object} [opts]
 * @param {number|null} [opts.size=16]  width & height in px; pass null to omit
 *                                      both attributes (let CSS size it).
 * @param {number} [opts.width]         override width independently of size.
 * @param {number} [opts.height]        override height independently of size.
 * @param {number} [opts.strokeWidth]   override the stroke width.
 * @param {string} [opts.className]     class attribute for the <svg>.
 * @returns {string} SVG markup.
 */
export function icon(name, opts = {}) {
  const def = ICONS[name];
  if (!def) throw new Error(`icons.js: unknown icon "${name}"`);

  const viewBox = def.viewBox ?? "0 0 24 24";
  const fill = def.fill ?? "none";
  const stroke = def.stroke ?? "currentColor";
  const strokeWidth = opts.strokeWidth ?? def.strokeWidth ?? 2;

  const size = opts.size === undefined ? 16 : opts.size;
  const width = opts.width ?? size;
  const height = opts.height ?? size;

  const clsAttr = opts.className ? ` class="${opts.className}"` : "";
  const sizeAttr =
    width == null && height == null
      ? ""
      : ` width="${width}" height="${height}"`;
  const strokeAttr =
    stroke === "none"
      ? ""
      : ` stroke="${stroke}" stroke-width="${strokeWidth}"` +
        ` stroke-linecap="round" stroke-linejoin="round"`;

  return (
    `<svg${clsAttr}${sizeAttr} viewBox="${viewBox}"` +
    ` fill="${fill}"${strokeAttr} aria-hidden="true">${def.inner}</svg>`
  );
}
