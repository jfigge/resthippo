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

"use strict";

/**
 * profile-controller.js — orchestration for scoped variable profiles.
 *
 * Owns everything stateful about profiles that used to sit as module-level
 * bindings and free functions in app.js: which folder the variable editor is
 * showing, and every create / rename / select / delete path. `profile-scope.js`
 * answers "what is visible where", `folder-profiles.js` "what does a value mean";
 * this coordinates them with the tree, the manifest and the two selectors.
 *
 * ## The two tiers
 *
 * A profile is owned either by the COLLECTION (`entry.variableProfiles` on the
 * manifest — visible everywhere in that collection) or by ONE FOLDER
 * (`node.profiles` on its tree node — visible to it and its descendants). Where a
 * new profile lands is the user's choice at creation time.
 *
 * ## The active selection
 *
 * One profile is active per OWNER, in `entry.activeVariableProfileIds`
 * (`{ [ownerKey]: profileId }`). Selections layer at send time, outermost owner
 * first. The map lives on the manifest rather than the tree so a selection never
 * travels on export and switching one never dirties the tree.
 *
 * ## Dependencies
 *
 * Injected as accessors (the same shape as app.js's bus context) so the whole
 * controller is constructible in a test with plain objects — no DOM, no IPC.
 */

import {
  COLLECTION_OWNER_KEY,
  profileGroupsForNode,
  flattenGroups,
  activeIdsForGroups,
  ownerOfProfile,
  pruneActiveSelections,
} from "./profile-scope.js";
import {
  migrateProfileScopes,
  PROFILE_SCOPE_VERSION,
} from "./profile-migration.js";
import {
  effectiveProfileVars,
  removeProfileFromFolder,
  MAX_NAMED_PROFILES,
} from "./folder-profiles.js";

/** Scope values the vars-editor's [+] popup can commit. */
export const PROFILE_SCOPE_FOLDER = "folder";
export const PROFILE_SCOPE_COLLECTION = "collection";

const isContainer = (n) =>
  !!n && typeof n === "object" && n.type === "collection";

/** Recursively find a node by id (the tree is nested, with no id index). */
function findNode(nodes, id) {
  for (const n of nodes ?? []) {
    if (n?.id === id) return n;
    if (Array.isArray(n?.children)) {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Rebuild a tree with `fn(node)` applied to the container at `id`. */
function mapContainer(nodes, id, fn) {
  return (nodes ?? []).map((n) => {
    if (!isContainer(n)) return n;
    const next = n.id === id ? fn(n) : { ...n };
    if (Array.isArray(n.children))
      next.children = mapContainer(n.children, id, fn);
    return next;
  });
}

/** Rebuild a tree with `fn(node)` applied to every container. */
function mapAllContainers(nodes, fn) {
  return (nodes ?? []).map((n) => {
    if (!isContainer(n)) return n;
    const next = fn(n);
    if (Array.isArray(n.children))
      next.children = mapAllContainers(n.children, fn);
    return next;
  });
}

export class ProfileController {
  /** @type {{nodeId: string, name: string}|null} The folder the vars editor shows. */
  #varsScope = null;

  #deps;

  /**
   * @param {object} deps
   * @param {() => object} deps.getCollections        the `currentColls` state
   * @param {(next: object) => void} deps.setCollections
   * @param {(payload: object) => Promise<any>} deps.saveManifest
   * @param {(items: object[]) => Promise<any>} deps.saveTree  persist the tree
   * @param {() => object|null} deps.getTreeView
   * @param {() => object|null} deps.getVarsEditor
   * @param {() => object|null} deps.getRequestEditor
   * @param {() => object} deps.getSettings
   * @param {() => string|null} deps.getSelectedRequestId
   * @param {() => void} deps.refreshContext   rebuild the live variable context
   * @param {(key: string, params?: object) => string} deps.t
   * @param {{warning: Function, info: Function}} deps.notify
   */
  constructor(deps) {
    this.#deps = deps;
  }

  // ── State the vars editor drives ───────────────────────────────────────────

  /** Remember which folder the variable editor is showing (null = none). */
  setVarsScope(scope) {
    this.#varsScope = scope ?? null;
  }

  getVarsScope() {
    return this.#varsScope;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The active collection's manifest entry (profile list + selections). */
  activeEntry() {
    const colls = this.#deps.getCollections();
    return (
      colls?.collections?.find((c) => c.id === colls.activeCollectionId) ?? null
    );
  }

  /** COLLECTION-TIER profiles — the outermost owner, visible everywhere. */
  collectionProfiles() {
    return this.activeEntry()?.variableProfiles ?? [];
  }

  /** `{ [ownerKey]: profileId }` — one active profile per owner. */
  activeByOwner() {
    return this.activeEntry()?.activeVariableProfileIds ?? {};
  }

  #items() {
    return this.#deps.getTreeView()?.getItems() ?? [];
  }

  /** The owner groups visible at `nodeId`, outermost → innermost. */
  groupsFor(nodeId) {
    return profileGroupsForNode({
      items: this.#items(),
      nodeId,
      collectionProfiles: this.collectionProfiles(),
      collectionLabel: this.activeEntry()?.name ?? "",
    });
  }

  /**
   * The node the request-editor switcher and ⌥⌘0–9 act relative to: the selected
   * request, falling back to the folder open in the variable editor.
   */
  contextNodeId() {
    return this.#deps.getSelectedRequestId() ?? this.#varsScope?.nodeId ?? null;
  }

  /**
   * The profile whose overrides the variable editor edits at `nodeId`: the
   * INNERMOST active profile in scope there. That is the one whose values the
   * rows show, and the one the selector displays as chosen.
   */
  editingProfileId(nodeId) {
    const ids = activeIdsForGroups(
      this.groupsFor(nodeId),
      this.activeByOwner(),
    );
    return ids.length ? ids[ids.length - 1] : null;
  }

  // ── Pushing state to the two selectors ─────────────────────────────────────

  /**
   * Feed the request editor's switcher the groups visible at the current request
   * plus the per-owner selection. An empty group list hides the switcher.
   */
  pushToEditor() {
    const nodeId = this.contextNodeId();
    this.#deps.getRequestEditor()?.setProfiles({
      groups: this.groupsFor(nodeId),
      activeByOwner: this.activeByOwner(),
    });
  }

  /** Feed the tree view what it needs to resolve cURL / code-gen under profiles. */
  pushToTree() {
    this.#deps.getTreeView()?.setProfileState({
      collectionProfiles: this.collectionProfiles(),
      activeByOwner: this.activeByOwner(),
    });
  }

  /** Show a folder in the variable editor under the profile being edited there. */
  loadFolderVars(nodeId, name) {
    const node = findNode(this.#items(), nodeId);
    const groups = this.groupsFor(nodeId);
    const editingProfileId = this.editingProfileId(nodeId);
    this.#deps.getVarsEditor()?.load({
      scopeId: nodeId,
      scopeName: name,
      variables: effectiveProfileVars(
        node?.variables ?? [],
        node?.profileValues,
        editingProfileId,
      ),
      bulkEditor: this.#deps.getSettings()?.varsBulkEditor ?? true,
      profilesEnabled: true,
      profileGroups: groups,
      editingProfileId,
      activeByOwner: this.activeByOwner(),
      // Rename / delete are only offered where the profile is defined.
      ownerKey: nodeId,
    });
  }

  /** Reload the variable editor if it is showing a folder. */
  #reloadVarsEditor() {
    if (this.#varsScope) {
      this.loadFolderVars(this.#varsScope.nodeId, this.#varsScope.name);
    }
  }

  /** Everything that mirrors profile state, after a change. */
  #refreshAll() {
    this.#reloadVarsEditor();
    this.#deps.refreshContext();
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Patch the active collection's manifest entry and persist it. */
  async #patchEntry(patch) {
    const colls = this.#deps.getCollections();
    const id = colls.activeCollectionId;
    const collections = colls.collections.map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    );
    this.#deps.setCollections({ ...colls, collections });
    await this.#deps.saveManifest({ collections, activeCollectionId: id });
  }

  /** Replace the live tree and persist it. */
  async #writeTree(items) {
    const tv = this.#deps.getTreeView();
    if (!tv) return;
    tv.setItems(items);
    await this.#deps.saveTree(items);
  }

  /**
   * Create a profile. `scope` decides its owner: "folder" puts it on the folder
   * currently open in the variable editor, "collection" on the manifest entry.
   * The new profile is made ACTIVE for its owner, so the editor immediately shows
   * the Default's variable names with cleared values ready to fill in.
   *
   * @param {{name: string, scope?: string}} payload
   */
  async add({ name, scope = PROFILE_SCOPE_FOLDER }) {
    const { t, notify } = this.#deps;
    const trimmed = (name ?? "").trim();
    const entry = this.activeEntry();
    if (!trimmed || !entry) return;

    const toCollection = scope === PROFILE_SCOPE_COLLECTION;
    const folderId = this.#varsScope?.nodeId ?? null;
    if (!toCollection && !folderId) return; // no folder open to own it

    // The cap is per OWNER; the total visible at a deep folder may exceed it.
    const siblings = toCollection
      ? this.collectionProfiles()
      : (findNode(this.#items(), folderId)?.profiles ?? []);
    if (siblings.length >= MAX_NAMED_PROFILES) {
      notify.warning(t("profiles.limitOwner", { max: MAX_NAMED_PROFILES }));
      return;
    }
    // A name only has to be unique within everything visible here — two
    // unrelated branches may each have their own "Prod".
    const visible = flattenGroups(this.groupsFor(folderId ?? null));
    if (visible.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      notify.warning(t("profiles.duplicate", { name: trimmed }));
      return;
    }

    const id = crypto.randomUUID();
    const ownerKey = toCollection ? COLLECTION_OWNER_KEY : folderId;
    const activeVariableProfileIds = {
      ...this.activeByOwner(),
      [ownerKey]: id,
    };

    if (toCollection) {
      await this.#patchEntry({
        variableProfiles: [...this.collectionProfiles(), { id, name: trimmed }],
        activeVariableProfileIds,
      });
    } else {
      await this.#writeTree(
        mapContainer(this.#items(), folderId, (n) => ({
          ...n,
          profiles: [...(n.profiles ?? []), { id, name: trimmed }],
        })),
      );
      await this.#patchEntry({ activeVariableProfileIds });
    }
    this.#refreshAll();
  }

  /**
   * Rename a profile in place. Ids are what `profileValues` key on, so a rename
   * touches only the owner's definition list. The Default has no id and can't be
   * renamed; a blank or (in-scope) duplicate name is rejected.
   */
  async rename({ profileId, name }) {
    const { t, notify } = this.#deps;
    const trimmed = (name ?? "").trim();
    if (!profileId || !trimmed || !this.activeEntry()) return;

    const nodeId = this.#varsScope?.nodeId ?? this.contextNodeId();
    const owner = ownerOfProfile(this.groupsFor(nodeId), profileId);
    if (!owner) return;
    const current = owner.profiles.find((p) => p.id === profileId);
    if (!current || current.name === trimmed) return;

    const visible = flattenGroups(this.groupsFor(nodeId));
    if (
      visible.some(
        (p) =>
          p.id !== profileId && p.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      notify.warning(t("profiles.duplicate", { name: trimmed }));
      return;
    }

    const renameIn = (list) =>
      (list ?? []).map((p) =>
        p.id === profileId ? { ...p, name: trimmed } : p,
      );

    if (owner.tier === "collection") {
      await this.#patchEntry({
        variableProfiles: renameIn(this.collectionProfiles()),
      });
    } else {
      await this.#writeTree(
        mapContainer(this.#items(), owner.ownerId, (n) => ({
          ...n,
          profiles: renameIn(n.profiles),
        })),
      );
    }
    // A rename changes no values, so no variable-context rebuild is needed — but
    // both selectors show the name.
    this.#reloadVarsEditor();
    this.pushToEditor();
  }

  /**
   * Activate a profile for its owner, or clear one or all owners.
   *
   *   • `{ ownerKey, profileId }`  → that owner switches to that profile.
   *   • `{ ownerKey, profileId: null }` → that owner falls back to its Default.
   *   • `{ ownerKey: null }`       → every owner IN SCOPE at the current node
   *     falls back to Default. Owners outside this scope keep their selection, so
   *     stepping into another branch and back restores what was there.
   */
  async select({ ownerKey, profileId }) {
    if (!this.activeEntry()) return;
    const current = this.activeByOwner();
    let next;
    if (ownerKey == null) {
      next = { ...current };
      for (const g of this.groupsFor(this.contextNodeId()))
        delete next[g.ownerKey];
    } else {
      next = { ...current };
      if (profileId) next[ownerKey] = profileId;
      else delete next[ownerKey];
    }
    await this.#patchEntry({ activeVariableProfileIds: next });
    this.#refreshAll();
  }

  /**
   * The ⌥⌘0–9 shortcut. Slot 0 clears every in-scope owner; slots 1–9 address the
   * Nth profile visible at the current node in outermost→innermost order and
   * activate it, replacing only its OWN owner's selection. A slot with no profile,
   * or one already active, is a silent no-op — the shortcut can fire with no
   * variable editor open, so only a real change is announced.
   */
  async selectSlot(slot) {
    const { t, notify } = this.#deps;
    if (!this.activeEntry()) return;
    const nodeId = this.contextNodeId();
    const groups = this.groupsFor(nodeId);
    if (!groups.length) return;

    if (slot === 0) {
      if (!activeIdsForGroups(groups, this.activeByOwner()).length) return;
      await this.select({ ownerKey: null });
      notify.info(t("profiles.switchedAllDefault"));
      return;
    }
    const target = flattenGroups(groups)[slot - 1];
    if (!target) return;
    if (this.activeByOwner()[target.ownerKey] === target.id) return;
    await this.select({ ownerKey: target.ownerKey, profileId: target.id });
    notify.info(
      t("profiles.switchedScoped", {
        name: target.name,
        owner: target.ownerName,
      }),
    );
  }

  /**
   * Delete a profile: drop its definition from its owner, prune every folder's
   * overrides for it, and clear any selection naming it. Pruning runs across the
   * whole tree — overrides can only exist inside the owner's subtree, so this is a
   * superset and stays correct if a folder was moved after the values were set.
   */
  async remove({ profileId }) {
    const entry = this.activeEntry();
    if (!entry || !profileId) return;
    const nodeId = this.#varsScope?.nodeId ?? this.contextNodeId();
    const owner = ownerOfProfile(this.groupsFor(nodeId), profileId);
    if (!owner) return;

    const activeVariableProfileIds = Object.fromEntries(
      Object.entries(this.activeByOwner()).filter(([, id]) => id !== profileId),
    );

    let items = mapAllContainers(this.#items(), (n) =>
      n.profileValues
        ? {
            ...n,
            profileValues: removeProfileFromFolder(n.profileValues, profileId),
          }
        : { ...n },
    );
    if (owner.tier === "folder") {
      items = mapContainer(items, owner.ownerId, (n) => ({
        ...n,
        profiles: (n.profiles ?? []).filter((p) => p.id !== profileId),
      }));
    }
    await this.#writeTree(items);
    await this.#patchEntry({
      ...(owner.tier === "collection"
        ? {
            variableProfiles: this.collectionProfiles().filter(
              (p) => p.id !== profileId,
            ),
          }
        : {}),
      activeVariableProfileIds,
    });
    this.#refreshAll();
  }

  /**
   * Forget selections whose owner folder or profile no longer exists — a folder
   * that owned profiles was deleted, or a profile was removed elsewhere. Persists
   * only when something was actually stale.
   *
   * @returns {Promise<boolean>} whether anything was pruned
   */
  async pruneStale() {
    if (!this.activeEntry()) return false;
    const { map, changed } = pruneActiveSelections(this.activeByOwner(), {
      items: this.#items(),
      collectionProfiles: this.collectionProfiles(),
    });
    if (!changed) return false;
    await this.#patchEntry({ activeVariableProfileIds: map });
    return true;
  }

  /**
   * Move this collection's pre-scoping collection-wide profiles down to the
   * folders that own them. Runs once per collection, the first time its tree is
   * loaded; a stamped collection is a no-op.
   *
   * The TREE is written FIRST. A crash between the two writes then leaves a
   * profile listed in both tiers — visible twice, ugly, and fully recoverable.
   * The other order would drop it from the manifest before it landed on the node,
   * losing it outright.
   *
   * The live tree is updated in place when profiles moved, so callers need only
   * await this after the collection's state has settled.
   *
   * @param {object[]} items  the freshly loaded tree
   * @returns {Promise<object[]>} the tree to use (rewritten when profiles moved)
   */
  async migrateIfNeeded(items) {
    const entry = this.activeEntry();
    if (!entry) return items;
    const out = migrateProfileScopes({
      items,
      variableProfiles: entry.variableProfiles,
      activeVariableProfileId: entry.activeVariableProfileId,
      activeVariableProfileIds: entry.activeVariableProfileIds,
      profileScopeVersion: entry.profileScopeVersion,
    });
    if (!out.changed) return items;

    if (out.moved.length) await this.#writeTree(out.items);
    await this.#patchEntry({
      variableProfiles: out.variableProfiles,
      activeVariableProfileIds: out.activeVariableProfileIds,
      profileScopeVersion: PROFILE_SCOPE_VERSION,
      // The single legacy selection is now represented in the per-owner map.
      activeVariableProfileId: undefined,
    });
    return out.items;
  }
}
