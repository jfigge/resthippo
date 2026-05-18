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

