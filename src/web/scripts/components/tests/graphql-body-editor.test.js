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
 * graphql-body-editor.test.js — the GraphQLBodyEditor content + layout-preference
 * API, which is independent of any mount (state survives mount/unmount). Covers
 * the query/variables round-trip and defaults, the schema-only reset (content is
 * NOT cleared), and setVarsFraction's range validation + change detection.
 */
"use strict";

import "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { GraphQLBodyEditor } from "../graphql-body-editor.js";

const make = () => new GraphQLBodyEditor({});

// ── content ─────────────────────────────────────────────────────────────────

test("getValue starts empty and setValue round-trips query + variables", () => {
  const ed = make();
  assert.deepEqual(ed.getValue(), { query: "", variables: "" });

  ed.setValue({ query: "{ me { id } }", variables: '{"x":1}' });
  assert.deepEqual(ed.getValue(), {
    query: "{ me { id } }",
    variables: '{"x":1}',
  });
});

test("setValue defaults each field to an empty string", () => {
  const ed = make();
  ed.setValue({ query: "{ ping }" });
  assert.deepEqual(ed.getValue(), { query: "{ ping }", variables: "" });

  ed.setValue(); // no argument at all
  assert.deepEqual(ed.getValue(), { query: "", variables: "" });
});

test("reset clears the fetched schema but preserves the query/variables content", () => {
  const ed = make();
  ed.setValue({ query: "{ a }", variables: '{"v":2}' });
  ed.reset();
  assert.deepEqual(
    ed.getValue(),
    { query: "{ a }", variables: '{"v":2}' },
    "reset is schema-only; the request's content is untouched",
  );
});

// ── setVarsFraction (range validation + change detection) ─────────────────────

test("setVarsFraction accepts a fraction in (0,1) and reports the change", () => {
  const ed = make();
  assert.equal(ed.setVarsFraction("row", 0.3), true, "first set is a change");
  assert.equal(ed.setVarsFraction("row", 0.3), false, "same value → no change");
});

test("setVarsFraction rejects out-of-range / non-numeric values (→ null)", () => {
  const ed = make();
  ed.setVarsFraction("row", 0.4); // establish a value
  assert.equal(
    ed.setVarsFraction("row", 0),
    true,
    "0 is invalid → reset to null",
  );
  assert.equal(ed.setVarsFraction("row", 0), false, "already null → no change");

  // From a clean null baseline, invalid inputs never register a change.
  assert.equal(ed.setVarsFraction("column", 1), false, "1 is not < 1");
  assert.equal(ed.setVarsFraction("column", 1.5), false, "above range");
  assert.equal(ed.setVarsFraction("column", "x"), false, "non-numeric");
  assert.equal(ed.setVarsFraction("column", -0.2), false, "negative");
});

test("setVarsFraction tracks orientations independently", () => {
  const ed = make();
  assert.equal(ed.setVarsFraction("row", 0.25), true);
  assert.equal(ed.setVarsFraction("column", 0.25), true, "column is separate");
  assert.equal(ed.setVarsFraction("row", 0.25), false, "row already at 0.25");
});
