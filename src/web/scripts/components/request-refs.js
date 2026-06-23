/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * request-refs.js — resolving cross-request references by id (with name
 * fallback) and migrating legacy name-based references to ids.
 *
 * Four function pills reference another saved request by its first arg (the
 * `request-picker` param): `run`, `response`, `responseHeader`, `responseStatus`.
 * The scripting `hippo.run("…")` API references one the same way. Historically
 * the reference was the request *name*, which is ambiguous when two requests
 * share a name and breaks when a request is renamed. The canonical reference is
 * now the request's stable id; this module resolves a stored reference that may
 * be EITHER an id (new) or a name (legacy tokens, and the inherently name-keyed
 * script API) and rewrites name-based pill tokens to ids on save.
 */
"use strict";

import {
  tokenize,
  isFunctionCall,
  parseFunctionCall,
  buildFunctionToken,
} from "./variable-resolver.js";

/**
 * Function names whose FIRST positional arg is a request reference. Single
 * source of truth shared by the picker UI, the cross-request cache prefetch,
 * the pill tooltip, and the lazy name→id migration.
 */
export const REQUEST_PICKER_FNS = new Set([
  "run",
  "response",
  "responseHeader",
  "responseStatus",
]);

/**
 * Flatten the item tree into request descriptors carrying their tree path.
 * @param {Array} items  tree nodes (collections / folders / requests)
 * @returns {Array<{ id: string, name: string, path: string[] }>}
 *          `path` = ancestor names from the root collection down to the
 *          immediate parent folder (excludes the request itself).
 */
export function flattenRequests(items) {
  const out = [];
  const walk = (nodes, path) => {
    for (const node of nodes ?? []) {
      if (node.type === "request") {
        out.push({ id: node.id, name: node.name ?? "", path });
      }
      if (Array.isArray(node.children)) {
        walk(node.children, [...path, node.name ?? ""]);
      }
    }
  };
  walk(items, []);
  return out;
}

/**
 * Resolve a request reference (an id or a name) against the flat request list.
 * Prefers an exact id match; falls back to a name match (first in tree order),
 * flagging `ambiguous` when more than one request shares that name.
 *
 * @param {Array<{id:string,name:string,path:string[]}>} requests  flat list
 * @param {string} ref  stored reference — an id or a name
 * @returns {{ found:boolean, id:string, name:string, path:string[], ambiguous:boolean }}
 */
export function resolveRequestRef(requests, ref) {
  const miss = { found: false, id: "", name: "", path: [], ambiguous: false };
  if (!ref || !Array.isArray(requests)) return miss;
  const byId = requests.find((r) => r.id === ref);
  if (byId) {
    return {
      found: true,
      id: byId.id,
      name: byId.name,
      path: byId.path ?? [],
      ambiguous: false,
    };
  }
  const named = requests.filter((r) => r.name === ref);
  if (named.length === 0) return miss;
  const first = named[0];
  return {
    found: true,
    id: first.id,
    name: first.name,
    path: first.path ?? [],
    ambiguous: named.length > 1,
  };
}

/**
 * Group the flat request list by folder path for a request-picker `<select>`,
 * so each folder becomes a non-selectable `<optgroup>` header with its requests
 * listed (and natively indented) beneath it — the way duplicate names are told
 * apart. Requests sharing a path are merged into one group; groups keep
 * first-appearance (tree) order, as do the requests within each group. The empty
 * path (a request with no ancestors) yields a group whose `pathText` is "" — the
 * caller renders those options ungrouped.
 *
 * @param {Array<{id:string,name:string,path:string[]}>} requests  flat list
 * @returns {Array<{ pathText:string, requests: Array<{id:string,name:string}> }>}
 */
export function requestPickerGroups(requests) {
  const list = Array.isArray(requests) ? requests : [];
  const groups = new Map(); // pathText → group
  for (const r of list) {
    const pathText = (r.path ?? []).join("/");
    let group = groups.get(pathText);
    if (!group) {
      group = { pathText, requests: [] };
      groups.set(pathText, group);
    }
    group.requests.push({ id: r.id, name: r.name });
  }
  return [...groups.values()];
}

/**
 * Migrate a single reference from a name to its id when it uniquely resolves by
 * name. Returns the reference UNCHANGED when it is already an id, when the name
 * is ambiguous (>1 match), or when nothing matches — so the call is idempotent
 * and never loses a reference it cannot safely rewrite.
 *
 * @param {string} ref
 * @param {Array<{id:string,name:string}>} requests  flat list
 * @returns {string}
 */
export function migrateRef(ref, requests) {
  if (!ref || !Array.isArray(requests)) return ref;
  if (requests.some((r) => r.id === ref)) return ref; // already an id
  const named = requests.filter((r) => r.name === ref);
  return named.length === 1 ? named[0].id : ref;
}

/**
 * Rewrite request-picker tokens (`{{run("Name")}}`, `{{response("Name", …)}}`)
 * inside `str` so the request reference is stored by id. Only the first arg is
 * touched; every other token and all surrounding text round-trips verbatim.
 *
 * @param {string} str
 * @param {Array<{id:string,name:string}>} requests  flat list
 * @returns {{ text:string, changed:boolean }}
 */
export function migrateTokensInString(str, requests) {
  if (typeof str !== "string" || str.indexOf("{{") === -1) {
    return { text: str, changed: false };
  }
  let changed = false;
  const text = tokenize(str)
    .map((tok) => {
      if (tok.type === "text") return tok.content;
      const content = tok.content.trim();
      if (!isFunctionCall(content)) return `{{${tok.content}}}`;
      const parsed = parseFunctionCall(content);
      if (!parsed || !REQUEST_PICKER_FNS.has(parsed.name)) {
        return `{{${tok.content}}}`;
      }
      const ref = parsed.rawArgs[0] ?? "";
      const migrated = migrateRef(ref, requests);
      if (migrated === ref) return `{{${tok.content}}}`;
      changed = true;
      const newArgs = parsed.rawArgs.slice();
      newArgs[0] = migrated;
      return buildFunctionToken(parsed.name, newArgs);
    })
    .join("");
  return { text: changed ? text : str, changed };
}

/**
 * Deep-walk a request node (or a partial field patch) and migrate every
 * request-picker token in any string leaf from a name to an id. The `id` key is
 * left alone, and `children` sub-nodes (which persist independently) are not
 * descended into. Returns the original input unchanged when nothing matched,
 * else a fresh structure, plus a `changed` flag.
 *
 * @param {object} node  request node or field-delta patch
 * @param {Array<{id:string,name:string}>} requests  flat list
 * @returns {{ node:object, changed:boolean }}
 */
export function migrateRequestNodeRefs(node, requests) {
  let changed = false;
  const walk = (val, key) => {
    if (typeof val === "string") {
      if (key === "id") return val;
      const r = migrateTokensInString(val, requests);
      if (r.changed) changed = true;
      return r.text;
    }
    if (Array.isArray(val)) return val.map((v) => walk(v, key));
    if (val && typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = k === "children" ? v : walk(v, k);
      }
      return out;
    }
    return val;
  };
  const result = walk(node, null);
  return { node: changed ? result : node, changed };
}
