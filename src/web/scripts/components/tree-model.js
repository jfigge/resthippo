/**
 * tree-model.js — pure node-tree operations for the collections tree.
 *
 * Extracted verbatim (behaviour-preserving) from TreeView: every function here
 * takes a `nodes` array (or a single node) and returns a result without touching
 * the DOM or any component state. A node is `{ id, type, name, children?, … }`;
 * `type:"collection"` nodes (including folders, which are nested collections)
 * hold `children`, `type:"request"` nodes are leaves.
 *
 * The mutation helpers are immutable: they return a NEW tree, sharing untouched
 * subtrees by reference (callers rely on the reference change to detect where an
 * insert landed — see insertNodeAfter / insertBefore). Keeping these here makes
 * the tree logic directly unit-testable, independent of the (large) view.
 */
"use strict";

/** Find the parent id of `targetId` at any depth, or undefined if not found. */
export function findParentId(nodes, targetId, parentId = null) {
  for (const node of nodes) {
    if (node.id === targetId) return parentId;
    if (Array.isArray(node.children)) {
      const found = findParentId(node.children, targetId, node.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Return a new tree with `child` prepended to `parentId`'s children. */
export function insertChild(nodes, parentId, child) {
  return nodes.map((node) => {
    if (node.id === parentId) {
      return { ...node, children: [child, ...(node.children ?? [])] };
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      return { ...node, children: insertChild(node.children, parentId, child) };
    }
    return node;
  });
}

/** Return a new tree with the node `targetId` removed (at any depth). */
export function removeNode(nodes, targetId) {
  return nodes
    .filter((n) => n.id !== targetId)
    .map((n) => {
      if (Array.isArray(n.children) && n.children.length > 0) {
        return { ...n, children: removeNode(n.children, targetId) };
      }
      return n;
    });
}

/** Find a node by id at any depth. Returns the node or null. */
export function findNode(nodes, targetId) {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (Array.isArray(node.children)) {
      const found = findNode(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Deep-clone a node, replacing every `id` (the node, its tree children, and its
 * request-level row arrays) with a fresh UUID so a duplicate never shares ids.
 */
export function cloneWithNewIds(node) {
  const clone = { ...node, id: crypto.randomUUID() };
  if (Array.isArray(node.children)) {
    clone.children = node.children.map((c) => cloneWithNewIds(c));
  }
  if (Array.isArray(node.bodyFormRows)) {
    clone.bodyFormRows = node.bodyFormRows.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
    }));
  }
  if (Array.isArray(node.params)) {
    clone.params = node.params.map((r) => ({ ...r, id: crypto.randomUUID() }));
  }
  if (Array.isArray(node.headers)) {
    clone.headers = node.headers.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
    }));
  }
  return clone;
}

/** Insert `newNode` immediately after the node `afterId` (recursive). */
export function insertNodeAfter(nodes, afterId, newNode) {
  const result = [];
  for (const node of nodes) {
    let current = node;
    let insertedInChildren = false;

    if (Array.isArray(node.children) && node.children.length > 0) {
      const newChildren = insertNodeAfter(node.children, afterId, newNode);
      // Length check (inserted at this level) OR reference check (inserted
      // deeper — count unchanged but a child object is a fresh copy).
      insertedInChildren =
        newChildren.length > node.children.length ||
        newChildren.some((c, i) => c !== node.children[i]);
      if (insertedInChildren) current = { ...node, children: newChildren };
    }

    result.push(current);

    if (!insertedInChildren && node.id === afterId) {
      result.push(newNode);
    }
  }
  return result;
}

/** Insert `newNode` immediately before the node `beforeId` (recursive). */
export function insertBefore(nodes, beforeId, newNode) {
  const result = [];
  for (const node of nodes) {
    if (node.id === beforeId) {
      result.push(newNode, node);
      continue;
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const newChildren = insertBefore(node.children, beforeId, newNode);
      if (
        newChildren.length > node.children.length ||
        newChildren.some((c, i) => c !== node.children[i])
      ) {
        result.push({ ...node, children: newChildren });
        continue;
      }
    }
    result.push(node);
  }
  return result;
}

/** Return a new tree with `targetId`'s name replaced. */
export function updateNodeName(nodes, targetId, newName) {
  return nodes.map((node) => {
    if (node.id === targetId) return { ...node, name: newName };
    if (Array.isArray(node.children) && node.children.length > 0) {
      return {
        ...node,
        children: updateNodeName(node.children, targetId, newName),
      };
    }
    return node;
  });
}

/** Return a new tree with `fields` merged into `targetId`. */
export function patchNodeFields(nodes, targetId, fields) {
  return nodes.map((node) => {
    if (node.id === targetId) return { ...node, ...fields };
    if (Array.isArray(node.children) && node.children.length > 0) {
      return {
        ...node,
        children: patchNodeFields(node.children, targetId, fields),
      };
    }
    return node;
  });
}

/** All request nodes in depth-first (visual) order across the tree. */
export function getFlatRequests(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.type === "request") {
      result.push(node);
    } else if (Array.isArray(node.children)) {
      result.push(...getFlatRequests(node.children));
    }
  }
  return result;
}

/**
 * Every request id under `node` — `[node.id]` if it is itself a request, or all
 * descendant request ids if it is a folder/collection.
 */
export function collectRequestIds(node) {
  if (node.type === "request") return [node.id];
  const ids = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) ids.push(...collectRequestIds(child));
  }
  return ids;
}
