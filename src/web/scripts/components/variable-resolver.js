/**
 * variable-resolver.js — Variable resolution utilities for the pill editor.
 *
 * A "context" object carries:
 *   { envVariables: { name: value, … }, folderChain: [ { variables: {…} }, … ] }
 *
 * folderChain is ordered nearest-ancestor first (immediate parent → root).
 */

"use strict";

/**
 * Resolve a variable name against the provided context.
 * Folder-chain variables take priority over environment variables.
 *
 * @param {string} name
 * @param {{ envVariables?: object, folderChain?: object[] } | null} context
 * @returns {{ found: boolean, value: any, source: 'folder' | 'environment' | null }}
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

  // 2. Fall back to environment variables
  const envVars = context.envVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(envVars, name)) {
    return { found: true, value: envVars[name], source: "environment" };
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
      } else if (child.tagName !== "BR") {
        // Nested element (shouldn't happen in normal usage) — recurse
        out += serializeEditor(child);
      }
    }
  }
  return out;
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

