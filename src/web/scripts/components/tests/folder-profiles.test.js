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
 * The pure model for folder-variable profiles: effective (default + override)
 * resolution, edit reconciliation (value edits vs. structural add/delete), and
 * the folder-switch / profile-set re-alignment. Mirrors the spec's behavioural
 * requirements (new profile mirrors default; add/delete syncs every profile).
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

test("effectiveProfileVars: Default profile returns the canonical default set", () => {
  assert.deepEqual(effectiveProfileVars(dflt, {}, null), dflt);
  assert.deepEqual(effectiveProfileVars(dflt, {}, ""), dflt);
});

test("effectiveProfileVars: a new/uninitialised profile mirrors the Default values [req 9]", () => {
  // No stored overrides for "prod" → shows the Default names AND values.
  assert.deepEqual(effectiveProfileVars(dflt, {}, "prod"), dflt);
});

test("effectiveProfileVars: overrides win, secure + missing names fall back to Default", () => {
  const pv = { prod: { host: "prod.example.com" } }; // only host overridden
  assert.deepEqual(effectiveProfileVars(dflt, pv, "prod"), [
    { name: "host", value: "prod.example.com", secure: false },
    { name: "key", value: "dev-key", secure: true }, // falls back to Default value + secure
  ]);
});

test("applyProfileEdit: Default edit rewrites the Default values, profiles keep their own", () => {
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
  // prod keeps its independent values (existing names untouched).
  assert.deepEqual(out.profileValues.prod, {
    host: "prod.example.com",
    key: "prod-key",
  });
});

test("applyProfileEdit: editing a named profile writes the profile, NOT the Default value", () => {
  const current = { variables: dflt, profileValues: { prod: {} } };
  const edited = [
    { name: "host", value: "prod.example.com", secure: false }, // prod-only value
    { name: "key", value: "prod-key", secure: true },
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
  // Default values are preserved (not overwritten by the prod edit).
  assert.deepEqual(out.variables, dflt);
  assert.deepEqual(out.profileValues.prod, {
    host: "prod.example.com",
    key: "prod-key",
  });
});

test("applyProfileEdit: adding a variable in a profile updates the Default set; every profile inherits it [req 11]", () => {
  const current = {
    variables: dflt,
    profileValues: {
      prod: { host: "p", key: "pk" },
      stg: { host: "s", key: "sk" },
    },
  };
  // User (with "prod" active) adds a new var "region" = "us-east-1".
  const edited = [
    { name: "host", value: "p", secure: false },
    { name: "key", value: "pk", secure: true },
    { name: "region", value: "us-east-1", secure: false },
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod", "stg"]);
  // Default gains "region" (seeded from the only value available — the edit).
  assert.deepEqual(
    out.variables.map((v) => v.name),
    ["host", "key", "region"],
  );
  assert.equal(
    out.variables.find((v) => v.name === "region").value,
    "us-east-1",
  );
  // region equals the Default → not pinned in any profile (they inherit it), but
  // both profiles SHOW it, and their existing overrides are intact.
  assert.equal(out.profileValues.prod.region, undefined);
  assert.equal(out.profileValues.stg.region, undefined);
  assert.equal(
    effectiveProfileVars(out.variables, out.profileValues, "prod").find(
      (v) => v.name === "region",
    ).value,
    "us-east-1",
  );
  assert.equal(out.profileValues.prod.host, "p");
  assert.equal(out.profileValues.stg.host, "s");
});

test("applyProfileEdit: a profile value equal to the Default is left inheriting (sparse)", () => {
  const current = { variables: dflt, profileValues: { prod: { host: "p" } } };
  // User (prod) sets host back to the Default value → the override is dropped.
  const edited = [
    { name: "host", value: "dev.example.com", secure: false },
    { name: "key", value: "dev-key", secure: true },
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
  assert.deepEqual(out.profileValues.prod, {}); // host un-pinned; key never pinned
});

test("applyProfileEdit: an un-overridden profile value follows a later Default change", () => {
  // prod overrides only host; key is un-pinned (inherits).
  let current = { variables: dflt, profileValues: { prod: { host: "p" } } };
  // Later, Default's key changes.
  const edited = [
    { name: "host", value: "dev.example.com", secure: false },
    { name: "key", value: "rotated-key", secure: true },
  ];
  current = applyProfileEdit(current, null, edited, ["prod"]);
  // prod still only pins host; its shown key follows the new Default.
  assert.deepEqual(current.profileValues.prod, { host: "p" });
  assert.equal(
    effectiveProfileVars(current.variables, current.profileValues, "prod").find(
      (v) => v.name === "key",
    ).value,
    "rotated-key",
  );
});

test("applyProfileEdit: deleting a variable drops it from the Default + every profile", () => {
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "p", key: "pk" } },
  };
  const edited = [{ name: "host", value: "p", secure: false }]; // key removed
  const out = applyProfileEdit(current, "prod", edited, ["prod"]);
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
