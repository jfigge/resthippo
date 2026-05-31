/**
 * cookies-popup.js — Per-collection cookie-jar manager (Feature 09)
 *
 * Views, edits, deletes and clears the cookies a collection's jar has captured
 * from `Set-Cookie` responses. The jar itself — capture, attachment, domain/
 * path/expiry matching — lives entirely in the main process; this popup is a
 * thin viewer/editor that talks to it over the `window.wurl.store.cookies.*`
 * IPC surface and never decides what gets sent on a request.
 *
 * Scope: a single collection, identified by the id passed to open(). The jar
 * is keyed by collection on disk (collections/<id>/cookies.json).
 *
 * No window events are dispatched — the jar is owned by the main process, so
 * the popup re-reads it from IPC whenever it opens or mutates.
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

// ── SVG icons (match environments-popup.js sizing) ──────────────────────────────

const ICON_EDIT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
</svg>`;

const ICON_DELETE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
  <path d="M10 11v6"/><path d="M14 11v6"/>
  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
</svg>`;

const SAME_SITE_OPTIONS = ["", "Strict", "Lax", "None"];

// ── CookiesPopup ────────────────────────────────────────────────────────────────

export class CookiesPopup {
  /** @type {HTMLElement} */
  #el;

  /** Collection whose jar is being managed. */
  #collectionId = null;
  /** Human-readable collection name for the header subtitle. */
  #collectionName = "";

  /** @type {object[]} Live jar entries last loaded from the main process. */
  #cookies = [];

  /**
   * Identity of the row currently in edit mode, or null. Stored as the original
   * {name, domain, path} so a save that changes identity can remove the old key.
   * @type {{name:string,domain:string,path:string}|null}
   */
  #editingIdent = null;

  constructor() {
    this.#el = this.#build();
    this.#initResize(this.#el);
  }

  get element() {
    return this.#el;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the manager for one collection and load its jar from the main process.
   * @param {string} collectionId
   * @param {{ name?: string }} [opts]
   */
  async open(collectionId, { name = "" } = {}) {
    this.#collectionId = collectionId ?? null;
    this.#collectionName = name || "";
    this.#editingIdent = null;
    this.#el.querySelector(".cookies-subtitle").textContent = this
      .#collectionName
      ? `Collection: ${this.#collectionName}`
      : "";
    PopupManager.open(this);
    await this.#reload();
  }

  /** Required by PopupManager. */
  onMaskClick() {
    this.#doClose();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "popup cookies-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Cookies");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Cookies</span>
        <span class="cookies-subtitle"></span>
        <button class="popup-close" aria-label="Close cookies" title="Close">✕</button>
      </div>
      <div class="popup-body cookies-popup-body">
        <ul class="cookies-list" aria-label="Stored cookies"></ul>
      </div>
      <div class="popup-footer cookies-popup-footer">
        <button class="popup-btn popup-btn--secondary cookies-clear-btn"
                title="Remove every cookie in this collection's jar">Clear All</button>
        <button class="popup-btn popup-btn--primary js-close">Close</button>
      </div>
    `;

    el.querySelector(".popup-close").addEventListener("click", () =>
      this.#doClose(),
    );
    el.querySelector(".js-close").addEventListener("click", () =>
      this.#doClose(),
    );
    el.querySelector(".cookies-clear-btn").addEventListener("click", () =>
      this.#confirmClear(),
    );

    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.#doClose();
      }
    });

    return el;
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

  async #reload() {
    if (!this.#collectionId) {
      this.#cookies = [];
      this.#renderList();
      return;
    }
    try {
      const list = await window.wurl.store.cookies.list(this.#collectionId);
      this.#cookies = Array.isArray(list) ? list : [];
    } catch {
      this.#cookies = [];
    }
    this.#renderList();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  #renderList() {
    const list = this.#el.querySelector(".cookies-list");
    const clearBtn = this.#el.querySelector(".cookies-clear-btn");
    list.innerHTML = "";

    if (!this.#collectionId) {
      list.innerHTML = `<li class="cookies-empty">Select a collection to manage its cookies.</li>`;
      clearBtn.disabled = true;
      return;
    }
    if (this.#cookies.length === 0) {
      list.innerHTML = `<li class="cookies-empty">No cookies stored for this collection.</li>`;
      clearBtn.disabled = true;
      return;
    }
    clearBtn.disabled = false;

    for (const cookie of this.#cookies) {
      list.appendChild(
        this.#isEditing(cookie)
          ? this.#buildEditRow(cookie)
          : this.#buildViewRow(cookie),
      );
    }
  }

  #buildViewRow(cookie) {
    const li = document.createElement("li");
    li.className = "cookies-row";

    const flags = [];
    if (cookie.secure) flags.push("Secure");
    if (cookie.httpOnly) flags.push("HttpOnly");
    if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`);
    const flagsHtml = flags.length
      ? `<span class="cookies-flags">${flags.map((f) => `<span class="cookies-flag">${this.#escape(f)}</span>`).join("")}</span>`
      : "";

    li.innerHTML = `
      <div class="cookies-row-main">
        <span class="cookies-nv">
          <span class="cookies-name">${this.#escape(cookie.name)}</span>=<span class="cookies-value">${this.#escape(cookie.value)}</span>
        </span>
        <div class="cookies-row-actions">
          <button class="icon-btn cookies-edit" title="Edit cookie" aria-label="Edit cookie">${ICON_EDIT}</button>
          <button class="icon-btn cookies-delete" title="Delete cookie" aria-label="Delete cookie">${ICON_DELETE}</button>
        </div>
      </div>
      <div class="cookies-row-meta">
        <span class="cookies-scope">${this.#escape(cookie.domain)}${this.#escape(cookie.path)}</span>
        <span class="cookies-expiry">${this.#escape(this.#formatExpiry(cookie.expires))}</span>
        ${flagsHtml}
      </div>
    `;

    li.querySelector(".cookies-edit").addEventListener("click", () => {
      this.#editingIdent = this.#identOf(cookie);
      this.#renderList();
    });
    li.querySelector(".cookies-delete").addEventListener("click", () =>
      this.#confirmDelete(cookie),
    );

    return li;
  }

  #buildEditRow(cookie) {
    const li = document.createElement("li");
    li.className = "cookies-row cookies-row--editing";

    const sameSiteOpts = SAME_SITE_OPTIONS.map((opt) => {
      const sel = (cookie.sameSite || "") === opt ? " selected" : "";
      const label = opt || "(none)";
      return `<option value="${this.#escape(opt)}"${sel}>${this.#escape(label)}</option>`;
    }).join("");

    li.innerHTML = `
      <div class="cookies-edit-grid">
        <label class="cookies-field">
          <span>Name</span>
          <input type="text" class="cookies-in-name" autocomplete="off" spellcheck="false" value="${this.#escape(cookie.name)}">
        </label>
        <label class="cookies-field">
          <span>Value</span>
          <input type="text" class="cookies-in-value" autocomplete="off" spellcheck="false" value="${this.#escape(cookie.value)}">
        </label>
        <label class="cookies-field">
          <span>Domain</span>
          <input type="text" class="cookies-in-domain" autocomplete="off" spellcheck="false" value="${this.#escape(cookie.domain)}">
        </label>
        <label class="cookies-field">
          <span>Path</span>
          <input type="text" class="cookies-in-path" autocomplete="off" spellcheck="false" value="${this.#escape(cookie.path)}">
        </label>
        <label class="cookies-field">
          <span>Expires</span>
          <input type="datetime-local" class="cookies-in-expires" value="${this.#escape(this.#toDatetimeLocal(cookie.expires))}">
        </label>
        <label class="cookies-field">
          <span>SameSite</span>
          <select class="cookies-in-samesite">${sameSiteOpts}</select>
        </label>
        <label class="cookies-checkbox">
          <input type="checkbox" class="cookies-in-secure"${cookie.secure ? " checked" : ""}> Secure
        </label>
        <label class="cookies-checkbox">
          <input type="checkbox" class="cookies-in-httponly"${cookie.httpOnly ? " checked" : ""}> HttpOnly
        </label>
      </div>
      <div class="cookies-edit-actions">
        <button class="popup-btn popup-btn--secondary cookies-edit-cancel">Cancel</button>
        <button class="popup-btn popup-btn--primary cookies-edit-save">Save</button>
      </div>
    `;

    li.querySelector(".cookies-edit-cancel").addEventListener("click", () => {
      this.#editingIdent = null;
      this.#renderList();
    });
    li.querySelector(".cookies-edit-save").addEventListener("click", () =>
      this.#saveEdit(cookie, li),
    );

    return li;
  }

  // ── Mutations (delegated to the main process) ───────────────────────────────

  async #saveEdit(original, li) {
    const name = li.querySelector(".cookies-in-name").value.trim();
    const domain = li
      .querySelector(".cookies-in-domain")
      .value.trim()
      .toLowerCase()
      .replace(/^\./, "");
    let path = li.querySelector(".cookies-in-path").value.trim();
    if (!path.startsWith("/")) path = "/";

    if (!name || !domain) {
      // Name and domain are the cookie's identity — refuse an empty key.
      li.querySelector(".cookies-in-name").focus();
      return;
    }

    const expires = this.#fromDatetimeLocal(
      li.querySelector(".cookies-in-expires").value,
    );

    const updated = {
      ...original,
      name,
      value: li.querySelector(".cookies-in-value").value,
      domain,
      path,
      secure: li.querySelector(".cookies-in-secure").checked,
      httpOnly: li.querySelector(".cookies-in-httponly").checked,
      sameSite: li.querySelector(".cookies-in-samesite").value || null,
      expires,
    };

    const oldIdent = this.#identOf(original);
    const identityChanged =
      oldIdent.name !== updated.name ||
      oldIdent.domain !== updated.domain ||
      oldIdent.path !== updated.path;

    try {
      // A changed identity is a different jar key, so remove the old entry
      // first rather than leaving a stale duplicate behind.
      if (identityChanged) {
        await window.wurl.store.cookies.delete(this.#collectionId, oldIdent);
      }
      await window.wurl.store.cookies.upsert(this.#collectionId, updated);
    } catch {
      /* leave the editor open so the user can retry */
      return;
    }

    this.#editingIdent = null;
    await this.#reload();
  }

  #confirmDelete(cookie) {
    PopupManager.confirm({
      title: "Delete Cookie?",
      message: `Delete "<strong>${this.#escape(cookie.name)}</strong>" for <strong>${this.#escape(cookie.domain)}${this.#escape(cookie.path)}</strong>? It will no longer be sent on matching requests.`,
      confirmLabel: "Delete",
      confirmClass: "popup-btn--danger",
      onConfirm: async () => {
        try {
          await window.wurl.store.cookies.delete(
            this.#collectionId,
            this.#identOf(cookie),
          );
        } catch {
          return;
        }
        if (this.#isEditing(cookie)) this.#editingIdent = null;
        await this.#reload();
      },
    });
  }

  #confirmClear() {
    PopupManager.confirm({
      title: "Clear All Cookies?",
      message: `Remove every cookie stored for this collection? Subsequent requests will send no cookies until new ones are captured. This cannot be undone.`,
      confirmLabel: "Clear All",
      confirmClass: "popup-btn--danger",
      onConfirm: async () => {
        try {
          await window.wurl.store.cookies.clear(this.#collectionId);
        } catch {
          return;
        }
        this.#editingIdent = null;
        await this.#reload();
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #identOf(cookie) {
    return { name: cookie.name, domain: cookie.domain, path: cookie.path };
  }

  #isEditing(cookie) {
    const e = this.#editingIdent;
    return (
      !!e &&
      e.name === cookie.name &&
      e.domain === cookie.domain &&
      e.path === cookie.path
    );
  }

  /** Human-readable expiry, or "Session" for session cookies. */
  #formatExpiry(expires) {
    if (expires == null) return "Session";
    const d = new Date(expires);
    if (Number.isNaN(d.getTime())) return "Session";
    return d.toLocaleString();
  }

  /** Epoch ms → value for a <input type="datetime-local"> (local time). */
  #toDatetimeLocal(expires) {
    if (expires == null) return "";
    const d = new Date(expires);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  /** datetime-local value → epoch ms, or null when blank (session cookie). */
  #fromDatetimeLocal(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  #doClose() {
    this.#editingIdent = null;
    PopupManager.close();
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  #initResize(el) {
    const handle = document.createElement("div");
    handle.className = "popup-resize-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <circle cx="9" cy="9" r="1.4"/><circle cx="5" cy="9" r="1.4"/><circle cx="9" cy="5" r="1.4"/>
    </svg>`;
    el.appendChild(handle);

    handle.addEventListener("mousedown", (startEvt) => {
      startEvt.preventDefault();
      startEvt.stopPropagation();
      const rect = el.getBoundingClientRect();
      const minW = rect.width;
      const minH = rect.height;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      el.style.maxWidth = "none";
      el.style.maxHeight = "none";
      const onMove = (e) => {
        el.style.width = `${Math.max(minW, 2 * (e.clientX - centerX))}px`;
        el.style.height = `${Math.max(minH, 2 * (e.clientY - centerY))}px`;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  #escape(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
