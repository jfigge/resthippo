/**
 * tree-view.js — Navigation / Collections tree-view component
 *
 * Renders a hierarchical list of request collections and individual requests.
 * Collections may be nested to any depth (folders within folders).
 *
 * Public API:
 *   setItems(items)   — replace the full tree data and re-render
 *   getItems()        — return the current items array (deep copy)
 *
 * Events dispatched on window:
 *   wurl:request-selected    { detail: node }   — user clicked a request
 *   wurl:collections-changed { detail: items }  — tree was mutated (add/remove)
 *   wurl:folder-vars-open    { nodeId, folderName, variables } — user opened folder vars
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { resolveString, buildFolderChain, collectTemplateVariables } from "./variable-resolver.js";

// SVG folder icons (Feather-style, stroke-based)
const ICON_FOLDER_CLOSED = `<svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ICON_FOLDER_OPEN   = `<svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="2 10 12 10 17 15 22 10"/></svg>`;

export class TreeView {
  /** @type {HTMLElement} */
  #el;

  /** @type {object[]} — live copy of the full tree data */
  #items = [];

  /**
   * ID of the collection most recently interacted with.
   * "New Request" targets this collection; falls back to the first collection.
   * @type {string|null}
   */
  #activeCollectionId = null;

  /** @type {HTMLButtonElement} — kept to toggle disabled state */
  #btnNewRequest = null;

  /** @type {HTMLElement} — reused context-menu element */
  #ctxMenuEl = null;

  /** @type {string|null} — id of the node currently being dragged */
  #dragId = null;

  /** @type {object} — active environment variables used for variable resolution in cURL generation */
  #envVariables = {};

  /** @type {boolean} — true while the drag cursor is inside the treeview */
  #dragInsideTreeView = false;

  /** @type {boolean} — true after a successful in-tree drop */
  #dropHandled = false;

  /** @type {HTMLLIElement} — the grey placeholder shown while dragging */
  #dragPhantomEl = null;

  /** @type {Function|null} — document-level dragover handler, cleaned up on dragend */
  #docDragOverHandler = null;

  /**
   * @param {object}   [opts]
   * @param {object[]} [opts.items]  - Initial tree data
   */
  constructor({ items = [] } = {}) {
    this.#el = document.createElement("div");
    this.#el.className = "tree-view";
    this.#el.setAttribute("role", "tree");

    this.#ctxMenuEl = this.#createCtxMenuEl();

    // Create the phantom drop-target placeholder (shared, moved around the DOM)
    this.#dragPhantomEl = document.createElement("li");
    this.#dragPhantomEl.className = "tree-drop-phantom";
    this.#dragPhantomEl.setAttribute("aria-hidden", "true");

    this.#renderToolbar();
    this.#items = items;
    this.#renderTree(this.#items);

    // Container-level: allow drop anywhere inside the treeview
    this.#el.addEventListener("dragover", (e) => {
      if (this.#dragId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });

    // Container-level: handle the actual drop (phantom target stores where to drop)
    this.#el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.#dragId) return;
      const targetId = this.#dragPhantomEl.dataset.targetId;
      const pos      = this.#dragPhantomEl.dataset.targetPos;
      if (targetId && pos) {
        this.#dropHandled = true;
        this.#moveNode(this.#dragId, targetId, pos);
        // #moveNode → #rerender() rebuilds the DOM cleanly
      } else {
        this.#cancelDrag();
      }
    });
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Replace the full tree data and re-render.
   * Does NOT fire wurl:collections-changed (caller already owns the source of truth).
   * @param {object[]} items
   */
  setItems(items) {
    this.#items = Array.isArray(items) ? items : [];
    this.#syncButtonState();
    this.#rerender();
  }

  /**
   * Return a deep clone of the current items array.
   * @returns {object[]}
   */
  getItems() {
    return JSON.parse(JSON.stringify(this.#items));
  }

  /**
   * Update the active environment variables used when generating cURL commands.
   * Call this whenever the active environment or its variables change.
   *
   * @param {object} vars  — plain { name: value } map of resolved env variables
   */
  setEnvVariables(vars) {
    this.#envVariables = (vars && typeof vars === "object") ? vars : {};
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────

  #renderToolbar() {
    const bar = document.createElement("div");
    bar.className = "tree-toolbar";

    // New Collection button
    const btnNewCollection = document.createElement("button");
    btnNewCollection.className = "icon-btn";
    btnNewCollection.title = "New Collection";
    btnNewCollection.setAttribute("aria-label", "New Collection");
    btnNewCollection.innerHTML = `<span class="icon">📁</span>`;
    btnNewCollection.addEventListener("click", () => this.#addCollection());

    // New Request button — disabled until at least one collection exists
    this.#btnNewRequest = document.createElement("button");
    this.#btnNewRequest.className = "icon-btn";
    this.#btnNewRequest.title = "New Request";
    this.#btnNewRequest.setAttribute("aria-label", "New Request");
    this.#btnNewRequest.innerHTML = `<span class="icon">＋</span>`;
    this.#btnNewRequest.disabled = true;
    this.#btnNewRequest.addEventListener("click", () => this.#addRequest());

    // Search / filter input
    const search = document.createElement("input");
    search.className = "tree-search";
    search.type = "search";
    search.placeholder = "Filter…";
    search.setAttribute("aria-label", "Filter requests");

    bar.appendChild(btnNewCollection);
    bar.appendChild(this.#btnNewRequest);
    bar.appendChild(search);
    this.#el.appendChild(bar);
  }

  // ── Context menu ────────────────────────────────────────────────────────

  /** Create the shared context-menu DOM element (populated on each open). */
  #createCtxMenuEl() {
    const el = document.createElement("div");
    el.className = "tree-ctxmenu";
    el.setAttribute("role", "menu");
    // Prevent the row's contextmenu from firing inside the menu itself
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    return el;
  }

  /**
   * Populate and open the context menu for a node.
   * @param {object}      node
   * @param {string|null} parentCollectionId
   * @param {number}      x  clientX of the contextmenu event
   * @param {number}      y  clientY of the contextmenu event
   */
  #showContextMenu(node, parentCollectionId, x, y) {
    const el = this.#ctxMenuEl;
    el.innerHTML = "";

    const menuItems =
      node.type === "collection"
        ? [
            { label: "Add Request", action: () => this.#addRequestTo(node.id) },
            { label: "Add Folder",  action: () => this.#addFolderTo(node.id)  },
            "separator",
            { label: "Rename",      action: () => this.#renameNode(node.id)   },
            "separator",
            { label: "Duplicate",     action: () => this.#duplicateNode(node.id) },
            "separator",
            {
              label: "Variables",
              action: () => {
                const liveNode = this.#findNode(this.#items, node.id) ?? node;
                window.dispatchEvent(new CustomEvent("wurl:folder-vars-open", {
                  detail: { nodeId: liveNode.id, folderName: liveNode.name, variables: liveNode.variables ?? {} },
                  bubbles: true,
                }));
              },
            },
            "separator",
            { label: "Delete", danger: true, action: () => this.#deleteNode(node.id) },
          ]
        : [
            { label: "Rename",      action: () => this.#renameNode(node.id)   },
            "separator",
            { label: "Duplicate",     action: () => this.#duplicateNode(node.id) },
            { label: "Generate cURL", action: () => this.#generateCurl(node)     },
            "separator",
            { label: "Delete", danger: true, action: () => this.#deleteNode(node.id) },
          ];

    menuItems.forEach((item) => {
      if (item === "separator") {
        const sep = document.createElement("div");
        sep.className = "tree-ctxmenu__separator";
        el.appendChild(sep);
        return;
      }
      const btn = document.createElement("button");
      btn.className = "tree-ctxmenu__item";
      if (item.danger) btn.classList.add("tree-ctxmenu__item--danger");
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;

      if (item.danger) {
        // First click → enter "Confirm?" state; second click → execute + close.
        // Escape or clicking outside the button cancels the confirm state.
        let cleanupConfirm = null;

        btn.addEventListener("click", () => {
          if (cleanupConfirm) {
            // Already confirming — second click executes the action.
            cleanupConfirm();
            PopupManager.close();
            item.action();
            return;
          }

          // Enter confirm state.
          btn.textContent = "Confirm?";
          btn.classList.remove("tree-ctxmenu__item--danger");
          btn.classList.add("tree-ctxmenu__item--confirming");

          const restore = () => {
            btn.textContent = item.label;
            btn.classList.remove("tree-ctxmenu__item--confirming");
            btn.classList.add("tree-ctxmenu__item--danger");
            document.removeEventListener("keydown", onEsc, true);
            document.removeEventListener("mousedown", onOutside, true);
            cleanupConfirm = null;
          };

          const onEsc = (e) => {
            if (e.key === "Escape") {
              restore();
              PopupManager.close();
            }
          };

          // Clicking anywhere outside this button (including other menu items
          // or the mask) cancels the confirm state. The mask/outside-click
          // handler in PopupManager will separately close the menu if needed.
          const onOutside = (e) => {
            if (!btn.contains(e.target)) restore();
          };

          document.addEventListener("keydown", onEsc, true);
          document.addEventListener("mousedown", onOutside, true);
          cleanupConfirm = restore;
        });
      } else {
        btn.addEventListener("click", () => {
          PopupManager.close();
          item.action();
        });
      }

      el.appendChild(btn);
    });

    PopupManager.openMenu(el, x, y);
  }

  // ── Mutations — toolbar ─────────────────────────────────────────────────

  /** Add a new top-level collection and persist. */
  #addCollection() {
    const collection = {
      id: crypto.randomUUID(),
      type: "collection",
      name: "New Collection",
      children: [],
    };
    this.#items = [...this.#items, collection];
    this.#activeCollectionId = collection.id;
    this.#syncButtonState();
    this.#rerender();
    this.#emitChange();
  }

  /**
   * Add a new request under the active collection (or the first collection).
   * If no collection exists the button is disabled, so this is a no-op guard.
   */
  #addRequest() {
    const targetId =
      this.#activeCollectionId ?? this.#items.find((n) => n.type === "collection")?.id;
    if (!targetId) return;
    this.#addRequestTo(targetId);
  }

  // ── Mutations — context menu actions ────────────────────────────────────

  /** Add a new request directly inside the collection identified by `collectionId`. */
  #addRequestTo(collectionId) {
    const request = {
      id: crypto.randomUUID(),
      type: "request",
      name: "New Request",
      method: "GET",
      url: "",
    };
    this.#items = this.#insertChild(this.#items, collectionId, request);
    this.#rerender();
    this.#emitChange();
  }

  /** Add a nested folder (collection) inside the collection identified by `collectionId`. */
  #addFolderTo(collectionId) {
    const folder = {
      id: crypto.randomUUID(),
      type: "collection",
      name: "New Folder",
      children: [],
    };
    this.#items = this.#insertChild(this.#items, collectionId, folder);
    this.#rerender();
    this.#emitChange();
  }

  /**
   * Begin inline rename for the node whose `data-id` matches `nodeId`.
   * Replaces the label span with a text input; commits on Enter or blur,
   * cancels on Escape.
   */
  #renameNode(nodeId) {
    const li = this.#el.querySelector(`[data-id="${CSS.escape(nodeId)}"]`);
    if (!li) return;
    const labelEl = li.querySelector(".tree-node__label");
    if (!labelEl) return;

    const originalName = labelEl.textContent;

    const input = document.createElement("input");
    input.type = "text";
    input.value = originalName;
    input.className = "tree-node__rename-input";
    input.setAttribute("aria-label", "Rename");
    labelEl.replaceWith(input);
    input.select();
    input.focus();

    const commit = () => {
      const newName = input.value.trim() || originalName;
      this.#items = this.#updateNodeName(this.#items, nodeId, newName);
      this.#rerender();
      if (newName !== originalName) this.#emitChange();
    };

    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur(); // triggers blur → commit
      } else if (e.key === "Escape") {
        // Cancel: restore original without saving
        input.removeEventListener("blur", commit);
        const span = document.createElement("span");
        span.className = "tree-node__label";
        span.textContent = originalName;
        input.replaceWith(span);
      }
    });
  }

  /**
   * Deep-clone the node with `nodeId` (assigning new UUIDs throughout),
   * name it "<original> (copy)", and insert it right after the original.
   */
  #duplicateNode(nodeId) {
    const original = this.#findNode(this.#items, nodeId);
    if (!original) return;

    const clone   = this.#cloneWithNewIds(original);
    clone.name    = `${clone.name} (copy)`;
    this.#items   = this.#insertNodeAfter(this.#items, nodeId, clone);
    this.#rerender();
    this.#emitChange();
  }

  /** Remove the node with `nodeId` from the tree at any nesting depth. */
  #deleteNode(nodeId) {
    this.#items = this.#removeNode(this.#items, nodeId);
    if (this.#activeCollectionId === nodeId) this.#activeCollectionId = null;
    this.#syncButtonState();
    this.#rerender();
    this.#emitChange();
  }

  /**
   * Build a cURL command for a request, or for every request in a collection,
   * write it to the clipboard, then show a confirmation dialog.
   * @param {object} node
   * @param {boolean} [force=false]  skip variable pre-flight check
   */
  #generateCurl(node, force = false) {
    // The closure-captured `node` may be stale: updateNode() replaces the node
    // object in #items immutably, so any field changes (bodyType, bodyFormRows,
    // headers, params, etc.) made after the DOM row was rendered are invisible
    // through the old reference.  Always look up the live version first.
    const liveNode = this.#findNode(this.#items, node.id) ?? node;

    // ── Variable pre-flight check (single requests only) ─────────────────
    // For collection nodes the variables vary per-child request, so the check
    // is skipped to avoid an overwhelming list.
    if (!force && liveNode.type === "request") {
      const nodeContext = {
        envVariables: this.#envVariables,
        folderChain:  buildFolderChain(this.#items, liveNode.id),
      };
      const allVars  = collectTemplateVariables(this.#gatherNodeTemplates(liveNode), nodeContext);
      const badCount = allVars.filter(v => !v.found).length;
      if (badCount > 0) {
        PopupManager.warnVariables({
          variables:   allVars,
          actionLabel: "Copy Anyway",
          onAction:    () => this.#generateCurl(node, true),
        });
        return;
      }
    }

    const curl = this.#buildCurl(liveNode);
    if (!curl) return;

    navigator.clipboard.writeText(curl).then(() => {
      PopupManager.notify({
        title:   "Copied to Clipboard",
        message: "The cURL command has been copied to your clipboard.",
      });
    }).catch(() => {
      PopupManager.notify({
        title:   "Copy Failed",
        message: "Unable to write to the clipboard. Please try again.",
      });
    });
  }

  /**
   * Collect all template strings from a request node so every {{varName}}
   * token can be checked before cURL generation.
   * @param {object} node  a request-type tree node
   * @returns {string[]}
   */
  #gatherNodeTemplates(node) {
    const t = [node.url ?? ""];
    for (const p of (node.params ?? [])) {
      if (p.enabled) { t.push(p.name ?? "", p.value ?? ""); }
    }
    if (Array.isArray(node.headers)) {
      for (const h of node.headers) {
        if (h.enabled) { t.push(h.name ?? "", h.value ?? ""); }
      }
    }
    const authEnabled = node.authEnabled ?? true;
    const authType    = node.authType    ?? "none";
    if (authEnabled && authType !== "none") {
      t.push(node.authBasic?.username ?? "", node.authBasic?.password ?? "");
      t.push(node.authBearer?.token  ?? "");
      t.push(node.authOAuth2?.token  ?? "");
    }
    t.push(node.bodyText ?? "");
    for (const r of (node.bodyFormRows ?? [])) {
      if (r.enabled) { t.push(r.name ?? "", r.value ?? ""); }
    }
    return t.filter(Boolean);
  }

  // ── Tree mutation helpers ───────────────────────────────────────────────

  /**
   * Recursively insert `child` under the node with `parentId`.
   * Supports arbitrary nesting (folders within folders).
   */
  #insertChild(nodes, parentId, child) {
    return nodes.map((node) => {
      if (node.id === parentId) {
        return { ...node, children: [...(node.children ?? []), child] };
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        return { ...node, children: this.#insertChild(node.children, parentId, child) };
      }
      return node;
    });
  }

  /**
   * Recursively remove the node with `targetId` from the tree.
   * Works at any nesting depth.
   */
  #removeNode(nodes, targetId) {
    return nodes
      .filter((n) => n.id !== targetId)
      .map((n) => {
        if (Array.isArray(n.children) && n.children.length > 0) {
          return { ...n, children: this.#removeNode(n.children, targetId) };
        }
        return n;
      });
  }

  /** Find a node by id at any depth. Returns the node or null. */
  #findNode(nodes, targetId) {
    for (const node of nodes) {
      if (node.id === targetId) return node;
      if (Array.isArray(node.children)) {
        const found = this.#findNode(node.children, targetId);
        if (found) return found;
      }
    }
    return null;
  }

  /** Deep-clone a node, replacing every `id` with a new UUID. */
  #cloneWithNewIds(node) {
    const clone = { ...node, id: crypto.randomUUID() };
    if (Array.isArray(node.children)) {
      clone.children = node.children.map((c) => this.#cloneWithNewIds(c));
    }
    return clone;
  }

  /**
   * Insert `newNode` immediately after the node with `afterId`.
   * Searches recursively; handles nested collections correctly.
   */
  #insertNodeAfter(nodes, afterId, newNode) {
    const result = [];
    for (const node of nodes) {
      let current = node;
      let insertedInChildren = false;

      if (Array.isArray(node.children) && node.children.length > 0) {
        const newChildren = this.#insertNodeAfter(node.children, afterId, newNode);
        insertedInChildren = newChildren.length > node.children.length;
        if (insertedInChildren) current = { ...node, children: newChildren };
      }

      result.push(current);

      if (!insertedInChildren && node.id === afterId) {
        result.push(newNode);
      }
    }
    return result;
  }

  /** Return a new tree with the name of `targetId` replaced. */
  #updateNodeName(nodes, targetId, newName) {
    return nodes.map((node) => {
      if (node.id === targetId) return { ...node, name: newName };
      if (Array.isArray(node.children) && node.children.length > 0) {
        return { ...node, children: this.#updateNodeName(node.children, targetId, newName) };
      }
      return node;
    });
  }

  /**
   * Build a cURL command string for a request node, respecting all editor
   * settings: enabled/disabled params, headers, body type, and auth.
   * For a collection, concatenates the cURL of every contained request.
   *
   * Mirrors the assembly logic in RequestEditor.#sendRequest() so the
   * generated command matches what the Send button actually transmits.
   */
  #buildCurl(node) {
    if (node.type === "request") {
      const method  = node.method ?? "GET";

      // ── Variable resolver for this node ─────────────────────────────────
      // Build a context with the node's folder chain (nearest ancestor first)
      // plus the active environment variables.  This mirrors the precedence
      // order used by RequestEditor.#sendRequest() at execute-time.
      const nodeContext = {
        envVariables: this.#envVariables,
        folderChain:  buildFolderChain(this.#items, node.id),
      };
      const rv = (s) => resolveString(s ?? "", nodeContext);

      const baseUrl = rv(node.url || "<url>");

      // ── 1. URL — append enabled, non-blank query parameters ──────────────
      const params        = Array.isArray(node.params) ? node.params : [];
      const enabledParams = params.filter(p => p.enabled && p.name.trim());
      let   finalUrl      = baseUrl;
      if (enabledParams.length) {
        const qs = enabledParams
          .map(p => `${encodeURIComponent(rv(p.name))}=${encodeURIComponent(rv(p.value))}`)
          .join("&");
        finalUrl += (baseUrl.includes("?") ? "&" : "?") + qs;
      }

      // ── 2. Headers — enabled array rows (new format) or legacy object ─────
      const headers = {};
      if (Array.isArray(node.headers)) {
        node.headers
          .filter(h => h.enabled && h.name.trim())
          .forEach(h => { headers[rv(h.name).trim()] = rv(h.value); });
      } else if (node.headers && typeof node.headers === "object") {
        // Legacy: plain key→value object (no enabled flag) — resolve each value
        Object.entries(node.headers).forEach(([k, v]) => {
          headers[rv(k)] = rv(v);
        });
      }

      // ── 3. Auth — inject Authorization header when enabled ────────────────
      const authEnabled = node.authEnabled ?? true;
      const authType    = node.authType    ?? "none";
      if (authEnabled && authType !== "none") {
        switch (authType) {
          case "basic": {
            const username = rv(node.authBasic?.username ?? "");
            const password = rv(node.authBasic?.password ?? "");
            if (username || password) {
              headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`;
            }
            break;
          }
          case "bearer":
            if (node.authBearer?.token)
              headers["Authorization"] = `Bearer ${rv(node.authBearer.token)}`;
            break;
          case "oauth2":
            if (node.authOAuth2?.token)
              headers["Authorization"] = `Bearer ${rv(node.authOAuth2.token)}`;
            break;
          // aws-iam: Signature v4 requires request-time signing — not representable as static curl
        }
      }

      // ── 4. Body — match RequestEditor body assembly by type ───────────────
      const noBodyMethods = new Set(["GET", "HEAD"]);
      const bodyType      = node.bodyType ?? "no-body";
      let   body          = null;         // string payload for --data (text bodies)
      let   bodyFilePath  = null;         // file path for --data-binary @path
      // For form fields: array of already-encoded "name=value" strings (urlencoded)
      // or {name, value} objects (multipart).  formStyle tells the assembler which.
      let   formPairs     = null;         // string[] — urlencoded, already percent-encoded
      let   formEntries   = null;         // {name,value}[] — multipart/form-data

      if (!noBodyMethods.has(method)) {
        switch (bodyType) {
          case "form-data": {
            // Use --form flags (curl sets Content-Type + boundary automatically)
            const rows = (node.bodyFormRows ?? []).filter(r => r.enabled && r.name.trim());
            if (rows.length > 0)
              formEntries = rows.map(r => ({ name: rv(r.name), value: rv(r.value) }));
            break;
          }
          case "form-urlencoded": {
            // Use one --data flag per field; URLSearchParams gives correct encoding.
            const rows = (node.bodyFormRows ?? []).filter(r => r.enabled && r.name.trim());
            if (rows.length > 0) {
              const sp = new URLSearchParams();
              rows.forEach(r => sp.append(rv(r.name), rv(r.value)));
              // Split "a=1&b=2" → ["a=1", "b=2"] — each token is already percent-encoded
              formPairs = sp.toString().split("&").filter(Boolean);
              if (!headers["Content-Type"])
                headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
            break;
          }
          case "json":
            if (node.bodyText?.trim()) {
              body = rv(node.bodyText);
              if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
            }
            break;
          case "yaml":
            if (node.bodyText?.trim()) {
              body = rv(node.bodyText);
              if (!headers["Content-Type"]) headers["Content-Type"] = "application/x-yaml";
            }
            break;
          case "xml":
            if (node.bodyText?.trim()) {
              body = rv(node.bodyText);
              if (!headers["Content-Type"]) headers["Content-Type"] = "application/xml";
            }
            break;
          case "text":
            if (node.bodyText?.trim()) {
              body = rv(node.bodyText);
              if (!headers["Content-Type"]) headers["Content-Type"] = "text/plain";
            }
            break;
          case "file":
            if (node.bodyFilePath) bodyFilePath = node.bodyFilePath;
            break;
          default:
            break; // "no-body" — leave everything null
        }
      }

      // ── 5. Assemble the curl command ──────────────────────────────────────
      // Use long-form flags (--request, --url, --header, --data / --form) so
      // the output matches common style guides and is easy to read and paste.
      // Helper: single-quote a shell token, escaping embedded single quotes.
      const sq = s => `'${String(s).replace(/'/g, "'\\''")}'`;

      let cmd = `curl --request ${method}`;

      // URL — single-quoted; placed right after the method
      cmd += ` \\\n  --url ${sq(finalUrl)}`;

      // Headers — one --header flag per entry
      Object.entries(headers).forEach(([k, v]) => {
        cmd += ` \\\n  --header ${sq(`${k}: ${v}`)}`;
      });

      // Body
      if (formEntries !== null) {
        // multipart/form-data: one --form flag per field; curl sets Content-Type
        formEntries.forEach(({ name, value }) => {
          cmd += ` \\\n  --form ${sq(`${name}=${value}`)}`;
        });
      } else if (formPairs !== null) {
        // application/x-www-form-urlencoded: one --data flag per encoded pair.
        // The pairs from URLSearchParams are already percent-encoded and shell-safe
        // (no spaces, single quotes, or glob chars), so no extra quoting needed.
        formPairs.forEach(pair => {
          cmd += ` \\\n  --data ${pair}`;
        });
      } else if (bodyFilePath !== null) {
        cmd += ` \\\n  --data-binary '@${bodyFilePath.replace(/'/g, "'\\''")}'`;
      } else if (body !== null) {
        cmd += ` \\\n  --data ${sq(body)}`;
      }

      return cmd;
    }

    if (node.type === "collection") {
      const requests = this.#collectRequests(node.children ?? []);
      return requests.map((r) => this.#buildCurl(r)).join("\n\n");
    }
    return "";
  }

  /** Recursively collect all request nodes within a subtree. */
  #collectRequests(nodes) {
    const requests = [];
    for (const node of nodes) {
      if (node.type === "request") {
        requests.push(node);
      } else if (Array.isArray(node.children)) {
        requests.push(...this.#collectRequests(node.children));
      }
    }
    return requests;
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  #rerender() {
    const existing = this.#el.querySelector(".tree-list");
    if (existing) existing.remove();
    this.#renderTree(this.#items);
  }

  #renderTree(items) {
    const listEl = document.createElement("ul");
    listEl.className = "tree-list";
    listEl.setAttribute("role", "group");

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tree-empty";
      empty.innerHTML =
        '<span class="placeholder-icon">📭</span>' +
        "<span>No collections yet</span>";
      listEl.appendChild(empty);
    } else {
      items.forEach((item) => listEl.appendChild(this.#createNode(item, null)));
    }

    this.#el.appendChild(listEl);
  }

  /**
   * Build a <li> element for a tree node.
   * @param {object}      node
   * @param {string|null} parentCollectionId  — id of the enclosing collection, or null for roots
   */
  #createNode(node, parentCollectionId) {
    const li = document.createElement("li");
    li.className = "tree-node";
    li.setAttribute("role", "treeitem");
    li.dataset.id = node.id ?? "";

    if (node.type === "collection") {
      li.classList.add("tree-node--collection");
      li.setAttribute("aria-expanded", "true");
      li.innerHTML = `
        <div class="tree-node__row" tabindex="0">
          <span class="tree-node__icon">${ICON_FOLDER_OPEN}</span>
          <span class="tree-node__label">${this.#escape(node.name)}</span>
        </div>
      `;

      const row     = li.querySelector(".tree-node__row");
      const iconEl  = row.querySelector(".tree-node__icon");
      const labelEl = row.querySelector(".tree-node__label");

      /** Toggle this folder's expanded / collapsed state. */
      const toggleExpand = () => {
        const expanded = li.getAttribute("aria-expanded") === "true";
        li.setAttribute("aria-expanded", String(!expanded));
        iconEl.innerHTML = expanded ? ICON_FOLDER_CLOSED : ICON_FOLDER_OPEN;
        childList.style.display = expanded ? "none" : "";
      };

      // Single click anywhere on the row → select / highlight the row only (no toggle).
      row.addEventListener("click", () => {
        this.#activeCollectionId = node.id;
        this.#setActiveRow(li);
      });

      // Single (or double) click on the folder icon → also toggle expand/collapse.
      // Event bubbles to row, so selection is handled there automatically.
      iconEl.addEventListener("click", () => {
        toggleExpand();
      });

      // Double-click on the label text → toggle expand/collapse.
      // (The two preceding single-click events already selected the row.)
      labelEl.addEventListener("dblclick", () => {
        toggleExpand();
      });

      // Keyboard: Enter → toggle; Space → select only.
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#activeCollectionId = node.id;
          this.#setActiveRow(li);
          toggleExpand();
        } else if (e.key === " ") {
          e.preventDefault();
          this.#activeCollectionId = node.id;
          this.#setActiveRow(li);
        }
      });

      // Right-click: select the row then show context menu
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.#activeCollectionId = node.id;
        this.#setActiveRow(li);
        this.#showContextMenu(node, parentCollectionId, e.clientX, e.clientY);
      });

      // Drag-to-reorder
      this.#attachDragListeners(node, row, li);

      const childList = document.createElement("ul");
      childList.className = "tree-list tree-list--nested";
      childList.setAttribute("role", "group");
      (node.children ?? []).forEach((child) => {
        childList.appendChild(this.#createNode(child, node.id));
      });
      li.appendChild(childList);
    } else {
      // Request item
      li.classList.add("tree-node--request");
      const methodClass = `method--${(node.method ?? "GET").toLowerCase()}`;
      li.innerHTML = `
        <div class="tree-node__row" tabindex="0">
          <span class="tree-node__method ${methodClass}">${node.method ?? "GET"}</span>
          <span class="tree-node__label">${this.#escape(node.name)}</span>
        </div>
      `;

      const row = li.querySelector(".tree-node__row");

      // Left-click: select request
      row.addEventListener("click", () => {
        if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
        this.#selectRequest(node, li);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
          this.#selectRequest(node, li);
        }
      });

      // Right-click: select the request then show context menu
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
        this.#selectRequest(node, li);
        this.#showContextMenu(node, parentCollectionId, e.clientX, e.clientY);
      });

      // Drag-to-reorder
      this.#attachDragListeners(node, row, li);
    }

    return li;
  }

  #setActiveRow(li) {
    this.#el.querySelectorAll(".tree-node--active").forEach((el) => {
      el.classList.remove("tree-node--active");
    });
    li.classList.add("tree-node--active");
  }

  #selectRequest(node, li) {
    this.#setActiveRow(li);

    // Always read the live node from #items so we get the latest field values.
    // The click-handler closure captures the node object at render time; if
    // updateNode() has since patched #items (creating a new object), the
    // closure reference would be stale and load outdated method/url/etc.
    const currentNode = this.#findNode(this.#items, node.id) ?? node;

    window.dispatchEvent(
      new CustomEvent("wurl:request-selected", {
        detail: currentNode,
        bubbles: true,
      }),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Enable / disable "New Request" based on whether any collection exists. */
  #syncButtonState() {
    if (!this.#btnNewRequest) return;
    const hasCollection = this.#items.some((n) => n.type === "collection");
    this.#btnNewRequest.disabled = !hasCollection;
  }

  /** Dispatch the canonical change event so app.js can auto-save. */
  #emitChange() {
    window.dispatchEvent(
      new CustomEvent("wurl:collections-changed", {
        detail: this.getItems(), // deep clone — callers must not mutate
        bubbles: true,
      }),
    );
  }

  #escape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Drag-to-reorder ─────────────────────────────────────────────────────

  /**
   * Attach HTML5 drag-and-drop listeners to a row.
   * Called once per node in #createNode for both collections and requests.
   *
   * Behaviour:
   *  • dragstart  — hides the dragged <li> and inserts the phantom placeholder
   *                 where the item was.
   *  • dragover   — moves the phantom to show where the item would land.
   *  • dragend    — if not a successful in-tree drop, restores the original state.
   *  • Leaving the treeview temporarily restores the item; re-entering resumes.
   *  • Releasing outside the treeview cancels and restores original state.
   */
  #attachDragListeners(node, row, li) {
    row.draggable = true;

    // ── dragstart ──────────────────────────────────────────────────────────
    row.addEventListener("dragstart", (e) => {
      this.#dragId      = node.id;
      this.#dropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      // Required by Firefox to start the drag
      e.dataTransfer.setData("text/plain", node.id);

      requestAnimationFrame(() => {
        this.#dragInsideTreeView = true;
        // Reset phantom metadata
        this.#dragPhantomEl.dataset.targetId  = "";
        this.#dragPhantomEl.dataset.targetPos = "";
        this.#dragPhantomEl.dataset.posKey    = "";
        // Insert phantom where the item was, then hide the actual item
        li.parentElement.insertBefore(this.#dragPhantomEl, li);
        li.style.display = "none";
      });

      // Monitor the drag position relative to the treeview via document dragover
      this.#docDragOverHandler = (ev) => {
        if (!this.#dragId) return;
        const inside = this.#el.contains(ev.target);
        if (!inside && this.#dragInsideTreeView) {
          // Cursor left the treeview — remove phantom and restore the dragged item
          this.#dragInsideTreeView = false;
          this.#dragPhantomEl.remove();
          const draggedLi = this.#el.querySelector(`[data-id="${CSS.escape(this.#dragId)}"]`);
          if (draggedLi) draggedLi.style.display = "";
        } else if (inside && !this.#dragInsideTreeView) {
          // Cursor re-entered the treeview — phantom will be placed on next row dragover
          this.#dragInsideTreeView = true;
        }
      };
      document.addEventListener("dragover", this.#docDragOverHandler);
    });

    // ── dragover ───────────────────────────────────────────────────────────
    row.addEventListener("dragover", (e) => {
      if (!this.#isDragAllowed(node)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect  = row.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;

      let pos;
      if (node.type === "collection") {
        if (ratio < 0.25)      pos = "before";
        else if (ratio > 0.75) pos = "after";
        else                   pos = "inside";
      } else {
        pos = ratio < 0.5 ? "before" : "after";
      }

      // Only move the phantom when the position actually changes (perf)
      const posKey = `${node.id}:${pos}`;
      if (this.#dragPhantomEl.dataset.posKey !== posKey) {
        this.#dragPhantomEl.dataset.posKey    = posKey;
        this.#dragPhantomEl.dataset.targetId  = node.id;
        this.#dragPhantomEl.dataset.targetPos = pos;
        this.#moveDragPhantom(li, pos, node);
      }
    });

    // ── dragend ────────────────────────────────────────────────────────────
    row.addEventListener("dragend", () => {
      if (!this.#dropHandled) {
        // Drag was cancelled (Escape) or released outside the treeview
        this.#cancelDrag();
      }
      // If drop was handled, #moveNode already re-rendered; just clean up state
      this.#finalizeDrag();
    });
  }

  /**
   * Move the phantom placeholder to the position indicated by `pos` relative
   * to `targetLi`.  Also ensures the dragged item's <li> is hidden (handles
   * re-entry into the treeview after briefly leaving).
   */
  #moveDragPhantom(targetLi, pos, targetNode) {
    // Ensure the dragged item stays hidden (e.g. after re-entering treeview)
    const draggedLi = this.#el.querySelector(`[data-id="${CSS.escape(this.#dragId)}"]`);
    if (draggedLi && draggedLi.style.display !== "none") {
      draggedLi.style.display = "none";
    }

    if (pos === "before") {
      targetLi.parentElement.insertBefore(this.#dragPhantomEl, targetLi);
    } else if (pos === "after") {
      targetLi.parentElement.insertBefore(this.#dragPhantomEl, targetLi.nextSibling);
    } else if (pos === "inside" && targetNode.type === "collection") {
      const childList = targetLi.querySelector(".tree-list--nested");
      if (childList && childList.style.display !== "none") {
        childList.insertBefore(this.#dragPhantomEl, childList.firstChild);
      } else {
        // Collapsed collection — treat as after
        targetLi.parentElement.insertBefore(this.#dragPhantomEl, targetLi.nextSibling);
      }
    }
  }

  /**
   * Cancel an in-progress drag: remove the phantom and re-render from the
   * unchanged #items, which naturally restores the original tree state.
   */
  #cancelDrag() {
    this.#dragPhantomEl.remove();
    this.#rerender();
  }

  /**
   * Clean up all drag state variables and remove the document-level listener.
   * Must be called after #cancelDrag() or after a successful #moveNode().
   */
  #finalizeDrag() {
    if (this.#docDragOverHandler) {
      document.removeEventListener("dragover", this.#docDragOverHandler);
      this.#docDragOverHandler = null;
    }
    this.#dragId              = null;
    this.#dragInsideTreeView  = false;
    this.#dropHandled         = false;
    this.#dragPhantomEl.dataset.targetId  = "";
    this.#dragPhantomEl.dataset.targetPos = "";
    this.#dragPhantomEl.dataset.posKey    = "";
  }

  /**
   * Return true when it is valid to drop the current drag onto `targetNode`.
   * Disallows dropping a node onto itself or into any of its own descendants.
   */
  #isDragAllowed(targetNode) {
    if (!this.#dragId) return false;
    if (this.#dragId === targetNode.id) return false;
    // Prevent dragging a collection into one of its own descendants
    const dragged = this.#findNode(this.#items, this.#dragId);
    if (dragged?.type === "collection") {
      if (this.#findNode(dragged.children ?? [], targetNode.id)) return false;
    }
    return true;
  }

  /**
   * Move the node `draggedId` to a position relative to `targetId`.
   * @param {string} draggedId
   * @param {string} targetId
   * @param {'before'|'after'|'inside'} position
   */
  #moveNode(draggedId, targetId, position) {
    if (draggedId === targetId) return;

    const node = this.#findNode(this.#items, draggedId);
    if (!node) return;

    // Remove the node from its current position (children travel with it)
    let newItems = this.#removeNode(this.#items, draggedId);

    // Insert at the requested position
    if (position === "before") {
      newItems = this.#insertBefore(newItems, targetId, node);
    } else if (position === "after") {
      newItems = this.#insertNodeAfter(newItems, targetId, node);
    } else if (position === "inside") {
      newItems = this.#insertChild(newItems, targetId, node);
    }

    this.#items = newItems;
    this.#syncButtonState();
    this.#rerender();
    this.#emitChange();
  }

  // ── Public update API ────────────────────────────────────────────────────

  /**
   * Merge `fields` into the in-memory node identified by `id`, patch the live
   * DOM element when it is visible.
   *
   * Supports any field stored on request nodes (method, url, params, …).
   * @param {string} id
   * @param {object} fields
   * @param {{ silent?: boolean }} [opts]
   *   silent – when true, skips the #emitChange() call so the caller can
   *            batch / debounce the resulting storage write themselves.
   */
  updateNode(id, fields, { silent = false } = {}) {
    // 1. Patch in-memory tree
    this.#items = this.#patchNodeFields(this.#items, id, fields);

    // 2. Attempt surgical DOM update
    let li = null;
    try {
      li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    } catch (_) {
      li = this.#el.querySelector(`[data-id="${id}"]`);
    }

    if (li) {
      if (fields.method != null) {
        const badge = li.querySelector(".tree-node__method");
        if (badge) {
          badge.textContent = fields.method;
          badge.className   = `tree-node__method method--${fields.method.toLowerCase()}`;
        }
      }
      if (fields.url != null) {
        const urlEl = li.querySelector(".tree-node__url");
        if (urlEl) urlEl.textContent = fields.url;
      }
    } else {
      // Node not visible (e.g. inside a collapsed collection) — full re-render.
      this.#rerender();
    }

    // 3. Persist (unless the caller has opted out to handle saving themselves)
    if (!silent) this.#emitChange();
  }

  /** Recursively return a new tree with the fields of `targetId` merged. */
  #patchNodeFields(nodes, targetId, fields) {
    return nodes.map((node) => {
      if (node.id === targetId) return { ...node, ...fields };
      if (Array.isArray(node.children) && node.children.length > 0) {
        return { ...node, children: this.#patchNodeFields(node.children, targetId, fields) };
      }
      return node;
    });
  }

  /**
   * Insert `newNode` immediately before the node with `beforeId`.
   * Searches recursively through the tree.
   */
  #insertBefore(nodes, beforeId, newNode) {
    const result = [];
    for (const node of nodes) {
      if (node.id === beforeId) {
        result.push(newNode, node);
        continue;
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        const newChildren = this.#insertBefore(node.children, beforeId, newNode);
        if (newChildren.length > node.children.length) {
          result.push({ ...node, children: newChildren });
          continue;
        }
      }
      result.push(node);
    }
    return result;
  }

  /**
   * Programmatically select a request node by ID, as if the user clicked it.
   * Used to restore the last-selected request on page/app reload.
   * Collections always start expanded, so the node's <li> is always in the DOM
   * immediately after setItems() is called.
   *
   * @param {string} id
   * @returns {boolean} true if the node was found and selected
   */
  selectById(id) {
    if (!id) return false;
    const node = this.#findNode(this.#items, id);
    if (!node || node.type !== "request") return false;

    let li;
    try {
      li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    } catch (_) {
      li = this.#el.querySelector(`[data-id="${id}"]`);
    }
    if (!li) return false;

    this.#selectRequest(node, li);
    return true;
  }
}
