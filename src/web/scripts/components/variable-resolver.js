/**
 * variable-resolver.js — Variable resolution utilities for the pill editor.
 *
 * A "context" object carries:
 *   {
 *     globalVariables?:      { name: value, … }   — lowest priority
 *     environmentVariables?: { name: value, … }   — selected named env
 *     envVariables?:         { name: value, … }   — collection-level
 *     folderChain?:          [ { variables: {…} }, … ] — highest; nearest-ancestor first
 *   }
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

  // Split by comma, respecting double-quoted strings
  const rawArgs = [];
  let current = "";
  let inQuote  = false;
  for (const ch of argsStr) {
    if (ch === '"') {
      inQuote  = !inQuote;
      current += ch;
    } else if (ch === "," && !inQuote) {
      const arg = current.trim();
      rawArgs.push(arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg);
      current = "";
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) rawArgs.push(last.startsWith('"') && last.endsWith('"') ? last.slice(1, -1) : last);

  return { name, rawArgs };
}

/**
 * Resolve a variable name against the provided context.
 * Priority order (highest → lowest): folder chain → collection → environment → global.
 *
 * @param {string} name
 * @param {{ globalVariables?: object, environmentVariables?: object, envVariables?: object, folderChain?: object[] } | null} context
 * @returns {{ found: boolean, value: any, source: 'folder' | 'collection' | 'environment' | 'global' | null }}
 */
export function resolveVariable(name, context) {
  if (!name || !context) return { found: false, value: undefined, source: null };

  // 1. Walk folder chain nearest-to-farthest
  if (Array.isArray(context.folderChain)) {
    for (const folder of context.folderChain) {
      const vars = folder?.variables;
      if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
        return { found: true, value: vars[name], source: "folder" };
      }
    }
  }

  // 2. Collection-level variables
  const envVars = context.envVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(envVars, name)) {
    return { found: true, value: envVars[name], source: "collection" };
  }

  // 3. Selected environment variables
  const environmentVars = context.environmentVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(environmentVars, name)) {
    return { found: true, value: environmentVars[name], source: "environment" };
  }

  // 4. Global variables
  const globalVars = context.globalVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(globalVars, name)) {
    return { found: true, value: globalVars[name], source: "global" };
  }

  return { found: false, value: undefined, source: null };
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
  const re     = /\{\{([^{}]+)\}\}/g;
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", content: text.slice(lastIndex, match.index) });
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
        const name    = child.dataset.function;
        const rawArgs = JSON.parse(child.dataset.fnArgs ?? "[]");
        if (!rawArgs.length) {
          out += `{{${name}()}}`;
        } else {
          const argStrs = rawArgs.map(a => `"${String(a).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ");
          out += `{{${name}(${argStrs})}}`;
        }
      } else if (child.tagName !== "BR") {
        out += serializeEditor(child);
      }
    }
  }
  return out;
}

/**
 * Async version of resolveString that also evaluates function calls.
 * Function handlers may return Promises (backend-delegated functions).
 *
 * @param {string} template
 * @param {object | null} context
 * @returns {Promise<string>}
 */
export async function resolveStringAsync(template, context) {
  if (!template) return template ?? "";

  const tokens = tokenize(template);
  const parts  = await Promise.all(tokens.map(async (token) => {
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
    return found ? String(value ?? "") : `{{${content}}}`;
  }));

  return parts.join("");
}

/**
 * Scan one or more template strings and return every {{varName}} token found,
 * together with its resolution status.  Results are deduplicated by name —
 * first occurrence wins for found / value when the same name appears in
 * multiple strings.
 *
 * @param {string[]} templates
 * @param {{ envVariables?: object, folderChain?: object[] } | null} context
 * @returns {Array<{ name: string, found: boolean, value: string|null }>}
 */
export function collectTemplateVariables(templates, context) {
  const seen = new Map();
  const re   = /\{\{([^{}]+)\}\}/g;

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
 * @param {{ envVariables?: object, folderChain?: object[] } | null} context
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

