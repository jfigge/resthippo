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
 * components/tests/graphql-schema.test.js
 *
 * Unit tests for the pure GraphQL helpers used by the GraphQL body mode:
 * buildSchemaModel, suggestAtCursor (field / argument / enum contexts),
 * extractOperationName, printType and unwrapNamedType.
 *
 * Run with:   node --test components/tests/graphql-schema.test.js
 * Dependencies: none — Node's built-in test runner + assert.
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSchemaModel,
  suggestAtCursor,
  extractOperationName,
  printType,
  unwrapNamedType,
} from "../graphql-schema.js";

// ── A small introspection response: User/Role + query & mutation roots ────────
const named = (kind, name) => ({ kind, name, ofType: null });
const nonNull = (of) => ({ kind: "NON_NULL", name: null, ofType: of });
const list = (of) => ({ kind: "LIST", name: null, ofType: of });
const ID = named("SCALAR", "ID");
const STR = named("SCALAR", "String");
const BOOL = named("SCALAR", "Boolean");
const ROLE = named("ENUM", "Role");
const USER = named("OBJECT", "User");

const INTROSPECTION = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          fields: [
            {
              name: "user",
              type: USER,
              args: [{ name: "id", type: nonNull(ID) }],
            },
            {
              name: "users",
              type: nonNull(list(nonNull(USER))),
              args: [
                { name: "role", type: ROLE },
                { name: "active", type: BOOL },
              ],
            },
          ],
          enumValues: [],
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          fields: [
            {
              name: "createUser",
              type: USER,
              args: [
                { name: "name", type: nonNull(STR) },
                { name: "role", type: ROLE },
              ],
            },
          ],
          enumValues: [],
        },
        {
          kind: "OBJECT",
          name: "User",
          fields: [
            { name: "id", type: nonNull(ID), args: [] },
            { name: "name", type: nonNull(STR), args: [] },
            { name: "role", type: ROLE, args: [] },
            { name: "active", type: BOOL, args: [] },
          ],
          enumValues: [],
        },
        {
          kind: "ENUM",
          name: "Role",
          fields: [],
          enumValues: [{ name: "ADMIN" }, { name: "USER" }, { name: "GUEST" }],
        },
      ],
    },
  },
};

const MODEL = buildSchemaModel(INTROSPECTION);
const labels = (res) => (res ? res.items.map((i) => i.label) : null);

test("buildSchemaModel: roots, types, fields and enum values", () => {
  assert.equal(MODEL.queryType, "Query");
  assert.equal(MODEL.mutationType, "Mutation");
  assert.equal(MODEL.subscriptionType, null);
  assert.deepEqual(
    [...MODEL.types.get("User").fields.keys()],
    ["id", "name", "role", "active"],
  );
  assert.deepEqual(MODEL.types.get("Role").enumValues, [
    "ADMIN",
    "USER",
    "GUEST",
  ]);
  // Accepts a bare { __schema } envelope too.
  assert.ok(buildSchemaModel({ __schema: INTROSPECTION.data.__schema }));
  assert.equal(buildSchemaModel({}), null);
});

test("printType / unwrapNamedType render wrappers correctly", () => {
  assert.equal(printType(nonNull(list(nonNull(USER)))), "[User!]!");
  assert.equal(printType(nonNull(ID)), "ID!");
  assert.equal(unwrapNamedType(nonNull(list(nonNull(USER)))), "User");
});

test("suggestAtCursor: root field names (query)", () => {
  const q = "query { ";
  assert.deepEqual(labels(suggestAtCursor(q, q.length, MODEL)), [
    "user",
    "users",
  ]);
});

test("suggestAtCursor: field names filtered by prefix", () => {
  const q = "query { user { na";
  const res = suggestAtCursor(q, q.length, MODEL);
  assert.equal(res.kind, "field");
  assert.equal(res.prefix, "na");
  assert.deepEqual(labels(res), ["name"]);
});

test("suggestAtCursor: anonymous operation resolves to Query root", () => {
  const q = "{ ";
  assert.deepEqual(labels(suggestAtCursor(q, q.length, MODEL)), [
    "user",
    "users",
  ]);
});

test("suggestAtCursor: mutation root field names", () => {
  const q = "mutation { ";
  assert.deepEqual(labels(suggestAtCursor(q, q.length, MODEL)), ["createUser"]);
});

test("suggestAtCursor: nested selection set uses the field's return type", () => {
  const q = 'query { user(id: "1") { ';
  assert.deepEqual(labels(suggestAtCursor(q, q.length, MODEL)), [
    "id",
    "name",
    "role",
    "active",
  ]);
});

test("suggestAtCursor: argument names inside a field's parens", () => {
  const q = "query { users(";
  const res = suggestAtCursor(q, q.length, MODEL);
  assert.equal(res.kind, "argument");
  assert.deepEqual(labels(res), ["role", "active"]);
});

test("suggestAtCursor: enum values after an enum argument", () => {
  const q = "query { users(role: ";
  const res = suggestAtCursor(q, q.length, MODEL);
  assert.equal(res.kind, "enum");
  assert.deepEqual(labels(res), ["ADMIN", "USER", "GUEST"]);
});

test("suggestAtCursor: boolean values after a Boolean argument", () => {
  const q = "query { users(active: ";
  const res = suggestAtCursor(q, q.length, MODEL);
  assert.equal(res.kind, "enum");
  assert.deepEqual(labels(res), ["true", "false"]);
});

test("suggestAtCursor: null without a model or query", () => {
  assert.equal(suggestAtCursor("query { ", 8, null), null);
  assert.equal(suggestAtCursor("", 0, MODEL), null);
});

test("extractOperationName: named, anonymous and unnamed operations", () => {
  assert.equal(
    extractOperationName("query GetUser($id: ID!) { user(id: $id) { id } }"),
    "GetUser",
  );
  assert.equal(
    extractOperationName("mutation Make { createUser { id } }"),
    "Make",
  );
  assert.equal(extractOperationName("query { user { id } }"), "");
  assert.equal(extractOperationName("{ user { id } }"), "");
});

test("extractOperationName: ignores keywords in strings/comments, fields, and picks the first of many", () => {
  // A "query"/"mutation" word inside a string-literal argument is not an operation.
  assert.equal(
    extractOperationName('mutation Make { do(note: "run query Evil") { id } }'),
    "Make",
  );
  // …nor inside a comment.
  assert.equal(
    extractOperationName("# query Commented\nquery Real { x }"),
    "Real",
  );
  // A field literally named `query` is not an operation.
  assert.equal(extractOperationName("{ query { id } }"), "");
  // Multi-operation document → first operation's name wins.
  assert.equal(
    extractOperationName("query First { a } query Second { b }"),
    "First",
  );
  // Operation keyword with a directive but no name is still anonymous.
  assert.equal(extractOperationName("query @cached { a }"), "");
});
