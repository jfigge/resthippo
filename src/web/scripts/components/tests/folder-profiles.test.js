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
 * components/tests/folder-profiles.test.js
 *
 * The pure model for folder-variable profiles: effective (Default names + a
 * profile's own values) resolution, and edit reconciliation. Only the Default
 * profile owns the variable set; a named profile stores VALUES only, an unset
 * value is blank (no inheritance), and a named-profile edit can never change the
 * set (out-of-set names ignored, dropped Default names restored blank).
 *
 * Run with:   node --test components/tests/folder-profiles.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  effectiveProfileVars,
  applyProfileEdit,
  removeProfileFromFolder,
} from "../folder-profiles.js";

const dflt = [
  { name: "host", value: "dev.example.com", secure: false },
  { name: "key", value: "dev-key", secure: true },
];

/** The Default names + secure flags, all values cleared to blank. */
const dfltCleared = [
  { name: "host", value: "", secure: false },
  { name: "key", value: "", secure: true },
];

test("effectiveProfileVars: Default profile returns the canonical default set", () => {
  assert.deepEqual(effectiveProfileVars(dflt, {}, null), dflt);
  assert.deepEqual(effectiveProfileVars(dflt, {}, ""), dflt);
});

test("effectiveProfileVars: a new/unseen profile shows the Default names with BLANK values", () => {
  // No stored values for "prod" → Default names + secure flags, values cleared.
  assert.deepEqual(effectiveProfileVars(dflt, {}, "prod"), dfltCleared);
  assert.deepEqual(effectiveProfileVars(dflt, undefined, "prod"), dfltCleared);
});

test("effectiveProfileVars: a profile's stored values win; unset names stay blank (no inherit)", () => {
  const pv = { prod: { host: "prod.example.com" } }; // only host set
  assert.deepEqual(effectiveProfileVars(dflt, pv, "prod"), [
    { name: "host", value: "prod.example.com", secure: false },
    { name: "key", value: "", secure: true }, // unset → blank, NOT the Default value
  ]);
});

test("applyProfileEdit: Default edit rewrites the Default set; profiles keep their own values", () => {
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "prod.example.com", key: "prod-key" } },
  };
  const edited = [
    { name: "host", value: "dev2.example.com", secure: false }, // default value changed
    { name: "key", value: "dev-key", secure: true },
  ];
  const out = applyProfileEdit(current, null, edited, ["prod"]);
  assert.equal(
    out.variables.find((v) => v.name === "host").value,
    "dev2.example.com",
  );
  // prod keeps its independent values (surviving names untouched by a Default edit).
  assert.deepEqual(out.profileValues.prod, {
    host: "prod.example.com",
    key: "prod-key",
  });
});

test("applyProfileEdit: editing a named profile writes the profile, NOT the Default", () => {
  const current = { variables: dflt, profileValues: { prod: {} } };
  const edited = [
    { name: "host", value: "prod.example.com", secure: false }, // prod-only value
    { name: "key", value: "prod-key", secure: true },
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
  // Default is untouched (a named-profile edit can't change values or the set).
  assert.deepEqual(out.variables, dflt);
  assert.deepEqual(out.profileValues.prod, {
    host: "prod.example.com",
    key: "prod-key",
  });
});

test("applyProfileEdit: a named-profile edit can NOT add a variable (out-of-set name ignored)", () => {
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "p", key: "pk" } },
  };
  // With "prod" active the user tries to add a new var "region" — only the
  // Default profile owns the set, so the addition is ignored.
  const edited = [
    { name: "host", value: "p", secure: false },
    { name: "key", value: "pk", secure: true },
    { name: "region", value: "us-east-1", secure: false },
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
  assert.deepEqual(
    out.variables.map((v) => v.name),
    ["host", "key"], // region NOT added
  );
  assert.equal(out.profileValues.prod.region, undefined);
  assert.deepEqual(out.profileValues.prod, { host: "p", key: "pk" });
});

test("applyProfileEdit: a Default name dropped by a named-profile edit is restored blank", () => {
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "p", key: "pk" } },
  };
  // Bulk-editor on "prod" deletes the "key" line — the variable is restored (the
  // set is immutable outside Default) but its prod value clears to blank.
  const edited = [{ name: "host", value: "p", secure: false }];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
  assert.deepEqual(
    out.variables.map((v) => v.name),
    ["host", "key"], // key restored in the Default set
  );
  assert.deepEqual(out.profileValues.prod, { host: "p" }); // key value cleared
  assert.equal(
    effectiveProfileVars(out.variables, out.profileValues, "prod").find(
      (v) => v.name === "key",
    ).value,
    "", // shows blank
  );
});

test("applyProfileEdit: a named-profile value equal to the Default is still stored (no inherit)", () => {
  const current = { variables: dflt, profileValues: { prod: {} } };
  const edited = [
    { name: "host", value: "dev.example.com", secure: false }, // same string as Default
    { name: "key", value: "dev-key", secure: true },
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
  // No inheritance anymore: the values are the profile's own, stored verbatim.
  assert.deepEqual(out.profileValues.prod, {
    host: "dev.example.com",
    key: "dev-key",
  });
});

test("applyProfileEdit: a profile's unset value does NOT follow a later Default change", () => {
  // prod sets only host; key is unset (blank).
  let current = { variables: dflt, profileValues: { prod: { host: "p" } } };
  // Later, the Default's key value changes.
  const edited = [
    { name: "host", value: "dev.example.com", secure: false },
    { name: "key", value: "rotated-key", secure: true },
  ];
  current = applyProfileEdit(current, null, edited, ["prod"]);
  // prod still only stores host; its unset key stays blank (does not follow Default).
  assert.deepEqual(current.profileValues.prod, { host: "p" });
  assert.equal(
    effectiveProfileVars(current.variables, current.profileValues, "prod").find(
      (v) => v.name === "key",
    ).value,
    "",
  );
});

test("applyProfileEdit: deleting a variable on the Default drops it from every profile", () => {
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "p", key: "pk" } },
  };
  // The delete happens on the Default profile (the only one that owns the set).
  const edited = [{ name: "host", value: "dev.example.com", secure: false }];
  const out = applyProfileEdit(current, null, edited, ["prod"]);
  assert.deepEqual(
    out.variables.map((v) => v.name),
    ["host"],
  );
  assert.deepEqual(out.profileValues.prod, { host: "p" }); // key dropped
});

test("applyProfileEdit: no named profiles → behaves exactly like a plain variables save", () => {
  const current = { variables: dflt, profileValues: {} };
  const edited = [{ name: "host", value: "x", secure: false }];
  const out = applyProfileEdit(current, null, edited, []);
  assert.deepEqual(out.variables, edited);
  assert.deepEqual(out.profileValues, {});
});

test("removeProfileFromFolder: drops just the named profile's snapshot", () => {
  const pv = { prod: { host: "p" }, stg: { host: "s" } };
  assert.deepEqual(removeProfileFromFolder(pv, "prod"), { stg: { host: "s" } });
  assert.deepEqual(removeProfileFromFolder(null, "prod"), {});
});
