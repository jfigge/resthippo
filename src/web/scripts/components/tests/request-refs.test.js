/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * components/tests/request-refs.test.js
 *
 * Unit tests for cross-request reference resolution (id-first, name-fallback,
 * ambiguity flagging), request-picker option building (duplicate disambiguation),
 * and the lazy name→id token migration.
 *
 * Run with:   node --test components/tests/request-refs.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  flattenRequests,
  resolveRequestRef,
  requestPickerGroups,
  migrateRef,
  migrateTokensInString,
  migrateRequestNodeRefs,
} from "../request-refs.js";

// A tree with a duplicate request name ("Login") under two different parents.
const ITEMS = [
  {
    id: "c1",
    type: "collection",
    name: "API",
    children: [
      { id: "r1", type: "request", name: "Login" },
      {
        id: "f1",
        type: "folder",
        name: "Auth",
        children: [
          { id: "r2", type: "request", name: "Login" }, // duplicate name
          { id: "r3", type: "request", name: "Refresh" },
        ],
      },
    ],
  },
];
const REQS = flattenRequests(ITEMS);

// ── flattenRequests ──────────────────────────────────────────────────────────

test("flattenRequests: collects requests with ancestor paths", () => {
  assert.deepEqual(REQS, [
    { id: "r1", name: "Login", path: ["API"] },
    { id: "r2", name: "Login", path: ["API", "Auth"] },
    { id: "r3", name: "Refresh", path: ["API", "Auth"] },
  ]);
});

// ── resolveRequestRef ────────────────────────────────────────────────────────

test("resolveRequestRef: exact id match wins, never ambiguous", () => {
  const r = resolveRequestRef(REQS, "r2");
  assert.equal(r.found, true);
  assert.equal(r.id, "r2");
  assert.equal(r.name, "Login");
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.path, ["API", "Auth"]);
});

test("resolveRequestRef: unique name resolves to its id", () => {
  const r = resolveRequestRef(REQS, "Refresh");
  assert.equal(r.id, "r3");
  assert.equal(r.ambiguous, false);
});

test("resolveRequestRef: duplicate name → first match flagged ambiguous", () => {
  const r = resolveRequestRef(REQS, "Login");
  assert.equal(r.found, true);
  assert.equal(r.id, "r1"); // first in tree order
  assert.equal(r.ambiguous, true);
});

test("resolveRequestRef: unknown reference is a miss", () => {
  assert.equal(resolveRequestRef(REQS, "nope").found, false);
  assert.equal(resolveRequestRef(REQS, "").found, false);
});

// ── requestPickerGroups ──────────────────────────────────────────────────────

test("requestPickerGroups: groups requests by folder path, in tree order", () => {
  const groups = requestPickerGroups(REQS);
  assert.deepEqual(groups, [
    { pathText: "API", requests: [{ id: "r1", name: "Login" }] },
    {
      pathText: "API/Auth",
      requests: [
        { id: "r2", name: "Login" },
        { id: "r3", name: "Refresh" },
      ],
    },
  ]);
});

test("requestPickerGroups: merges same-path requests into one group", () => {
  const items = [
    {
      id: "c1",
      type: "collection",
      name: "API",
      children: [
        { id: "a", type: "request", name: "A" },
        {
          id: "f",
          type: "folder",
          name: "Sub",
          children: [{ id: "b", type: "request", name: "B" }],
        },
        { id: "c", type: "request", name: "C" }, // back in API, after the sub-folder
      ],
    },
  ];
  const groups = requestPickerGroups(flattenRequests(items));
  assert.deepEqual(
    groups.map((g) => [g.pathText, g.requests.map((r) => r.id)]),
    [
      ["API", ["a", "c"]],
      ["API/Sub", ["b"]],
    ],
  );
});

// ── migrateRef ───────────────────────────────────────────────────────────────

test("migrateRef: unique name → id; id, ambiguous, and miss pass through", () => {
  assert.equal(migrateRef("Refresh", REQS), "r3");
  assert.equal(migrateRef("r1", REQS), "r1"); // already an id
  assert.equal(migrateRef("Login", REQS), "Login"); // ambiguous → left
  assert.equal(migrateRef("nope", REQS), "nope"); // miss → left
});

// ── migrateTokensInString ────────────────────────────────────────────────────

test("migrateTokensInString: rewrites picker tokens, preserves the rest", () => {
  const out = migrateTokensInString('Bearer {{run("Refresh")}} done', REQS);
  assert.equal(out.changed, true);
  assert.equal(out.text, 'Bearer {{run("r3")}} done');
});

test("migrateTokensInString: keeps non-first args verbatim", () => {
  const out = migrateTokensInString(
    '{{response("Refresh", ".data.token")}}',
    REQS,
  );
  assert.equal(out.text, '{{response("r3", ".data.token")}}');
});

test("migrateTokensInString: leaves non-picker functions, ambiguous names, and ids", () => {
  for (const s of [
    "{{uuid()}}",
    '{{run("Login")}}',
    '{{run("r3")}}',
    "no tokens",
  ]) {
    const out = migrateTokensInString(s, REQS);
    assert.equal(out.changed, false);
    assert.equal(out.text, s);
  }
});

// ── migrateRequestNodeRefs ───────────────────────────────────────────────────

test("migrateRequestNodeRefs: deep-walks fields, skips id and children", () => {
  const node = {
    id: "rX",
    name: "Caller",
    url: '{{run("Refresh")}}',
    headers: [{ key: "X", value: '{{response("Refresh", ".t")}}' }],
    children: [{ value: '{{run("Refresh")}}' }], // sub-nodes persist separately
  };
  const { node: out, changed } = migrateRequestNodeRefs(node, REQS);
  assert.equal(changed, true);
  assert.equal(out.url, '{{run("r3")}}');
  assert.equal(out.headers[0].value, '{{response("r3", ".t")}}');
  assert.equal(out.children[0].value, '{{run("Refresh")}}'); // untouched
  assert.equal(out.id, "rX");
});

test("migrateRequestNodeRefs: an id-keyed token-like value is never rewritten", () => {
  const node = { id: '{{run("Refresh")}}' };
  const { changed } = migrateRequestNodeRefs(node, REQS);
  assert.equal(changed, false);
});

test("migrateRequestNodeRefs: returns the same reference when nothing changes", () => {
  const node = { url: '{{run("Login")}}', body: { raw: "{}" } };
  const { node: out, changed } = migrateRequestNodeRefs(node, REQS);
  assert.equal(changed, false);
  assert.equal(out, node); // referential stability
});
