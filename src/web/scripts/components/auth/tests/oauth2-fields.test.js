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
 * oauth2-fields.test.js — pins the unified OAuth 2.0 field spec.
 *
 * The form UI and the bulk text editor both derive their field set from
 * OAUTH2_FIELDS now (see auth/oauth2-fields.js), so they can't drift — but the
 * spec ITSELF must stay correct. These tests pin the visible field set per grant
 * (the exact thing the two old definitions used to disagree on), the enum and
 * advanced-key sets the bulk editor relies on, and that every i18n key the spec
 * references actually exists in en.json (the i18n guard's blind spot).
 *
 * Run with:   node --test src/web/scripts/components/auth/tests/oauth2-fields.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  OAUTH2_FIELDS,
  TOKEN_EXCHANGE_TOKEN_TYPES,
  oauth2VisibleFields,
  oauth2AdvancedKeys,
  oauth2EnumValues,
} from "../oauth2-fields.js";

const keys = (grant, clientType, advanced) =>
  oauth2VisibleFields(grant, clientType, advanced).map((f) => f.key);

// ── Visible field set per grant (the field set that used to drift) ──────────
// Each entry is the FULL (advanced-on) ordered key list. The basic (advanced-off)
// list is derived by dropping the advanced keys, and asserted to match too.

const EXPECTED_FULL = {
  client_credentials: [
    "grantType",
    "clientId",
    "clientSecret",
    "accessTokenUrl",
    "scope",
    "credentials",
    "audience",
    "resource",
    "headerPrefix",
  ],
  password: [
    "grantType",
    "clientId",
    "clientSecret",
    "accessTokenUrl",
    "username",
    "password",
    "scope",
    "credentials",
    "audience",
    "headerPrefix",
  ],
  implicit: [
    "grantType",
    "clientId",
    "authUrl",
    "redirectUri",
    "scope",
    "responseType",
    "audience",
    "headerPrefix",
  ],
  device_code: [
    "grantType",
    "clientId",
    "clientSecret",
    "accessTokenUrl",
    "deviceAuthorizationUrl",
    "scope",
    "audience",
    "headerPrefix",
  ],
  token_exchange: [
    "grantType",
    "clientId",
    "clientSecret",
    "accessTokenUrl",
    "subjectToken",
    "subjectTokenType",
    "scope",
    "audience",
    "resource",
    "actorToken",
    "actorTokenType",
    "requestedTokenType",
    "headerPrefix",
  ],
};

const advancedSet = new Set(oauth2AdvancedKeys());

for (const [grant, full] of Object.entries(EXPECTED_FULL)) {
  test(`oauth2VisibleFields: ${grant} renders the expected fields (advanced on/off, in order)`, () => {
    assert.deepEqual(keys(grant, "confidential", true), full, "advanced on");
    assert.deepEqual(
      keys(grant, "confidential", false),
      full.filter((k) => !advancedSet.has(k)),
      "advanced off drops exactly the advanced fields",
    );
  });
}

test("oauth2VisibleFields: authorization_code shows clientType, and hides clientSecret for a public client", () => {
  const confidential = [
    "grantType",
    "clientType",
    "clientId",
    "clientSecret",
    "accessTokenUrl",
    "authUrl",
    "redirectUri",
    "scope",
    "credentials",
    "audience",
    "resource",
    "origin",
    "headerPrefix",
  ];
  assert.deepEqual(
    keys("authorization_code", "confidential", true),
    confidential,
  );

  // Public client: identical, minus clientSecret (no secret to send).
  assert.deepEqual(
    keys("authorization_code", "public", true),
    confidential.filter((k) => k !== "clientSecret"),
  );
});

// ── Enum + advanced-key sets the bulk editor depends on ─────────────────────

test("oauth2EnumValues exposes exactly the bulk-constrained selects", () => {
  const enums = oauth2EnumValues();
  assert.deepEqual(Object.keys(enums).sort(), [
    "clientType",
    "credentials",
    "grantType",
    "responseType",
  ]);
  assert.deepEqual([...enums.grantType].sort(), [
    "authorization_code",
    "client_credentials",
    "device_code",
    "implicit",
    "password",
    "token_exchange",
  ]);
  assert.deepEqual([...enums.clientType].sort(), ["confidential", "public"]);
  assert.deepEqual([...enums.credentials].sort(), ["body", "header"]);
  assert.deepEqual([...enums.responseType].sort(), [
    "access_token",
    "both",
    "id_token",
  ]);
});

test("oauth2AdvancedKeys matches the documented advanced-field set", () => {
  assert.deepEqual([...oauth2AdvancedKeys()].sort(), [
    "actorToken",
    "actorTokenType",
    "audience",
    "credentials",
    "headerPrefix",
    "origin",
    "requestedTokenType",
    "resource",
    "responseType",
  ]);
});

// ── i18n: every key the spec references resolves in en.json ─────────────────

test("every i18n key referenced by the spec exists in en.json", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const en = JSON.parse(
    readFileSync(join(here, "../../../../locales/en.json"), "utf8"),
  );
  const resolve = (key) =>
    key.split(".").reduce((o, part) => (o == null ? undefined : o[part]), en);

  const missing = [];
  const check = (key) => {
    if (key && typeof resolve(key) !== "string") missing.push(key);
  };
  for (const f of OAUTH2_FIELDS) {
    check(f.labelKey);
    check(f.placeholderKey);
    check(f.hintKey);
    check(f.ariaLabelKey);
    for (const o of f.options ?? []) check(o.labelKey);
  }
  for (const t of TOKEN_EXCHANGE_TOKEN_TYPES) check(t.labelKey);

  assert.deepEqual(
    missing,
    [],
    `unresolved en.json keys: ${missing.join(", ")}`,
  );
});
