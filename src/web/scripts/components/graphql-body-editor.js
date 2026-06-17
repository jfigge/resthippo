/**
 * graphql-body-editor.js — the GraphQL request-body composer.
 *
 * Extracted verbatim (behaviour-preserving) from RequestEditor: a Query +
 * Variables split-pane editor with schema-aware autocomplete, live validation
 * (syntax always; full schema checks once an introspection schema is fetched), a
 * drag/keyboard splitter whose orientation follows the app layout, and a
 * schema-status badge offering View / Download of the loaded schema.
 *
 * The host (RequestEditor) injects the few things that are genuinely its own:
 *   • makeCodeEditor(opts)   — the shared PillCodeEditor factory (the Query and
 *       Variables panes register in the host's #codeEditors set, so a variable-
 *       context / view-setting change reaches them; the host also destroys them
 *       on body re-render).
 *   • getLayout()            — current app layout (1–4), for split orientation.
 *   • persistSetting(detail) — persist a UI preference (splitter fraction).
 *   • onChange()             — the host's debounced "request body changed" hook.
 *   • fetchIntrospection()   — POST the introspection query using the *current*
 *       request (URL / params / headers / auth) and return the JSON, or null when
 *       aborted upstream (e.g. no URL — the host surfaces that itself). Keeping
 *       this request-coupled step in the host is what keeps the boundary clean.
 *   • getPickerDebounceMs()  — autocomplete-popup debounce.
 */
"use strict";

import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { Notifications } from "../notifications.js";
import { AutocompleteDropdown } from "./kv-editor-shared.js";
import { buildSchemaModel, suggestAtCursor } from "./graphql-schema.js";
import {
  validateGraphQLQuery,
  introspectionToSDL,
} from "./graphql-validate.js";
import { GraphQLSchemaViewer } from "./graphql-schema-viewer.js";

// One shared schema-field autocomplete dropdown (a sibling of the header-name /
// header-value dropdowns) and a single off-screen caret anchor element it pins to.
const _gqlAc = new AutocompleteDropdown(
  "hdr-autocomplete gql-autocomplete",
  "GraphQL suggestions",
);

// px floor for each GraphQL pane when the splitter is dragged/derived — keeps
// both the Query and Variables panes usable no matter how the container resizes.
const GQL_PANE_MIN = 64;

let _gqlCaretAnchor = null;
function _gqlAnchorAt({ left, top, height }) {
  if (!_gqlCaretAnchor) {
    _gqlCaretAnchor = document.createElement("div");
    _gqlCaretAnchor.className = "gql-caret-anchor";
    _gqlCaretAnchor.setAttribute("aria-hidden", "true");
    document.body.appendChild(_gqlCaretAnchor);
  }
  const s = _gqlCaretAnchor.style;
  s.position = "fixed";
  s.width = "0";
  s.pointerEvents = "none";
  s.left = `${left}px`;
  s.top = `${top}px`;
  s.height = `${height}px`;
  return _gqlCaretAnchor;
}

/**
 * The Query/Variables split orientation for an app layout. The side-by-side
 * layout (1) puts the editor in a narrow column, so the panes stack ("column",
 * a horizontal splitter); every wider layout places them side by side ("row").
 */
function flowForLayout(layout) {
  return Number(layout) === 1 ? "column" : "row";
}

export class GraphQLBodyEditor {
  #deps;

  // ── Content + schema state (survives mount/unmount; reset on load) ───────────
  #query = "";
  #variables = "";
  #schema = null; // buildSchemaModel() result, or null until fetched
  #introspection = null; // raw introspection ({ __schema }) for graphql-js validation
  #fetching = false; // guards against concurrent "Fetch schema" clicks
  #revalidateQuery = null; // re-run query validation, or null while unmounted
  #removeHeaders = false;

  // ── Split-layout prefs (session-level; per orientation) ──────────────────────
  #flow = "row"; // "row" = side by side, "column" = stacked
  #varsSize = { column: null, row: null }; // Variables-pane share as a fraction

  // ── Per-mount DOM refs ───────────────────────────────────────────────────────
  #pane = null;
  #bodyTypeBar = null;
  #wrap = null;
  #splitter = null;
  #varsPane = null;
  #resizeObserver = null;
  #statusBadge = null;
  #fetchBtn = null;

  constructor(deps) {
    this.#deps = deps;
  }

  // ── Content API ──────────────────────────────────────────────────────────────

  /** @param {{ query?: string, variables?: string }} value */
  setValue({ query = "", variables = "" } = {}) {
    this.#query = query;
    this.#variables = variables;
  }

  /** @returns {{ query: string, variables: string }} */
  getValue() {
    return { query: this.#query, variables: this.#variables };
  }

  /** Clear the per-request introspection schema (called by the host on load). */
  reset() {
    this.#schema = null;
    this.#introspection = null;
  }

  // ── Layout / settings hooks ──────────────────────────────────────────────────

  /** Re-orient the split when the app layout changes (in place when mounted). */
  onLayoutChanged(layout) {
    const flow = flowForLayout(layout);
    if (flow === this.#flow) return;
    if (this.#wrap) this.#applyFlow(flow);
    else this.#flow = flow;
  }

  /**
   * Restore the persisted Variables-pane fraction for one orientation.
   * @returns {boolean} whether it changed (so the host can re-render if mounted)
   */
  setVarsFraction(flow, val) {
    const frac = typeof val === "number" && val > 0 && val < 1 ? val : null;
    if (frac === this.#varsSize[flow]) return false;
    this.#varsSize[flow] = frac;
    return true;
  }

  /** Show/hide the Query/Variables pane labels to match the removeHeaders setting. */
  setRemoveHeaders(on) {
    this.#removeHeaders = !!on;
    this.#applyHeaderRows();
  }

  // ── Mount / unmount ──────────────────────────────────────────────────────────

  /**
   * Render the composer into `bodyPaneEl`, and its schema status/fetch cluster
   * into `bodyTypeBar` (the body-type picker row, when present).
   */
  mount(bodyPaneEl, bodyTypeBar) {
    this.#pane = bodyPaneEl;
    this.#bodyTypeBar = bodyTypeBar ?? null;

    // Type-bar controls, left to right: a spacer, a schema-status icon, and the
    // "Fetch schema" button. The icon is empty until a fetch runs, then a green
    // tick (carrying the View / Download menu) or a red X.
    let statusBadge = null;
    if (this.#bodyTypeBar) {
      const spacer = document.createElement("span");
      spacer.className = "body-graphql-bar-spacer";
      this.#bodyTypeBar.appendChild(spacer);

      statusBadge = document.createElement("span");
      statusBadge.className = "body-graphql-status";
      statusBadge.setAttribute("aria-live", "polite");
      if (this.#schema) this.#markBadgeLoaded(statusBadge);

      statusBadge.addEventListener("contextmenu", (e) => {
        if (!this.#introspection) return;
        e.preventDefault();
        e.stopPropagation();
        this.#showSchemaContextMenu(e.clientX, e.clientY);
      });
      this.#bodyTypeBar.appendChild(statusBadge);

      const fetchBtn = document.createElement("button");
      fetchBtn.className =
        "params-toolbar-btn params-delete-all-btn body-graphql-fetch-btn";
      fetchBtn.textContent = t("request.graphql.fetchSchema");
      fetchBtn.title = t("request.graphql.fetchSchemaTitle");
      fetchBtn.addEventListener("click", () => this.#fetchSchema());
      this.#bodyTypeBar.appendChild(fetchBtn);
      this.#fetchBtn = fetchBtn;
    }
    this.#statusBadge = statusBadge;

    const wrap = document.createElement("div");
    wrap.className = "body-graphql";

    // ── Query pane (GraphQL, with schema-aware autocomplete) ──────────────────
    const queryPane = document.createElement("div");
    queryPane.className = "body-graphql-pane body-graphql-pane--query";
    const queryLabel = document.createElement("div");
    queryLabel.className = "body-graphql-pane-label";
    queryLabel.textContent = t("request.graphql.query");
    const queryBadge = document.createElement("span");
    queryBadge.className = "body-validate-badge body-graphql-query-badge";
    queryBadge.setAttribute("aria-live", "polite");
    const SCHEMA_WARN =
      "Validation is limited until the schema has been fetched";
    const queryWarn = document.createElement("span");
    queryWarn.className = "body-graphql-schema-warn";
    queryWarn.innerHTML = icon("warning", { size: 12 });
    queryWarn.title = SCHEMA_WARN;
    queryWarn.setAttribute("aria-label", SCHEMA_WARN);
    queryWarn.hidden = true;
    const queryStatus = document.createElement("span");
    queryStatus.className = "body-graphql-query-status";
    queryBadge.append(queryWarn, queryStatus);
    queryLabel.appendChild(queryBadge);
    queryPane.appendChild(queryLabel);

    const applyQueryValidity = (state, title) => {
      queryBadge.dataset.state = state ?? "";
      queryStatus.textContent =
        state === "valid"
          ? t("request.graphql.valid")
          : state === "invalid"
            ? t("request.graphql.invalid")
            : "";
      queryStatus.title = title ?? "";
      queryWarn.hidden = !state || Boolean(this.#introspection);
    };
    const runQueryValidation = (text) => {
      const { errors, schemaChecked } = validateGraphQLQuery(
        text,
        this.#introspection,
      );
      q?.setErrors(
        errors.map((e) => ({
          line: e.line,
          col: e.column,
          length: Math.max(1, (e.end ?? 0) - (e.start ?? 0)),
          message: e.message,
        })),
      );
      if (!text.trim()) {
        applyQueryValidity(null, "");
      } else if (errors.length) {
        const n = errors.length;
        applyQueryValidity(
          "invalid",
          `${n} error${n > 1 ? "s" : ""}:\n` +
            errors
              .map((e) => `  ${e.line}:${e.column}  ${e.message}`)
              .join("\n"),
        );
      } else {
        applyQueryValidity(
          "valid",
          schemaChecked
            ? "Query is valid against the schema"
            : "Query syntax is valid — fetch the schema for full validation",
        );
      }
    };
    let qValidateTimer = null;
    const scheduleQueryValidation = (text) => {
      clearTimeout(qValidateTimer);
      qValidateTimer = setTimeout(() => runQueryValidation(text), 400);
    };

    let q;
    q = this.#deps.makeCodeEditor({
      language: "graphql",
      externalErrors: true,
      richErrors: true,
      value: this.#query,
      placeholder: "query {\n  …\n}",
      onInput: (v) => {
        this.#query = v;
        this.#deps.onChange();
        scheduleQueryValidation(v);
        q?._gqlRefresh?.();
      },
      onCaret: () => q?._gqlRefresh?.(),
    });
    queryPane.appendChild(q.element);
    this.#wireAutocomplete(q);
    this.#revalidateQuery = () => runQueryValidation(this.#query);
    wrap.appendChild(queryPane);

    // ── Splitter — drag to resize Query vs Variables ──────────────────────────
    const splitter = document.createElement("div");
    splitter.className = "splitter body-graphql-splitter";
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-label", t("request.graphql.resizeAria"));
    splitter.tabIndex = 0;
    wrap.appendChild(splitter);

    // ── Variables pane (JSON, validated) ──────────────────────────────────────
    const varsPane = document.createElement("div");
    varsPane.className = "body-graphql-pane body-graphql-pane--vars";
    const varsHeader = document.createElement("div");
    varsHeader.className = "body-graphql-pane-label";
    varsHeader.textContent = t("common.variables");
    const varsBadge = document.createElement("span");
    varsBadge.className = "body-validate-badge body-graphql-vars-badge";
    varsBadge.setAttribute("aria-live", "polite");
    varsHeader.appendChild(varsBadge);
    varsPane.appendChild(varsHeader);

    const applyVarsValidity = (state) => {
      varsBadge.dataset.state = state ?? "";
      if (state === "valid") {
        varsBadge.textContent = "✓ VALID";
        varsBadge.title = t("request.graphql.varsValid");
      } else if (state === "invalid") {
        varsBadge.textContent = t("request.graphql.invalid");
        varsBadge.title = t("request.graphql.varsInvalid");
      } else {
        varsBadge.textContent = "";
        varsBadge.title = "";
      }
    };

    const v = this.#deps.makeCodeEditor({
      language: "json",
      richErrors: true,
      value: this.#variables,
      placeholder: '{\n  "key": "value"\n}',
      onInput: (val) => {
        this.#variables = val;
        this.#deps.onChange();
      },
    });
    v.element.addEventListener("pce:validity", (e) => {
      const s = e.detail?.state; // true | false | null
      applyVarsValidity(s == null ? null : s ? "valid" : "invalid");
    });
    varsPane.appendChild(v.element);
    wrap.appendChild(varsPane);

    this.#wrap = wrap;
    this.#splitter = splitter;
    this.#varsPane = varsPane;

    this.#pane.appendChild(wrap);
    this.#applyHeaderRows();
    this.#applyFlow(flowForLayout(this.#deps.getLayout()));
    this.#wireSplitter(splitter, varsPane, wrap);
    this.#resizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() =>
        this.#applyVarsSize(varsPane, wrap),
      );
      this.#resizeObserver.observe(wrap);
    }

    v.revalidate();
    this.#revalidateQuery?.();
  }

  /**
   * Tear down the per-mount DOM (badge/button in the body-type bar, the resize
   * observer, the autocomplete popup, element refs). The Query/Variables code
   * editors are owned by the host's #codeEditors set and destroyed there.
   */
  unmount() {
    this.#bodyTypeBar?.querySelector(".body-graphql-fetch-btn")?.remove();
    this.#bodyTypeBar?.querySelector(".body-graphql-status")?.remove();
    this.#bodyTypeBar?.querySelector(".body-graphql-bar-spacer")?.remove();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#wrap = null;
    this.#splitter = null;
    this.#varsPane = null;
    this.#statusBadge = null;
    this.#fetchBtn = null;
    this.#revalidateQuery = null;
    _gqlAc.hide();
  }

  // ── Split orientation / sizing ───────────────────────────────────────────────

  /**
   * Apply the split orientation to the container, splitter, and Variables pane,
   * in place. "row" = side by side (vertical splitter, drag ↔); "column" =
   * stacked (horizontal splitter, drag ↕).
   */
  #applyFlow(flow) {
    this.#flow = flow;
    const wrap = this.#wrap;
    const splitter = this.#splitter;
    if (!wrap || !splitter) return;
    const row = flow === "row";
    wrap.classList.toggle("body-graphql--row", row);
    splitter.classList.toggle("splitter--h", row);
    splitter.classList.toggle("splitter--v", !row);
    splitter.setAttribute("aria-orientation", row ? "vertical" : "horizontal");
    this.#applyVarsSize(this.#varsPane, wrap);
  }

  /**
   * Size the Variables pane from the stored fraction of the container's main axis
   * (width when side by side, height when stacked), clamped so neither pane
   * collapses. With no stored fraction the explicit basis is cleared so the CSS
   * flex ratio applies.
   */
  #applyVarsSize(varsPane, wrap) {
    const frac = this.#varsSize[this.#flow];
    if (frac == null) {
      varsPane.style.flex = "";
      return;
    }
    const total = this.#flow === "row" ? wrap.clientWidth : wrap.clientHeight;
    if (total <= 0) return; // not laid out yet — a later resize callback sizes it
    const max = Math.max(GQL_PANE_MIN, total - GQL_PANE_MIN);
    const px = Math.min(max, Math.max(GQL_PANE_MIN, frac * total));
    varsPane.style.flex = `0 0 ${px}px`;
  }

  /** Make the splitter draggable + keyboard-resizable on the active axis. */
  #wireSplitter(splitterEl, varsPane, wrap) {
    const isRow = () => this.#flow === "row";
    const apply = (size) => {
      const total = isRow() ? wrap.clientWidth : wrap.clientHeight;
      if (total <= 0) return;
      const max = Math.max(GQL_PANE_MIN, total - GQL_PANE_MIN);
      const clamped = Math.min(max, Math.max(GQL_PANE_MIN, size));
      this.#varsSize[this.#flow] = clamped / total;
      varsPane.style.flex = `0 0 ${clamped}px`;
    };
    const pointerPos = (e) => {
      const src = e.touches ? e.touches[0] : e;
      return isRow() ? src.clientX : src.clientY;
    };
    const varsExtent = () => {
      const rect = varsPane.getBoundingClientRect();
      return isRow() ? rect.width : rect.height;
    };

    let dragging = false;
    let start = 0;
    let startSize = 0;

    const onMove = (e) => {
      if (!dragging) return;
      if (e.cancelable) e.preventDefault();
      apply(startSize - (pointerPos(e) - start)); // toward start → grows Variables
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      splitterEl.classList.remove("splitter--dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      this.#persistVarsFraction();
    };
    const onStart = (e) => {
      e.preventDefault();
      dragging = true;
      start = pointerPos(e);
      startSize = varsExtent();
      splitterEl.classList.add("splitter--dragging");
      document.body.style.cursor = isRow() ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    };

    splitterEl.addEventListener("mousedown", (e) => {
      onStart(e);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
    });
    splitterEl.addEventListener(
      "touchstart",
      (e) => {
        onStart(e);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onEnd);
      },
      { passive: false },
    );

    splitterEl.addEventListener("keydown", (e) => {
      const growKey = isRow() ? "ArrowLeft" : "ArrowUp";
      const shrinkKey = isRow() ? "ArrowRight" : "ArrowDown";
      if (e.key !== growKey && e.key !== shrinkKey) return;
      e.preventDefault();
      const step = e.shiftKey ? 48 : 16;
      apply(varsExtent() + (e.key === growKey ? step : -step));
      this.#persistVarsFraction();
    });
  }

  /** Persist the Variables-pane fraction for the current orientation. */
  #persistVarsFraction() {
    const key =
      this.#flow === "row"
        ? "graphqlVarsFractionRow"
        : "graphqlVarsFractionColumn";
    this.#deps.persistSetting({ [key]: this.#varsSize[this.#flow] });
  }

  /** Show/hide the Query/Variables pane labels to match removeHeaders. */
  #applyHeaderRows() {
    this.#pane?.querySelectorAll(".body-graphql-pane-label").forEach((hdr) => {
      hdr.style.display = this.#removeHeaders ? "none" : "";
    });
  }

  // ── Schema-aware autocomplete ────────────────────────────────────────────────

  #wireAutocomplete(editor) {
    const showSuggestions = () => {
      if (!this.#schema || editor.isPickerOpen()) {
        _gqlAc.hide();
        return;
      }
      const pos = editor.getCaretOffset();
      if (pos < 0) {
        _gqlAc.hide();
        return;
      }
      const res = suggestAtCursor(editor.getValue(), pos, this.#schema);
      const coords = res ? editor.caretCoords() : null;
      if (!res || !coords) {
        _gqlAc.hide();
        return;
      }
      const anchor = _gqlAnchorAt(coords);
      _gqlAc.show(
        anchor,
        res.items,
        (label) => this.#applySuggestion(editor, label),
        {
          minWidth: 220,
          renderItem: (item, entry) => {
            item.dataset.value = entry.label;
            item.innerHTML = "";
            const name = document.createElement("span");
            name.className = "gql-ac-name";
            name.textContent = entry.label;
            item.appendChild(name);
            if (entry.detail) {
              const detail = document.createElement("span");
              detail.className = "gql-ac-detail";
              detail.textContent = entry.detail;
              item.appendChild(detail);
            }
          },
        },
      );
    };

    let acTimer = null;
    const cancelRefresh = () => {
      clearTimeout(acTimer);
      acTimer = null;
    };
    const refresh = () => {
      cancelRefresh();
      if (_gqlAc.visible) showSuggestions();
      else
        acTimer = setTimeout(showSuggestions, this.#deps.getPickerDebounceMs());
    };
    editor._gqlRefresh = refresh;

    editor.element.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") cancelRefresh();
        if (!_gqlAc.visible || editor.isPickerOpen()) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          _gqlAc.navigate(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          _gqlAc.navigate(-1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          _gqlAc.hide();
        } else if (e.key === "Enter" || e.key === "Tab") {
          const label = _gqlAc.activeLabel();
          if (label !== null) {
            e.preventDefault();
            this.#applySuggestion(editor, label);
          }
        }
      },
      true,
    );

    editor.element.addEventListener("focusout", () => {
      cancelRefresh();
      _gqlAc.scheduleHide();
    });
  }

  /** Replace the identifier being typed at the caret with the chosen suggestion. */
  #applySuggestion(editor, label) {
    const value = editor.getValue();
    const pos = editor.getCaretOffset();
    if (pos < 0) {
      _gqlAc.hide();
      return;
    }
    const before = value.slice(0, pos);
    const m = /[_A-Za-z][_A-Za-z0-9]*$/.exec(before);
    const start = m ? pos - m[0].length : pos;
    editor.replaceRange(start, pos, label);
    _gqlAc.hide();
    this.#revalidateQuery?.();
  }

  // ── Schema fetch / view / download ───────────────────────────────────────────

  /**
   * Fetch + cache the introspection schema via the host-injected
   * fetchIntrospection() (which builds the introspection POST from the current
   * request), then re-validate the live query. Every failure path is surfaced.
   */
  async #fetchSchema() {
    if (this.#fetching) return;
    const statusBadge = this.#statusBadge;
    const btn = this.#fetchBtn;
    this.#fetching = true;
    if (btn) btn.disabled = true;
    if (statusBadge) {
      statusBadge.dataset.state = "loading";
      statusBadge.innerHTML = "";
      statusBadge.removeAttribute("aria-label");
      statusBadge.title = t("request.graphql.fetching");
    }
    try {
      const json = await this.#deps.fetchIntrospection();
      if (json == null) {
        // Aborted upstream (e.g. no URL — the host already warned). Restore badge.
        if (this.#schema) this.#markBadgeLoaded(statusBadge);
        else if (statusBadge) {
          statusBadge.dataset.state = "";
          statusBadge.innerHTML = "";
          statusBadge.removeAttribute("aria-label");
          statusBadge.title = "";
        }
        return;
      }
      const model = buildSchemaModel(json);
      if (!model) throw new Error(t("request.graphql.parseFailed"));
      this.#schema = model;
      this.#introspection = json?.data?.__schema
        ? json.data
        : json?.__schema
          ? json
          : null;
      this.#revalidateQuery?.();
      this.#markBadgeLoaded(statusBadge);
    } catch (err) {
      this.#schema = null;
      this.#introspection = null;
      this.#revalidateQuery?.();
      if (statusBadge) {
        statusBadge.dataset.state = "error";
        statusBadge.innerHTML = icon("close", { size: 14 });
        statusBadge.setAttribute(
          "aria-label",
          t("request.graphql.fetchFailed"),
        );
        statusBadge.title =
          err?.message ?? t("request.graphql.fetchSchemaFailed");
      }
      Notifications.error(
        err?.message ?? t("request.graphql.fetchSchemaFailed"),
        {
          title: t("request.graphql.introspectionFailed"),
        },
      );
    } finally {
      this.#fetching = false;
      if (btn) btn.disabled = false;
    }
  }

  /** Put the status icon into its "schema loaded" (green tick) state. */
  #markBadgeLoaded(badge) {
    if (!badge || !this.#schema) return;
    badge.dataset.state = "ok";
    badge.innerHTML = icon("check", { size: 14 });
    badge.setAttribute("aria-label", t("request.graphql.loaded"));
    badge.title = t("request.graphql.typesAvailable", {
      count: this.#schema.types.size,
    });
  }

  /** Native context menu for the loaded-schema badge: View / Download (as SDL). */
  async #showSchemaContextMenu(x, y) {
    const id = await window.wurl?.ui?.contextMenu?.show({
      items: [
        { id: "view", label: t("request.graphql.viewSchema") },
        { id: "download", label: t("request.graphql.downloadSchema") },
      ],
      x,
      y,
    });
    if (id === "view") this.#viewSchema();
    else if (id === "download") this.#downloadSchema();
  }

  /** Render the cached introspection as SDL, or notify + return null. */
  #schemaSDL() {
    const sdl = introspectionToSDL(this.#introspection);
    if (!sdl) {
      Notifications.warning(t("request.graphql.renderFailed"), {
        title: t("request.graphql.unavailable"),
      });
      return null;
    }
    return sdl;
  }

  /** Open the read-only schema viewer for the loaded schema. */
  #viewSchema() {
    const sdl = this.#schemaSDL();
    if (!sdl) return;
    GraphQLSchemaViewer.open(sdl, {
      onDownload: () => this.#downloadSchema(),
    });
  }

  /** Save the loaded schema to a `.graphql` file via the native save dialog. */
  #downloadSchema() {
    const sdl = this.#schemaSDL();
    if (!sdl) return;
    window.wurl?.export?.file?.save("schema.graphql", sdl, [
      { name: "GraphQL Schema", extensions: ["graphql", "gql"] },
      { name: t("common.allFiles"), extensions: ["*"] },
    ]);
  }
}
