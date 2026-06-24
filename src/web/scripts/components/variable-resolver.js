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
 * variable-resolver.js — Variable resolution utilities for the pill editor.
 *
 * A "context" object carries:
 *   {
 *     globalVariables?:      { name: value, … }   — lowest priority
 *     environmentVariables?: { name: value, … }   — selected named env
 *     collectionVariables?:         { name: value, … }   — collection-level
 *     folderChain?:          [ { variables: {…} }, … ] — highest; nearest-ancestor first
 *   }
 *
 * Each scope may carry a parallel `secure*` Set naming the variables stored as
 * secrets (folder entries use `secureVariables`; collection/environment/global
 * use `secureCollectionVariables` / `secureEnvironmentVariables` / `secureGlobalVariables`).
 * resolveVariable() reports a `secure` flag for the winning scope so callers can
 * mask secret values.
 */

"use strict";

import { logicMap } from "./function-logic-map.js";

/**
 * Return true when `content` (the text inside {{…}}) is a function call.
 * @param {string} content
 */
export function isFunctionCall(content) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(content.trim());
}

/**
 * Parse a function-call token into name + positional string args.
 * Handles quoted string literals and bare identifiers as args.
 * Nested {{…}} tokens inside args are NOT supported in this implementation.
 *
 * @param {string} content  e.g. `now("ISO")` or `uuid()`
 * @returns {{ name: string, rawArgs: string[] } | null}
 */
export function parseFunctionCall(content) {
  const trimmed = content.trim();
  const parenIdx = trimmed.indexOf("(");
  if (parenIdx === -1) return null;

  const name = trimmed.slice(0, parenIdx).trim();
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return null;

  const closeIdx = trimmed.lastIndexOf(")");
  if (closeIdx === -1 || closeIdx < parenIdx) return null;

  const argsStr = trimmed.slice(parenIdx + 1, closeIdx).trim();
  if (!argsStr) return { name, rawArgs: [] };

  // Split by comma, respecting double-quoted strings with backslash escapes —
  // the inverse of buildFunctionToken() below (which escapes `\` and `"`).
  const unquote = (arg) =>
    arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')
      ? arg.slice(1, -1).replace(/\\(["\\])/g, "$1")
      : arg;
  const rawArgs = [];
  let current = "";
  let inQuote = false;
  let escaped = false;
  for (const ch of argsStr) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\" && inQuote) {
      current += ch;
      escaped = true;
    } else if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === "," && !inQuote) {
      rawArgs.push(unquote(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) rawArgs.push(unquote(last));

  return { name, rawArgs };
}

/**
 * Build a `{{name(...)}}` function-call token from a name and positional args.
 * Each arg is serialized as a double-quoted string literal with backslash and
 * quote escaping — the inverse of parseFunctionCall().
 *
 * @param {string} name
 * @param {string[]} [rawArgs]
 * @returns {string}  e.g. `{{uuid()}}` or `{{now("ISO", "utc")}}`
 */
export function buildFunctionToken(name, rawArgs = []) {
  if (!rawArgs.length) return `{{${name}()}}`;
  const argStrs = rawArgs
    .map((a) => `"${String(a).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(", ");
  return `{{${name}(${argStrs})}}`;
}

/**
 * Safely parse a function pill's `data-fn-args` attribute. It is normally JSON
 * written by makeFunctionPill, but a corrupted import or a manual DOM tamper can
 * leave it malformed — and an unguarded JSON.parse there throws out of the
 * universal serializeEditor() / getValue() read path, making the request
 * unsaveable and unsendable (one bad pill would brick the editor). Falls back to
 * an empty arg list rather than throwing.
 *
 * @param {string|undefined|null} raw  the data-fn-args attribute value
 * @returns {Array} parsed args, or [] when absent / corrupt / non-array
 */
export function parseFnArgs(raw) {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a variable name against the provided context.
 * Priority order (highest → lowest): folder chain → collection → environment → global.
 *
 * @param {string} name
 * @param {{ globalVariables?: object, environmentVariables?: object, collectionVariables?: object, folderChain?: object[] } | null} context
 * @returns {{ found: boolean, value: any, source: 'folder' | 'collection' | 'environment' | 'global' | null, secure: boolean }}
 */
export function resolveVariable(name, context) {
  if (!name || !context)
    return { found: false, value: undefined, source: null, secure: false };

  // 1. Walk folder chain nearest-to-farthest
  if (Array.isArray(context.folderChain)) {
    for (const folder of context.folderChain) {
      const vars = folder?.variables;
      if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
        return {
          found: true,
          value: vars[name],
          source: "folder",
          secure: !!folder?.secureVariables?.has?.(name),
        };
      }
    }
  }

  // 2. Collection-level variables
  const envVars = context.collectionVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(envVars, name)) {
    return {
      found: true,
      value: envVars[name],
      source: "collection",
      secure: !!context.secureCollectionVariables?.has?.(name),
    };
  }

  // 3. Selected environment variables
  const environmentVars = context.environmentVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(environmentVars, name)) {
    return {
      found: true,
      value: environmentVars[name],
      source: "environment",
      secure: !!context.secureEnvironmentVariables?.has?.(name),
    };
  }

  // 4. Global variables
  const globalVars = context.globalVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(globalVars, name)) {
    return {
      found: true,
      value: globalVars[name],
      source: "global",
      secure: !!context.secureGlobalVariables?.has?.(name),
    };
  }

  return { found: false, value: undefined, source: null, secure: false };
}

/**
 * Enumerate the variable scopes carried by `context` in resolution-priority
 * order (folder chain nearest-first → collection → environment → global), the
 * same order resolveVariable() walks. Each entry pairs the scope's variable map
 * with a `source` tag so callers can collect names or render grouped sections
 * without re-encoding which context keys are scopes. Absent/empty scopes are
 * skipped; folder-chain entries are returned individually, one per folder.
 *
 * @param {{ globalVariables?: object, environmentVariables?: object, collectionVariables?: object, folderChain?: object[] } | null} context
 * @returns {Array<{ source: 'folder' | 'collection' | 'environment' | 'global', vars: object }>}
 */
export function collectScopes(context) {
  if (!context) return [];
  const scopes = [];
  if (Array.isArray(context.folderChain)) {
    for (const folder of context.folderChain) {
      if (folder?.variables)
        scopes.push({ source: "folder", vars: folder.variables });
    }
  }
  if (context.collectionVariables)
    scopes.push({ source: "collection", vars: context.collectionVariables });
  if (context.environmentVariables)
    scopes.push({ source: "environment", vars: context.environmentVariables });
  if (context.globalVariables)
    scopes.push({ source: "global", vars: context.globalVariables });
  return scopes;
}

/**
 * Flatten every scope in `context` to a de-duplicated list of variable names in
 * resolution-priority order (folder chain → collection → environment → global;
 * first occurrence wins). Names within each scope are sorted alphabetically.
 *
 * @param {object | null} context
 * @returns {string[]}
 */
export function collectScopeNames(context) {
  const seen = new Set();
  for (const { vars } of collectScopes(context)) {
    for (const name of Object.keys(vars).sort()) seen.add(name);
  }
  return [...seen];
}

/**
 * Tokenize a string into plain-text and variable segments.
 * Variable syntax: {{name}}  — no nested braces, name must be non-empty.
 *
 * @param {string} text
 * @returns {Array<{type: 'text' | 'variable', content: string}>}
 */
export function tokenize(text) {
  const tokens = [];
  const re = /\{\{([^{}]+)\}\}/g;
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }
    tokens.push({ type: "variable", content: match[1] });
    lastIndex = re.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", content: text.slice(lastIndex) });
  }

  return tokens;
}

/**
 * Serialize a pill editor's DOM back to a plain-text string.
 * – Text nodes → their textContent verbatim.
 * – Pill spans (data-variable) → {{name}}.
 * – Trailing <br> elements (contenteditable artefacts) → ignored.
 *
 * @param {HTMLElement} el
 * @returns {string}
 */
export function serializeEditor(el) {
  let out = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Strip zero-width spaces used as invisible caret-anchor guards
      out += child.textContent.replace(/\u200B/g, "");
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.dataset && child.dataset.variable !== undefined) {
        out += `{{${child.dataset.variable}}}`;
      } else if (child.dataset && child.dataset.function !== undefined) {
        const rawArgs = parseFnArgs(child.dataset.fnArgs);
        out += buildFunctionToken(child.dataset.function, rawArgs);
      } else if (child.tagName !== "BR") {
        out += serializeEditor(child);
      }
    }
  }
  return out;
}

/**
 * Cap on concurrent async token resolutions. Function pills (`{{hmac()}}`,
 * `{{hash()}}`, `{{environmentVariable()}}`) each delegate to the main process
 * over IPC (or, on the dev-server path, fetch); a template carrying many of them
 * would otherwise fire them ALL at once — flooding the bridge and opening a burst
 * of sockets. 8 keeps resolution responsive without serializing it.
 */
export const MAX_RESOLVE_CONCURRENCY = 8;

/**
 * Map `fn` over `items` with at most `limit` calls in flight at once, preserving
 * input order in the result array. Plain-text tokens resolve instantly, so this
 * effectively bounds the number of concurrent backend calls.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/**
 * Async version of resolveString that also evaluates function calls.
 * Function handlers may return Promises (backend-delegated functions).
 *
 * Single-pass by design: each `{{token}}` is resolved exactly once and the
 * resolved output is NOT re-scanned, so a value that itself contains `{{…}}`
 * is emitted verbatim rather than expanded. This both matches user expectation
 * (variables hold literal values, not nested templates) and makes circular
 * references impossible — there is no recursion to loop.
 *
 * Backend-delegated function pills are evaluated with bounded concurrency
 * (MAX_RESOLVE_CONCURRENCY) so a template with many of them can't fire an
 * unbounded burst of IPC/fetch calls; output order is preserved regardless.
 *
 * @param {string} template
 * @param {object | null} context
 * @returns {Promise<string>}
 */
export async function resolveStringAsync(template, context) {
  if (!template) return template ?? "";

  const tokens = tokenize(template);
  const parts = await mapLimit(
    tokens,
    MAX_RESOLVE_CONCURRENCY,
    async (token) => {
      if (token.type === "text") return token.content;

      const content = token.content.trim();
      if (isFunctionCall(content)) {
        const parsed = parseFunctionCall(content);
        if (!parsed) return `{{${token.content}}}`;
        const handler = logicMap[parsed.name];
        if (!handler) return `{{${token.content}}}`;
        try {
          return String(await handler(parsed.rawArgs, context));
        } catch (e) {
          return `[error: ${e.message}]`;
        }
      }

      const { found, value } = resolveVariable(content, context);
      // On miss, re-emit the original token verbatim (untrimmed) so user text
      // like `{{ name }}` is preserved, matching the function-call branch above.
      return found ? String(value ?? "") : `{{${token.content}}}`;
    },
  );

  return parts.join("");
}

/**
 * Scan one or more template strings and return every {{varName}} token found,
 * together with its resolution status.  Results are deduplicated by name —
 * first occurrence wins for found / value when the same name appears in
 * multiple strings.
 *
 * @param {string[]} templates
 * @param {{ collectionVariables?: object, folderChain?: object[] } | null} context
 * @returns {Array<{ name: string, found: boolean, value: string|null }>}
 */
export function collectTemplateVariables(templates, context) {
  const seen = new Map();
  const re = /\{\{([^{}]+)\}\}/g;

  for (const tpl of templates) {
    if (!tpl) continue;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(tpl)) !== null) {
      const name = match[1].trim();
      if (!name || seen.has(name)) continue;
      if (isFunctionCall(name)) continue; // function pills resolve at send time, not here
      const { found, value } = resolveVariable(name, context);
      seen.set(name, { name, found, value: found ? String(value) : null });
    }
  }

  return [...seen.values()];
}

/**
 * Resolve all {{varName}} occurrences in a template string, substituting
 * each variable's resolved value.  Variables that cannot be resolved are
 * left as-is ({{varName}}) so the caller can still see what was unresolved.
 *
 * @param {string} template
 * @param {{ collectionVariables?: object, folderChain?: object[] } | null} context
 * @returns {string}
 */
export function resolveString(template, context) {
  if (!template || !context) return template ?? "";
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, name) => {
    const result = resolveVariable(name.trim(), context);
    return result.found ? String(result.value) : `{{${name}}}`;
  });
}

/**
 * Build the ancestor folder chain for a given node ID within a tree.
 * Returns an array of folder/collection nodes ordered nearest-to-farthest,
 * NOT including the node itself.
 *
 * @param {object[]} items   Root-level tree items
 * @param {string}   nodeId  ID of the selected request / folder
 * @returns {object[]}
 */
export function buildFolderChain(items, nodeId) {
  /**
   * @param {object[]} nodes
   * @param {object[]} ancestors — nearest first (accumulated during recursion)
   * @returns {object[] | null}
   */
  function search(nodes, ancestors) {
    for (const node of nodes) {
      if (node.id === nodeId) return ancestors;
      if (Array.isArray(node.children)) {
        const found = search(node.children, [node, ...ancestors]);
        if (found) return found;
      }
    }
    return null;
  }

  return search(items, []) ?? [];
}
