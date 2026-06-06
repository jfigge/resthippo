/**
 * components/tests/graphql-validate.test.js
 *
 * Unit tests for validateGraphQLQuery — the two-layer (syntax + schema) GraphQL
 * query validator backed by the bundled graphql-js.
 *
 * Run with:   node --test components/tests/graphql-validate.test.js
 * Dependencies: graphql (devDependency) — only to synthesise an introspection
 * result for the schema-validation cases; the module under test uses the bundled
 * copy in web/scripts/vendor.
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, introspectionFromSchema } from "graphql";

import {
  validateGraphQLQuery,
  introspectionToSDL,
} from "../graphql-validate.js";

// A tiny schema → introspection result, the same shape "Fetch schema" produces.
const introspection = introspectionFromSchema(
  buildSchema(`
    type User { name: String email: String }
    type Query { user(id: ID!): User }
  `),
);

test("empty query yields no errors and no schema check", () => {
  const r = validateGraphQLQuery("", introspection);
  assert.deepEqual(r.errors, []);
  assert.equal(r.schemaChecked, false);
});

test("a syntax error is caught even without a schema", () => {
  const r = validateGraphQLQuery("query { user(id: }", null);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].kind, "syntax");
  assert.equal(r.schemaChecked, false);
  assert.ok(r.errors[0].end > r.errors[0].start, "range is non-empty");
});

test("unknown field: syntactically fine, but flagged once a schema is present", () => {
  const q = 'query { user(id: "1") { naem } }';

  // Without a schema we can only check syntax → no error.
  const noSchema = validateGraphQLQuery(q, null);
  assert.deepEqual(noSchema.errors, []);
  assert.equal(noSchema.schemaChecked, false);

  // With a schema the unknown field is reported, pointing exactly at the token.
  const withSchema = validateGraphQLQuery(q, introspection);
  assert.equal(withSchema.schemaChecked, true);
  assert.equal(withSchema.errors.length, 1);
  assert.equal(withSchema.errors[0].kind, "schema");
  assert.equal(
    q.slice(withSchema.errors[0].start, withSchema.errors[0].end),
    "naem",
  );
  assert.match(withSchema.errors[0].message, /Did you mean/);
});

test("a query valid against the schema reports no errors", () => {
  const r = validateGraphQLQuery(
    'query { user(id: "1") { name email } }',
    introspection,
  );
  assert.equal(r.schemaChecked, true);
  assert.deepEqual(r.errors, []);
});

test("every error carries a 1-based location and a positive char range", () => {
  const r = validateGraphQLQuery(
    'query {\n  user(id: "1") { naem }\n}',
    introspection,
  );
  const e = r.errors[0];
  assert.equal(e.line, 2); // error is on the second line
  assert.ok(e.column >= 1);
  assert.ok(Number.isInteger(e.start) && e.end > e.start);
});

test("malformed introspection falls back to syntax-only (no throw)", () => {
  const r = validateGraphQLQuery('query { user(id: "1") { naem } }', {
    __schema: { not: "a real schema" },
  });
  assert.equal(r.schemaChecked, false);
  assert.deepEqual(r.errors, []);
});

test("introspectionToSDL renders the schema back to SDL", () => {
  const sdl = introspectionToSDL(introspection);
  assert.equal(typeof sdl, "string");
  assert.match(sdl, /type User/);
  assert.match(sdl, /user\(id: ID!\): User/);
});

test("introspectionToSDL returns null for null / malformed introspection", () => {
  assert.equal(introspectionToSDL(null), null);
  assert.equal(
    introspectionToSDL({ __schema: { not: "a real schema" } }),
    null,
  );
});
