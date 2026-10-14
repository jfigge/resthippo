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
  resolvedProfileVars,
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

test("effectiveProfileVars: a new/unseen profile shows the Default names, all INHERITING (blank, not overridden)", () => {
  const inheriting = [
    { name: "host", value: "", secure: false, overridden: false },
    { name: "key", value: "", secure: true, overridden: false },
  ];
  assert.deepEqual(effectiveProfileVars(dflt, {}, "prod"), inheriting);
  assert.deepEqual(effectiveProfileVars(dflt, undefined, "prod"), inheriting);
});

test("effectiveProfileVars: presence marks overrides — a present name (even empty) is overridden; an absent name inherits (blank)", () => {
  // key is present with an empty value → an EXPLICIT empty override.
  const pv = { prod: { host: "prod.example.com", key: "" } };
  assert.deepEqual(effectiveProfileVars(dflt, pv, "prod"), [
    {
      name: "host",
      value: "prod.example.com",
      secure: false,
      overridden: true,
    },
    { name: "key", value: "", secure: true, overridden: true },
  ]);
  // With key absent it inherits → shown blank + not overridden.
  assert.deepEqual(
    effectiveProfileVars(dflt, { prod: { host: "p" } }, "prod"),
    [
      { name: "host", value: "p", secure: false, overridden: true },
      { name: "key", value: "", secure: true, overridden: false },
    ],
  );
});

test("resolvedProfileVars: Default profile resolves to the canonical default set", () => {
  assert.deepEqual(resolvedProfileVars(dflt, {}, null), dflt);
  assert.deepEqual(resolvedProfileVars(dflt, {}, ""), dflt);
});

test("resolvedProfileVars: an overridden name uses its value; an ABSENT name inherits the Default", () => {
  const pv = { prod: { host: "prod.example.com" } }; // key absent
  assert.deepEqual(resolvedProfileVars(dflt, pv, "prod"), [
    { name: "host", value: "prod.example.com", secure: false }, // override
    { name: "key", value: "dev-key", secure: true }, // inherit
  ]);
});

test("resolvedProfileVars: an explicit EMPTY override resolves empty (does NOT inherit)", () => {
  const pv = { prod: { host: "" } }; // host present with "" → explicit empty
  assert.deepEqual(resolvedProfileVars(dflt, pv, "prod"), [
    { name: "host", value: "", secure: false }, // explicit empty, not the Default
    { name: "key", value: "dev-key", secure: true }, // absent → inherit
  ]);
});

test("resolvedProfileVars: an unseen profile inherits every Default value", () => {
  assert.deepEqual(resolvedProfileVars(dflt, {}, "prod"), dflt);
  assert.deepEqual(resolvedProfileVars(dflt, undefined, "prod"), dflt);
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

test("applyProfileEdit: an explicit override set stores an EMPTY override (presence, not inheritance)", () => {
  const current = { variables: dflt, profileValues: { prod: {} } };
  const edited = [
    { name: "host", value: "prod.example.com", secure: false },
    { name: "key", value: "", secure: true }, // blank, but explicitly overridden
  ];
  // The KV table passes the exact override names — an empty override is kept.
  const out = applyProfileEdit(
    current,
    "prod",
    edited,
    ["prod"],
    ["host", "key"],
  );
  assert.deepEqual(out.profileValues.prod, {
    host: "prod.example.com",
    key: "", // stored empty override, NOT dropped to inherit
  });
});

test("applyProfileEdit: a name omitted from the override set INHERITS (unstored), regardless of its value", () => {
  const current = { variables: dflt, profileValues: { prod: { host: "old" } } };
  const edited = [
    { name: "host", value: "old", secure: false },
    { name: "key", value: "typed", secure: true },
  ];
  // Only "host" is an override; "key" is not, so it is left unstored (inherit)
  // even though the edit carries a value for it.
  const out = applyProfileEdit(current, "prod", edited, ["prod"], ["host"]);
  assert.deepEqual(out.profileValues.prod, { host: "old" });
});

test("applyProfileEdit: without an override set (bulk), non-blank overrides and blank inherits", () => {
  const current = { variables: dflt, profileValues: { prod: {} } };
  const edited = [
    { name: "host", value: "prod.example.com", secure: false }, // override
    { name: "key", value: "", secure: true }, // blank → inherit (bulk can't force empty)
  ];
  const out = applyProfileEdit(current, "prod", edited, ["prod"]); // no overrideNames
  assert.deepEqual(out.profileValues.prod, { host: "prod.example.com" });
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

// ── Layered resolution (scoped profiles) ────────────────────────────────────
// `profileIds` is ordered OUTERMOST owner → INNERMOST. Each id whose map this
// folder stores is applied in turn, so the innermost override of a name wins
// while a name only an outer profile touches still comes through.

test("resolvedProfileVars: a bare string id still works (one-element list)", () => {
  const pv = { prod: { host: "p.example.com" } };
  assert.deepEqual(resolvedProfileVars(dflt, pv, "prod"), [
    { name: "host", value: "p.example.com", secure: false },
    { name: "key", value: "dev-key", secure: true },
  ]);
});

test("resolvedProfileVars: empty / null id lists resolve to the Default set", () => {
  const pv = { prod: { host: "p" } };
  assert.deepEqual(resolvedProfileVars(dflt, pv, []), dflt);
  assert.deepEqual(resolvedProfileVars(dflt, pv, null), dflt);
  assert.deepEqual(resolvedProfileVars(dflt, pv, [null, ""]), dflt);
});

test("resolvedProfileVars: the INNERMOST layer wins on a shared name", () => {
  const pv = {
    outer: { host: "outer.example.com", key: "outer-key" },
    inner: { host: "inner.example.com" },
  };
  // outer → inner: host comes from inner, key from outer (inner doesn't set it).
  assert.deepEqual(resolvedProfileVars(dflt, pv, ["outer", "inner"]), [
    { name: "host", value: "inner.example.com", secure: false },
    { name: "key", value: "outer-key", secure: true },
  ]);
});

test("resolvedProfileVars: layer order is honoured, not id order", () => {
  const pv = { a: { host: "A" }, b: { host: "B" } };
  assert.equal(resolvedProfileVars(dflt, pv, ["a", "b"])[0].value, "B");
  assert.equal(resolvedProfileVars(dflt, pv, ["b", "a"])[0].value, "A");
});

test("resolvedProfileVars: an inner EMPTY override beats an outer value", () => {
  // Presence, not truthiness — an explicit "" from the inner profile must win.
  const pv = { outer: { host: "outer.example.com" }, inner: { host: "" } };
  assert.equal(resolvedProfileVars(dflt, pv, ["outer", "inner"])[0].value, "");
});

test("resolvedProfileVars: ids this folder stores no map for are skipped", () => {
  // A profile owned by an ancestor that this folder never overrode: it must fall
  // through to the Default rather than blanking the value.
  const pv = { inner: { key: "inner-key" } };
  assert.deepEqual(resolvedProfileVars(dflt, pv, ["absent", "inner"]), [
    { name: "host", value: "dev.example.com", secure: false },
    { name: "key", value: "inner-key", secure: true },
  ]);
});

test("resolvedProfileVars: secure flags always come from the Default, never a layer", () => {
  const pv = { outer: { key: "x" }, inner: { host: "y" } };
  const out = resolvedProfileVars(dflt, pv, ["outer", "inner"]);
  assert.equal(out.find((v) => v.name === "key").secure, true);
  assert.equal(out.find((v) => v.name === "host").secure, false);
});

// ── applyProfileEdit: never prune ids the caller didn't list ────────────────

test("applyProfileEdit: an id outside profileIds is carried forward untouched", () => {
  // "dormant" values — the folder was dragged out from under the profile's owner.
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "p" }, dormant: { host: "d", key: "dk" } },
  };
  const out = applyProfileEdit(
    current,
    "prod",
    [
      { name: "host", value: "p2", secure: false },
      { name: "key", value: "", secure: true },
    ],
    ["prod"], // only "prod" is in scope
    ["host"],
  );
  assert.deepEqual(out.profileValues.prod, { host: "p2" });
  assert.deepEqual(
    out.profileValues.dormant,
    { host: "d", key: "dk" },
    "an out-of-scope profile's values must survive an unrelated edit",
  );
});

test("applyProfileEdit: a Default edit still prunes dropped names from EVERY stored id", () => {
  // Pruning by NAME (the Default owns the set) is unrelated to pruning by ID.
  const current = {
    variables: dflt,
    profileValues: { prod: { host: "p", key: "pk" }, dormant: { key: "dk" } },
  };
  const out = applyProfileEdit(
    current,
    null,
    [{ name: "host", value: "dev.example.com", secure: false }], // "key" deleted
    [],
  );
  assert.deepEqual(out.profileValues.prod, { host: "p" });
  assert.equal(
    out.profileValues.dormant,
    undefined,
    "dormant kept only a dropped name → its map is empty → omitted",
  );
});

// ── applyProfileEdit: no empty maps ─────────────────────────────────────────
// `{}` and "absent" are indistinguishable at read time, and writing `{}` for
// every known profile on every save destroyed "has a profileValues key" as a
// signal for which folders actually use a profile.

test("applyProfileEdit: a profile that overrides nothing is OMITTED, not stored as {}", () => {
  const current = { variables: dflt, profileValues: {} };
  const out = applyProfileEdit(current, null, dflt, ["prod", "stg"]);
  assert.deepEqual(
    out.profileValues,
    {},
    "an untouched profile must not gain a bookkeeping key",
  );
});

test("applyProfileEdit: clearing the last override drops the key entirely", () => {
  const current = { variables: dflt, profileValues: { prod: { host: "p" } } };
  const out = applyProfileEdit(
    current,
    "prod",
    [
      { name: "host", value: "", secure: false },
      { name: "key", value: "", secure: true },
    ],
    ["prod"],
    [], // nothing is an override any more — both inherit
  );
  assert.equal(out.profileValues.prod, undefined);
});
