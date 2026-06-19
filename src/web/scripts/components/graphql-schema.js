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
 * graphql-schema.js — Pure GraphQL helpers for the GraphQL body mode.
 *
 * No DOM, no network — everything here is a pure function so it can be unit
 * tested in isolation (see tests/graphql-schema.test.js). The editor
 * (request-editor.js) wires these to textareas and the autocomplete dropdown;
 * the network fetch lives in graphql-introspection.js.
 *
 * Three responsibilities:
 *   1. INTROSPECTION_QUERY        — the standard introspection request body.
 *   2. buildSchemaModel(json)     — turn an introspection response into a compact
 *                                   lookup model (types → fields → args/return).
 *   3. suggestAtCursor(q, i, m)   — best-effort, context-aware autocomplete for
 *                                   the query editor (fields / arguments / enum
 *                                   values), plus extractOperationName().
 *
 * suggestAtCursor is intentionally NOT a full GraphQL parser. It scans the text
 * up to the cursor with a small punctuator-aware state machine that reconstructs
 * the selection-set type stack and the enclosing field's argument context. It
 * covers the common cases (nested selections, argument names, enum/Boolean
 * values) and degrades to "no suggestions" on anything it doesn't understand
 * (fragments, inline fragments, directives, aliases, multiple operations).
 */

"use strict";

/**
 * The standard GraphQL introspection query. Sent verbatim as the `query` of a
 * normal POST so the same send path (auth, headers, proxy) is reused.
 */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        args { name type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name type { ...TypeRef } }
      interfaces { ...TypeRef }
      enumValues(includeDeprecated: true) { name }
      possibleTypes { ...TypeRef }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }
}`;

/** Walk a __Type reference to its underlying named type's name (strips LIST/NON_NULL). */
export function unwrapNamedType(typeRef) {
  let t = typeRef;
  while (t && t.name == null && t.ofType) t = t.ofType;
  return t?.name ?? null;
}

/** Render a __Type reference as its GraphQL signature, e.g. `[User!]!`. */
export function printType(typeRef) {
  if (!typeRef) return "";
  if (typeRef.kind === "NON_NULL") return `${printType(typeRef.ofType)}!`;
  if (typeRef.kind === "LIST") return `[${printType(typeRef.ofType)}]`;
  return typeRef.name ?? "";
}

/**
 * Build a compact model from an introspection response. Accepts the full
 * `{ data: { __schema } }` envelope, a bare `{ __schema }`, or the `__schema`
 * object directly.
 *
 * @param {object} json
 * @returns {null | {
 *   queryType: string|null,
 *   mutationType: string|null,
 *   subscriptionType: string|null,
 *   types: Map<string, {
 *     name: string, kind: string,
 *     fields: Map<string, { name: string, type: object, args: {name:string,type:object}[] }>,
 *     enumValues: string[],
 *   }>,
 * }}
 */
export function buildSchemaModel(json) {
  const schema = json?.data?.__schema ?? json?.__schema ?? json;
  if (!schema || !Array.isArray(schema.types)) return null;

  const types = new Map();
  for (const t of schema.types) {
    if (!t || !t.name) continue;
    const fields = new Map();
    for (const f of t.fields ?? []) {
      if (!f || !f.name) continue;
      fields.set(f.name, {
        name: f.name,
        type: f.type ?? null,
        args: (f.args ?? []).map((a) => ({
          name: a.name,
          type: a.type ?? null,
        })),
      });
    }
    types.set(t.name, {
      name: t.name,
      kind: t.kind ?? "",
      fields,
      enumValues: (t.enumValues ?? []).map((e) => e.name).filter(Boolean),
    });
  }

  return {
    queryType: schema.queryType?.name ?? null,
    mutationType: schema.mutationType?.name ?? null,
    subscriptionType: schema.subscriptionType?.name ?? null,
    types,
  };
}

/**
 * The name of the first named operation in a document, or "" for an anonymous
 * (`{ … }`) / unnamed (`query { … }`) operation. Heuristic: an operation
 * keyword followed by a name and then `(` or `{`.
 *
 * @param {string} query
 * @returns {string}
 */
export function extractOperationName(query) {
  const m =
    /(?:^|[\s}])(query|mutation|subscription)\s+([A-Za-z_]\w*)\s*[({]/.exec(
      query ?? "",
    );
  return m ? m[2] : "";
}

const ROOT_FOR_OP = {
  query: "queryType",
  mutation: "mutationType",
  subscription: "subscriptionType",
};

const NAME_RE = /[_A-Za-z][_A-Za-z0-9]*/y;

/**
 * Tokenise GraphQL text, skipping whitespace, commas, comments and string
 * literals. Returns `{ name }` tokens and single-character punctuators.
 * @returns {{ kind: "name"|"punct", value: string }[]}
 */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        i = end === -1 ? n : end + 3;
      } else {
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === "\\") i++;
          i++;
        }
        i++;
      }
      continue;
    }
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(text);
    if (m && m.index === i) {
      tokens.push({ kind: "name", value: m[0] });
      i += m[0].length;
      continue;
    }
    tokens.push({ kind: "punct", value: c });
    i++;
  }
  return tokens;
}

/**
 * Best-effort, context-aware autocomplete for the query editor.
 *
 * @param {string} query   full query text
 * @param {number} cursor  caret offset into `query`
 * @param {object} model   result of buildSchemaModel()
 * @returns {null | { kind: "field"|"argument"|"enum", prefix: string,
 *                    items: { label: string, detail: string }[] }}
 */
export function suggestAtCursor(query, cursor, model) {
  if (!model || !query) return null;

  const head = query.slice(0, Math.max(0, cursor));
  // The word currently being typed must not be treated as committed context.
  const prefixMatch = /[_A-Za-z][_A-Za-z0-9]*$/.exec(head);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const scanned = prefix ? head.slice(0, head.length - prefix.length) : head;

  const tokens = tokenize(scanned);

  let opType = "query";
  let seenRoot = false;
  let headerParens = 0; // parens before the root `{` (variable definitions)
  const frames = []; // selection-set stack: { type, currentField }
  let arg = null; // { fieldName, currentArgName, expectValue, depth, objDepth }

  for (const tok of tokens) {
    const v = tok.value;
    if (tok.kind === "name") {
      if (!seenRoot) {
        // The first leading operation keyword sets the type; the `=== "query"`
        // guard stops a later field literally named "query" from overriding it.
        if (opType === "query" && ROOT_FOR_OP[v]) opType = v;
        continue; // operation name / variable-def identifiers — ignore
      }
      if (arg) {
        if (!arg.expectValue) arg.currentArgName = v;
        else arg.expectValue = false;
      } else if (frames.length) {
        frames[frames.length - 1].currentField = v;
      }
      continue;
    }

    // punctuator
    switch (v) {
      case "{":
        if (!seenRoot) {
          seenRoot = true;
          frames.push({ type: rootType(model, opType), currentField: null });
        } else if (arg) {
          arg.objDepth++;
        } else {
          const top = frames[frames.length - 1];
          frames.push({
            type: returnTypeName(model, top?.type, top?.currentField),
            currentField: null,
          });
        }
        break;
      case "}":
        if (arg && arg.objDepth > 0) arg.objDepth--;
        else frames.pop();
        break;
      case "(":
        if (!seenRoot) headerParens++;
        else if (arg) arg.depth++;
        else
          arg = {
            fieldName: frames[frames.length - 1]?.currentField ?? null,
            currentArgName: null,
            expectValue: false,
            depth: 1,
            objDepth: 0,
          };
        break;
      case ")":
        if (!seenRoot) headerParens = Math.max(0, headerParens - 1);
        else if (arg) {
          arg.depth--;
          if (arg.depth <= 0) arg = null;
        }
        break;
      case ":":
        if (arg && arg.objDepth === 0) arg.expectValue = true;
        break;
      default:
        break; // [ ] ! = $ @ . etc. — ignored
    }
  }

  // ── Decide what to suggest at the cursor ───────────────────────────────────
  if (arg && arg.objDepth === 0) {
    const ownerType = frames[frames.length - 1]?.type;
    const field = model.types.get(ownerType)?.fields.get(arg.fieldName);
    if (!field) return null;

    if (arg.expectValue) {
      const argDef = field.args.find((a) => a.name === arg.currentArgName);
      const named = argDef && unwrapNamedType(argDef.type);
      if (named === "Boolean") {
        return finalize("enum", prefix, [
          { label: "true", detail: "Boolean" },
          { label: "false", detail: "Boolean" },
        ]);
      }
      const enumType = named && model.types.get(named);
      if (enumType && enumType.kind === "ENUM") {
        return finalize(
          "enum",
          prefix,
          enumType.enumValues.map((e) => ({ label: e, detail: named })),
        );
      }
      return null;
    }

    return finalize(
      "argument",
      prefix,
      field.args.map((a) => ({ label: a.name, detail: printType(a.type) })),
    );
  }

  if (frames.length) {
    const type = model.types.get(frames[frames.length - 1].type);
    if (!type) return null;
    return finalize(
      "field",
      prefix,
      [...type.fields.values()].map((f) => ({
        label: f.name,
        detail: printType(f.type),
      })),
    );
  }

  return null;
}

function rootType(model, opType) {
  return model[ROOT_FOR_OP[opType]] ?? model.queryType ?? null;
}

function returnTypeName(model, parentTypeName, fieldName) {
  if (!parentTypeName || !fieldName) return null;
  const field = model.types.get(parentTypeName)?.fields.get(fieldName);
  return field ? unwrapNamedType(field.type) : null;
}

/** Filter items by the typed prefix (case-insensitive) and drop empties. */
function finalize(kind, prefix, items) {
  let out = items.filter((it) => it.label);
  if (prefix) {
    const p = prefix.toLowerCase();
    const starts = out.filter((it) => it.label.toLowerCase().startsWith(p));
    out = starts.length
      ? starts
      : out.filter((it) => it.label.toLowerCase().includes(p));
  }
  if (!out.length) return null;
  return { kind, prefix, items: out };
}
