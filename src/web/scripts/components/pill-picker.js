"use strict";

/**
 * PillPicker — lightweight inline dropdown that opens when the user types "{{".
 *
 * Owned entirely by VariablePillEditor; does NOT use PopupManager.
 * The editor retains keyboard focus throughout — arrow keys / Enter / Escape
 * are forwarded by the editor via selectNext() / selectPrev() / getSelected().
 *
 * Usage (inside VariablePillEditor):
 *   const picker = new PillPicker({ x, y, filter, variables, functions, onSelect, onClose });
 *   document.body.appendChild(picker.element);
 *   // on key:  picker.selectNext() / selectPrev()
 *   //          const item = picker.getSelected(); if (item) onSelect(item);
 *   // update:  picker.updateFilter(newFilter);
 *   // cleanup: picker.destroy();
 */
export class PillPicker {
  #el;
  #items    = [];   // flat ordered list of all visible items
  #activeIdx = -1;  // index into #items of currently highlighted row
  #onSelect;
  #onClose;

  /**
   * @param {{
   *   x:         number,
   *   y:         number,
   *   filter:    string,
   *   variables: string[],
   *   functions: Array<{ name: string, funcDef: object }>,
   *   onSelect:  (item: { type: 'variable'|'function', name: string, rawToken: string }) => void,
   *   onClose:   () => void,
   * }} opts
   */
  constructor({ x, y, filter, variables, functions, onSelect, onClose }) {
    this.#onSelect = onSelect;
    this.#onClose  = onClose;
    this.#el       = this.#build();
    this.#position(x, y);
    this.#render(filter, variables, functions);
  }

  get element() { return this.#el; }

  // ── Public API ─────────────────────────────────────────────────────────────

  updateFilter(filter, variables, functions) {
    this.#render(filter, variables, functions);
  }

  selectNext() {
    if (!this.#items.length) return;
    this.#setActive((this.#activeIdx + 1) % this.#items.length);
  }

  selectPrev() {
    if (!this.#items.length) return;
    this.#setActive(this.#activeIdx <= 0 ? this.#items.length - 1 : this.#activeIdx - 1);
  }

  /** @returns {{ type, name, rawToken } | null} */
  getSelected() {
    return this.#activeIdx >= 0 ? this.#items[this.#activeIdx] ?? null : null;
  }

  destroy() {
    if (this.#el.parentNode) this.#el.parentNode.removeChild(this.#el);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "pill-picker";
    el.setAttribute("role", "listbox");
    el.setAttribute("aria-label", "Insert variable or function");
    el.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor focus
    return el;
  }

  #position(x, y) {
    // Position below the caret; clamp so the dropdown stays inside the viewport.
    const W = window.innerWidth;
    const H = window.innerHeight;
    const PW = 320;
    const PH = 260;
    const left = Math.max(4, Math.min(x, W - PW - 4));
    const top  = (y + PH > H - 4) ? Math.max(4, y - PH - 4) : y;
    this.#el.style.cssText = `left:${left}px; top:${top}px;`;
  }

  #render(filter, variables, functions) {
    const q = (filter ?? "").toLowerCase();
    this.#el.innerHTML = "";
    this.#items = [];

    // ── Variables ──────────────────────────────────────────────────────────
    const matchedVars = variables.filter(v => v.toLowerCase().includes(q));
    if (matchedVars.length) {
      this.#el.appendChild(this.#sectionHeader("Variables"));
      for (const name of matchedVars) {
        const item = { type: "variable", name, rawToken: `{{${name}}}` };
        this.#items.push(item);
        this.#el.appendChild(this.#itemEl(item, name, ""));
      }
    }

    // ── Functions ──────────────────────────────────────────────────────────
    const SECTION_ORDER = ["built-in", "context", "request-output", "backend"];
    const byCategory = {};
    for (const { name, funcDef } of functions) {
      const cat = funcDef.category ?? "built-in";
      if (!SECTION_ORDER.includes(cat)) continue;
      const sig = funcDef.params.length
        ? `${name}(${funcDef.params.map(p => p.label).join(", ")})`
        : `${name}()`;
      if (!sig.toLowerCase().includes(q) && !funcDef.label.toLowerCase().includes(q)) continue;
      (byCategory[cat] = byCategory[cat] ?? []).push({ name, funcDef, sig });
    }

    const SECTION_LABELS = {
      "built-in":       "Functions",
      "context":        "Context",
      "request-output": "Request Outputs",
      "backend":        "Backend",
    };

    for (const cat of SECTION_ORDER) {
      const entries = byCategory[cat];
      if (!entries?.length) continue;
      this.#el.appendChild(this.#sectionHeader(SECTION_LABELS[cat]));
      for (const { name, funcDef, sig } of entries) {
        const rawToken = this.#buildToken(name, funcDef);
        const item = { type: "function", name, rawToken };
        this.#items.push(item);
        this.#el.appendChild(this.#itemEl(item, sig, funcDef.label));
      }
    }

    if (!this.#items.length) {
      const empty = document.createElement("div");
      empty.className = "pill-picker__empty";
      empty.textContent = "No matches";
      this.#el.appendChild(empty);
    }

    // Highlight first item by default
    this.#activeIdx = -1;
    if (this.#items.length) this.#setActive(0);
  }

  #sectionHeader(label) {
    const h = document.createElement("div");
    h.className = "pill-picker__section";
    h.textContent = label;
    return h;
  }

  #itemEl(item, primary, secondary) {
    const el = document.createElement("div");
    el.className = "pill-picker__item";
    el.setAttribute("role", "option");
    el.dataset.idx = String(this.#items.length - 1); // assigned before calling

    const nameEl = document.createElement("span");
    nameEl.className = "pill-picker__item-name";
    nameEl.textContent = primary;
    el.appendChild(nameEl);

    if (secondary) {
      const descEl = document.createElement("span");
      descEl.className = "pill-picker__item-desc";
      descEl.textContent = secondary;
      el.appendChild(descEl);
    }

    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep editor focus
      this.#onSelect?.(item);
      this.#onClose?.();
    });

    el.addEventListener("mousemove", () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (!isNaN(idx)) this.#setActive(idx);
    });

    return el;
  }

  #setActive(idx) {
    const items = this.#el.querySelectorAll(".pill-picker__item");
    items.forEach((el, i) => el.classList.toggle("pill-picker__item--active", i === idx));
    this.#activeIdx = idx;
    items[idx]?.scrollIntoView({ block: "nearest" });
  }

  #buildToken(name, funcDef) {
    if (!funcDef.params.length) return `{{${name}()}}`;
    const argStrs = funcDef.params.map(p => `"${p.default ?? ""}"`).join(", ");
    return `{{${name}(${argStrs})}}`;
  }
}
