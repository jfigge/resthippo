/**
 * graphql-validate.js — Full GraphQL query validation for the body editor.
 *
 * Two layers, both powered by the bundled graphql-js (web/scripts/vendor):
 *   1. Syntax   — parse() the query; a malformed query throws a GraphQLError.
 *   2. Schema   — when an introspection result is available (after "Fetch
 *                 schema"), buildClientSchema() + validate() catch unknown
 *                 fields/types/args, bad variable usage, etc.
 *
 * Pure / no DOM: returns a plain list of errors the editor turns into inline
 * markers. Each error carries both a 1-based {line,column} (for the gutter) and
 * a 0-based [start,end) character range (for the underline); the range is
 * derived from the offending AST node when graphql-js provides one, else
 * widened from the point location to cover the token under it.
 *
 * buildClientSchema is comparatively expensive, so the built GraphQLSchema is
 * cached by introspection-object identity — re-validating on every keystroke
 * only re-parses + re-validates, it does not rebuild the schema.
 */

"use strict";

import {
  parse,
  validate,
  buildClientSchema,
  printSchema,
} from "../vendor/graphql.js";

/** introspection data object → built GraphQLSchema (or null if it won't build). */
const _schemaCache = new WeakMap();

/**
 * @typedef {Object} GqlValidationError
 * @property {string} message
 * @property {number} line     1-based line of the primary location
 * @property {number} column   1-based column of the primary location
 * @property {number} start    0-based start offset into the query
 * @property {number} end      0-based end offset (exclusive); always > start
 * @property {"syntax"|"schema"} kind
 */

/**
 * Validate a GraphQL query.
 *
 * @param {string} query                 the query text
 * @param {object|null} introspection    introspection result ({ __schema })
 *                                        or null when no schema is loaded
 * @returns {{ errors: GqlValidationError[], schemaChecked: boolean }}
 *   schemaChecked is true only when schema validation actually ran (query
 *   parsed AND a usable schema was available).
 */
export function validateGraphQLQuery(query, introspection) {
  if (!query || !query.trim()) return { errors: [], schemaChecked: false };

  // ── 1. Syntax ────────────────────────────────────────────────────────────
  let doc;
  try {
    doc = parse(query);
  } catch (err) {
    return { errors: [toError(err, query, "syntax")], schemaChecked: false };
  }

  // ── 2. Schema (only when an introspection result is available) ────────────
  const schema = introspection ? getClientSchema(introspection) : null;
  if (!schema) return { errors: [], schemaChecked: false };

  const errors = validate(schema, doc).map((e) => toError(e, query, "schema"));
  return { errors, schemaChecked: true };
}

/**
 * Render an introspection result as GraphQL SDL (Schema Definition Language) —
 * the human-readable form used by the "View / Download schema" actions. Reuses
 * the GraphQLSchema already built (and cached) for validation.
 *
 * @param {object|null} introspection  introspection result ({ __schema })
 * @returns {string|null}  the SDL, or null when no usable schema is available
 */
export function introspectionToSDL(introspection) {
  if (!introspection) return null;
  const schema = getClientSchema(introspection);
  if (!schema) return null;
  try {
    return printSchema(schema);
  } catch {
    return null;
  }
}

/** Build (and cache) a GraphQLSchema from an introspection result. */
function getClientSchema(introspection) {
  if (_schemaCache.has(introspection)) return _schemaCache.get(introspection);
  let schema = null;
  try {
    schema = buildClientSchema(introspection);
  } catch {
    schema = null; // malformed introspection → fall back to syntax-only
  }
  _schemaCache.set(introspection, schema);
  return schema;
}

/** Normalise a GraphQLError into our flat marker-friendly shape. */
function toError(err, query, kind) {
  const loc = err.locations?.[0] ?? null;
  const line = loc?.line ?? 1;
  const column = loc?.column ?? 1;

  // Prefer the offending AST node's exact span; else derive from the point
  // location and widen to the token sitting under it.
  let start;
  let end;
  const nodeLoc = err.nodes?.[0]?.loc;
  if (nodeLoc && Number.isInteger(nodeLoc.start)) {
    start = nodeLoc.start;
    end = nodeLoc.end;
  } else {
    start = offsetOf(query, line, column);
    end = tokenEnd(query, start);
  }
  if (end <= start) end = Math.min(query.length, start + 1);

  return { message: err.message, line, column, start, end, kind };
}

/** 0-based character offset of a 1-based (line, column) in text. */
function offsetOf(text, line, column) {
  let offset = 0;
  let ln = 1;
  while (ln < line) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    ln++;
  }
  return Math.min(text.length, offset + (column - 1));
}

/** End offset of the identifier token starting at `start` (≥ start+1). */
function tokenEnd(text, start) {
  let i = start;
  while (i < text.length && /[\w$@.]/.test(text[i])) i++;
  return i > start ? i : Math.min(text.length, start + 1);
}
