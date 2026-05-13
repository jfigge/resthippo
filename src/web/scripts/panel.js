/**
 * panel.js — Panel system
 *
 * A Panel is a flex container that can be sub-divided with its own flow
 * direction (row | column).  Panels may contain other Panels or leaf content
 * components.  Resize handles (Splitters) are injected between sibling panels
 * and updated automatically when the layout mode changes.
 *
 * Usage:
 *   import { Panel, PanelGroup } from './panel.js';
 *
 *   const group = new PanelGroup({
 *     container: document.getElementById('my-container'),
 *     flow: 'row',
 *     panels: [
 *       new Panel({ id: 'left',   size: 240, content: myComponent }),
 *       new Panel({ id: 'middle', size: '1fr' }),
 *       new Panel({ id: 'right',  size: 320 }),
 *     ],
 *   });
 */

"use strict";

// ─── Breakpoints (must match layout.css) ──────────────────────────────────────
export const BREAKPOINT_LANDSCAPE = 1024;
export const BREAKPOINT_PORTRAIT = 600;

export function getLayoutMode() {
  const w = window.innerWidth;
  if (w >= BREAKPOINT_LANDSCAPE) return "landscape";
  if (w >= BREAKPOINT_PORTRAIT) return "between";
  return "portrait";
}

// ─── Panel ────────────────────────────────────────────────────────────────────
/**
 * A flex container with an optional header and a scrollable body.
 *
 * @param {object} opts
 * @param {string}      opts.id       - Unique DOM id (optional; one is generated if omitted)
 * @param {string}      opts.title    - Text shown in the panel header
 * @param {'row'|'column'} opts.flow  - Flex direction for child panels
 * @param {HTMLElement} [opts.content]- Element to mount inside the panel body
 * @param {string[]}    [opts.classes]- Extra CSS classes to add to the panel element
 */
export class Panel {
  #el;
  #headerEl;
  #bodyEl;
  #children = [];

  constructor({ id, title, flow = "column", content, classes = [] } = {}) {
    this.id = id || `panel-${Math.random().toString(36).slice(2, 8)}`;
    this.title = title;
    this.flow = flow;

    this.#el = document.createElement("div");
    this.#el.className = "panel panel--fill";
    this.#el.id = this.id;
    this.#el.dataset.flow = flow;
    classes.forEach((c) => this.#el.classList.add(c));

    if (title) {
      this.#headerEl = document.createElement("div");
      this.#headerEl.className = "panel-header";
      this.#headerEl.innerHTML =
        `<span class="panel-title">${title}</span>` +
        `<span class="panel-actions"></span>`;
      this.#el.appendChild(this.#headerEl);
    }

    this.#bodyEl = document.createElement("div");
    this.#bodyEl.className = "panel-body";
    this.#el.appendChild(this.#bodyEl);

    if (content) this.mount(content);
  }

  /** The root DOM element of this panel. */
  get element() {
    return this.#el;
  }

  /** The panel-body element (scrollable content area). */
  get body() {
    return this.#bodyEl;
  }

  /** The panel-header actions slot. */
  get actions() {
    return this.#headerEl?.querySelector(".panel-actions") ?? null;
  }

  /**
   * Mount an HTMLElement or a component with an `element` property into the body.
   */
  mount(content) {
    const node = content instanceof HTMLElement ? content : content.element;
    this.#bodyEl.appendChild(node);
    return this;
  }

  /**
   * Create a child PanelGroup inside this panel's body.
   * Returns the PanelGroup.
   */
  divide({ flow, panels } = {}) {
    const group = new PanelGroup({ container: this.#bodyEl, flow, panels });
    this.#children.push(group);
    return group;
  }

  /** Programmatically change the flow direction. */
  setFlow(flow) {
    this.flow = flow;
    this.#el.dataset.flow = flow;
  }
}

// ─── PanelGroup ───────────────────────────────────────────────────────────────
/**
 * Manages a collection of Panels with drag-to-resize splitters between them.
 *
 * @param {object}    opts
 * @param {HTMLElement} opts.container - Parent element that hosts the panels
 * @param {'row'|'column'} opts.flow   - Flex direction
 * @param {Panel[]}   opts.panels      - Ordered list of child panels
 */
export class PanelGroup {
  #container;
  #flow;
  #panels;
  #splitters = [];

  constructor({ container, flow = "row", panels = [] } = {}) {
    this.#container = container;
    this.#flow = flow;
    this.#panels = panels;

    // Make the container a flex host
    container.style.display = "flex";
    container.style.flexDirection = flow === "row" ? "row" : "column";
    container.style.overflow = "hidden";
    container.style.height = "100%";
    container.style.width = "100%";

    this.#render();
  }

  #render() {
    this.#panels.forEach((panel, i) => {
      this.#container.appendChild(panel.element);
      if (i < this.#panels.length - 1) {
        const splitter = new Splitter({
          flow: this.#flow,
          before: panel,
          after: this.#panels[i + 1],
          container: this.#container,
        });
        this.#container.appendChild(splitter.element);
        this.#splitters.push(splitter);
      }
    });
  }

  /** Swap the flex direction of the group at runtime. */
  setFlow(flow) {
    this.#flow = flow;
    this.#container.style.flexDirection = flow === "row" ? "row" : "column";
    this.#splitters.forEach((s) => s.setFlow(flow));
  }

  get panels() {
    return [...this.#panels];
  }
}

// ─── Splitter ─────────────────────────────────────────────────────────────────
/**
 * A drag-to-resize handle placed between two sibling panels.
 * Adjusts the `flex-basis` of the "before" panel as the user drags.
 */
export class Splitter {
  #el;
  #flow;
  #before; // Panel instance
  #after; // Panel instance
  #dragging = false;
  #startPos = 0;
  #startSize = 0;

  constructor({ flow, before, after }) {
    this.#flow = flow;
    this.#before = before;
    this.#after = after;

    this.#el = document.createElement("div");
    this.#el.className = `splitter splitter--${flow === "row" ? "h" : "v"}`;
    this.#el.setAttribute("role", "separator");
    this.#el.setAttribute(
      "aria-orientation",
      flow === "row" ? "vertical" : "horizontal",
    );

    this.#el.addEventListener("mousedown", this.#onMouseDown);
    this.#el.addEventListener("touchstart", this.#onTouchStart, {
      passive: false,
    });
  }

  get element() {
    return this.#el;
  }

  setFlow(flow) {
    this.#flow = flow;
    this.#el.className = `splitter splitter--${flow === "row" ? "h" : "v"}`;
    this.#el.setAttribute(
      "aria-orientation",
      flow === "row" ? "vertical" : "horizontal",
    );
  }

  // ── Pointer helpers ────────────────────────────────────────────────────────
  #clientPos(e) {
    const src = e.touches ? e.touches[0] : e;
    return this.#flow === "row" ? src.clientX : src.clientY;
  }

  #currentSize() {
    const rect = this.#before.element.getBoundingClientRect();
    return this.#flow === "row" ? rect.width : rect.height;
  }

  // ── Drag start ────────────────────────────────────────────────────────────
  #onMouseDown = (e) => {
    e.preventDefault();
    this.#beginDrag(e);
    window.addEventListener("mousemove", this.#onMouseMove);
    window.addEventListener("mouseup", this.#onMouseUp);
  };

  #onTouchStart = (e) => {
    e.preventDefault();
    this.#beginDrag(e);
    window.addEventListener("touchmove", this.#onTouchMove, { passive: false });
    window.addEventListener("touchend", this.#onTouchEnd);
  };

  #beginDrag(e) {
    this.#dragging = true;
    this.#startPos = this.#clientPos(e);
    this.#startSize = this.#currentSize();
    this.#el.classList.add("splitter--dragging");
    document.body.style.cursor =
      this.#flow === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  // ── Drag move ─────────────────────────────────────────────────────────────
  #onMouseMove = (e) => this.#applyDrag(e);
  #onTouchMove = (e) => {
    e.preventDefault();
    this.#applyDrag(e);
  };

  #applyDrag(e) {
    if (!this.#dragging) return;
    const delta = this.#clientPos(e) - this.#startPos;
    const newSize = Math.max(80, this.#startSize + delta);
    const el = this.#before.element;

    // Use flex-basis so the other panel takes the remaining space
    el.style.flex = `0 0 ${newSize}px`;
  }

  // ── Drag end ──────────────────────────────────────────────────────────────
  #onMouseUp = () =>
    this.#endDrag(() => {
      window.removeEventListener("mousemove", this.#onMouseMove);
      window.removeEventListener("mouseup", this.#onMouseUp);
    });

  #onTouchEnd = () =>
    this.#endDrag(() => {
      window.removeEventListener("touchmove", this.#onTouchMove);
      window.removeEventListener("touchend", this.#onTouchEnd);
    });

  #endDrag(cleanup) {
    this.#dragging = false;
    this.#el.classList.remove("splitter--dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    cleanup();
  }
}
