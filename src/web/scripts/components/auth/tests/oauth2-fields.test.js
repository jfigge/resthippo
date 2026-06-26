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
    "state",
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
    "state",
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
    "state",
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
