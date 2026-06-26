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
 * auth/oauth2-fields.js — the single source of truth for the OAuth 2.0 auth
 * field set.
 *
 * The form UI (RequestAuthEditor #renderAuthOAuth2) and the bulk text editor
 * (#getAuthFields / #updateAuthFromText) used to declare this field set TWICE,
 * with parallel grant-type/advanced conditionals that silently drifted. Both now
 * derive from `OAUTH2_FIELDS` here, so a field can only be added/changed/removed
 * in one place. The render↔bulk parity is pinned by tests/oauth2-fields.test.js.
 *
 * A descriptor never calls t() at module scope (the catalog isn't loaded yet) —
 * it stores `labelKey`/`placeholderKey`/`hintKey`/`ariaLabelKey`/option
 * `labelKey`s, which the consumers resolve via t() at render time.
 *
 * Descriptor shape:
 *   key            model key on authOAuth2 (also the bulk-editor line key)
 *   labelKey       i18n key for the field label (omitted for the scope combo,
 *                  which owns its own label)
 *   type           "select" | "pill" | "scope"
 *   default        value when the model key is unset — PRESENCE matters: a field
 *                  WITHOUT a `default` reports its raw (possibly undefined) value,
 *                  exactly as the original code did (clientId/secret/url/scope)
 *   visibleFor     (grant, clientType) => boolean — when the field is shown
 *   advanced       true → only under the "Advanced" toggle
 *   secret         decrypt path for the masked secret-field wrapper (pills)
 *   placeholderKey i18n key for the pill placeholder
 *   hintKey        i18n key for the pill hint line
 *   ariaLabelKey   i18n key for a select's aria-label
 *   rerender       true → changing it re-renders the form (grant/client type,
 *                  which change the visible field set)
 *   options        select options as [{ value, labelKey }]
 *   bulkEnum       true → the bulk editor constrains this key to its option
 *                  values (so a typo can't desync the select)
 */
"use strict";

/** RFC 8693 §3 token-type identifiers for the Token Exchange selects. */
export const TOKEN_EXCHANGE_TOKEN_TYPES = [
  {
    value: "urn:ietf:params:oauth:token-type:access_token",
    labelKey: "auth.oauth2.tokenExchange.typeAccessToken",
  },
  {
    value: "urn:ietf:params:oauth:token-type:refresh_token",
    labelKey: "auth.oauth2.tokenExchange.typeRefreshToken",
  },
  {
    value: "urn:ietf:params:oauth:token-type:id_token",
    labelKey: "auth.oauth2.tokenExchange.typeIdToken",
  },
  {
    value: "urn:ietf:params:oauth:token-type:jwt",
    labelKey: "auth.oauth2.tokenExchange.typeJwt",
  },
  {
    value: "urn:ietf:params:oauth:token-type:saml2",
    labelKey: "auth.oauth2.tokenExchange.typeSaml2",
  },
  {
    value: "urn:ietf:params:oauth:token-type:saml1",
    labelKey: "auth.oauth2.tokenExchange.typeSaml1",
  },
];

const TOKEN_TYPE_DEFAULT = TOKEN_EXCHANGE_TOKEN_TYPES[0].value;

// Grant-type groups, named once so the visibility predicates read declaratively.
const AUTH_OR_IMPLICIT = ["authorization_code", "implicit"];
const CREDENTIALS_GRANTS = [
  "authorization_code",
  "password",
  "client_credentials",
];
const RESOURCE_GRANTS = [
  "authorization_code",
  "client_credentials",
  "token_exchange",
];
const is =
  (...grants) =>
  (g) =>
    grants.includes(g);
const always = () => true;

/**
 * The OAuth 2.0 field set, in render order: basic fields first, then advanced.
 * (oauth2VisibleFields filters this by grant/clientType/advanced — the array
 * order is the on-screen order for both consumers.)
 */
export const OAUTH2_FIELDS = [
  // ── Basic ─────────────────────────────────────────────────────────────────
  {
    key: "grantType",
    labelKey: "auth.oauth2.grantType",
    ariaLabelKey: "auth.oauth2.grantTypeAria",
    type: "select",
    default: "client_credentials",
    visibleFor: always,
    rerender: true,
    bulkEnum: true,
    options: [
      {
        value: "authorization_code",
        labelKey: "auth.oauth2.grant.authorizationCode",
      },
      {
        value: "client_credentials",
        labelKey: "auth.oauth2.grant.clientCredentials",
      },
      { value: "password", labelKey: "auth.oauth2.grant.password" },
      { value: "implicit", labelKey: "auth.oauth2.grant.implicit" },
      { value: "device_code", labelKey: "auth.oauth2.grant.deviceCode" },
      { value: "token_exchange", labelKey: "auth.oauth2.grant.tokenExchange" },
    ],
  },
  {
    key: "clientType",
    labelKey: "auth.oauth2.clientType",
    ariaLabelKey: "auth.oauth2.clientTypeAria",
    type: "select",
    default: "confidential",
    visibleFor: is("authorization_code"),
    rerender: true,
    bulkEnum: true,
    options: [
      { value: "confidential", labelKey: "auth.oauth2.clientTypeConfidential" },
      { value: "public", labelKey: "auth.oauth2.clientTypePublic" },
    ],
  },
  {
    key: "clientId",
    labelKey: "auth.oauth2.clientId",
    placeholderKey: "auth.oauth2.clientId",
    type: "pill",
    visibleFor: always,
  },
  {
    key: "clientSecret",
    labelKey: "auth.oauth2.clientSecret",
    placeholderKey: "auth.oauth2.clientSecret",
    type: "pill",
    secret: "authOAuth2.clientSecret",
    // Hidden for implicit (no token exchange) and for a public auth-code client.
    visibleFor: (g, ct) =>
      g !== "implicit" && !(g === "authorization_code" && ct === "public"),
  },
  {
    key: "accessTokenUrl",
    labelKey: "auth.oauth2.accessTokenUrl",
    placeholderKey: "auth.oauth2.accessTokenUrlPlaceholder",
    type: "pill",
    visibleFor: (g) => g !== "implicit",
  },
  {
    key: "deviceAuthorizationUrl",
    labelKey: "auth.oauth2.deviceAuthorizationUrl",
    placeholderKey: "auth.oauth2.deviceAuthorizationUrlPlaceholder",
    hintKey: "auth.oauth2.deviceAuthorizationUrlHint",
    type: "pill",
    default: "",
    visibleFor: is("device_code"),
  },
  {
    key: "subjectToken",
    labelKey: "auth.oauth2.tokenExchange.subjectToken",
    placeholderKey: "auth.oauth2.tokenExchange.subjectTokenPlaceholder",
    type: "pill",
    secret: "authOAuth2.subjectToken",
    default: "",
    visibleFor: is("token_exchange"),
  },
  {
    key: "subjectTokenType",
    labelKey: "auth.oauth2.tokenExchange.subjectTokenType",
    type: "select",
    default: TOKEN_TYPE_DEFAULT,
    visibleFor: is("token_exchange"),
    options: TOKEN_EXCHANGE_TOKEN_TYPES,
  },
  {
    key: "authUrl",
    labelKey: "auth.oauth2.authUrl",
    placeholderKey: "auth.oauth2.authUrlPlaceholder",
    type: "pill",
    visibleFor: is(...AUTH_OR_IMPLICIT),
  },
  {
    key: "redirectUri",
    labelKey: "auth.oauth2.redirectUri",
    placeholderKey: "auth.oauth2.redirectUriPlaceholder",
    hintKey: "auth.oauth2.redirectUriHint",
    type: "pill",
    default: "",
    visibleFor: is(...AUTH_OR_IMPLICIT),
  },
  {
    key: "username",
    labelKey: "auth.username",
    placeholderKey: "auth.username",
    type: "pill",
    default: "",
    visibleFor: is("password"),
  },
  {
    key: "password",
    labelKey: "auth.password",
    placeholderKey: "auth.password",
    type: "pill",
    secret: "authOAuth2.password",
    default: "",
    visibleFor: is("password"),
  },
  {
    key: "scope",
    type: "scope",
    visibleFor: always,
  },

  // ── Advanced ────────────────────────────────────────────────────────────────
  {
    key: "responseType",
    labelKey: "auth.oauth2.responseType",
    ariaLabelKey: "auth.oauth2.responseTypeAria",
    type: "select",
    default: "access_token",
    advanced: true,
    visibleFor: is("implicit"),
    bulkEnum: true,
    options: [
      { value: "access_token", labelKey: "auth.oauth2.responseAccessToken" },
      { value: "id_token", labelKey: "auth.oauth2.responseIdToken" },
      { value: "both", labelKey: "auth.oauth2.responseBoth" },
    ],
  },
  {
    key: "state",
    labelKey: "auth.oauth2.state",
    placeholderKey: "auth.oauth2.statePlaceholder",
    type: "pill",
    default: "",
    advanced: true,
    visibleFor: is(...AUTH_OR_IMPLICIT),
  },
  {
    key: "credentials",
    labelKey: "auth.oauth2.credentials",
    ariaLabelKey: "auth.oauth2.credentialsAria",
    type: "select",
    default: "header",
    advanced: true,
    visibleFor: is(...CREDENTIALS_GRANTS),
    bulkEnum: true,
    options: [
      { value: "header", labelKey: "auth.oauth2.credentialsHeader" },
      { value: "body", labelKey: "auth.oauth2.credentialsBody" },
    ],
  },
  {
    key: "audience",
    labelKey: "auth.oauth2.audience",
    placeholderKey: "auth.oauth2.audiencePlaceholder",
    type: "pill",
    default: "",
    advanced: true,
    visibleFor: always,
  },
  {
    key: "resource",
    labelKey: "auth.oauth2.resource",
    placeholderKey: "auth.oauth2.resourcePlaceholder",
    type: "pill",
    default: "",
    advanced: true,
    visibleFor: is(...RESOURCE_GRANTS),
  },
  {
    key: "actorToken",
    labelKey: "auth.oauth2.tokenExchange.actorToken",
    placeholderKey: "auth.oauth2.tokenExchange.actorTokenPlaceholder",
    hintKey: "auth.oauth2.tokenExchange.actorTokenHint",
    type: "pill",
    secret: "authOAuth2.actorToken",
    default: "",
    advanced: true,
    visibleFor: is("token_exchange"),
  },
  {
    key: "actorTokenType",
    labelKey: "auth.oauth2.tokenExchange.actorTokenType",
    type: "select",
    default: TOKEN_TYPE_DEFAULT,
    advanced: true,
    visibleFor: is("token_exchange"),
    options: TOKEN_EXCHANGE_TOKEN_TYPES,
  },
  {
    key: "requestedTokenType",
    labelKey: "auth.oauth2.tokenExchange.requestedTokenType",
    type: "select",
    default: "",
    advanced: true,
    visibleFor: is("token_exchange"),
    // A leading "unspecified" option ahead of the standard token types.
    options: [
      {
        value: "",
        labelKey: "auth.oauth2.tokenExchange.requestedTokenTypeNone",
      },
      ...TOKEN_EXCHANGE_TOKEN_TYPES,
    ],
  },
  {
    key: "origin",
    labelKey: "auth.oauth2.origin",
    placeholderKey: "auth.oauth2.originPlaceholder",
    type: "pill",
    default: "",
    advanced: true,
    visibleFor: is("authorization_code"),
  },
  {
    key: "headerPrefix",
    labelKey: "auth.oauth2.headerPrefix",
    placeholderKey: "auth.oauth2.headerPrefixPlaceholder",
    hintKey: "auth.oauth2.headerPrefixHint",
    type: "pill",
    default: "",
    advanced: true,
    visibleFor: always,
  },
];

/**
 * The fields visible for a given grant + client type, in render order. Advanced
 * fields are included only when `advanced` is true.
 * @param {string} grant
 * @param {string|undefined} clientType
 * @param {boolean} advanced
 * @returns {typeof OAUTH2_FIELDS}
 */
export function oauth2VisibleFields(grant, clientType, advanced) {
  return OAUTH2_FIELDS.filter(
    (f) => f.visibleFor(grant, clientType) && (advanced || !f.advanced),
  );
}

/** The model keys that live behind the Advanced toggle (was OAUTH2_ADVANCED_KEYS). */
export function oauth2AdvancedKeys() {
  return OAUTH2_FIELDS.filter((f) => f.advanced).map((f) => f.key);
}

/**
 * Enum-valued keys the bulk editor must constrain → their allowed value Set
 * (was OAUTH2_ENUM_VALUES). Built from the `bulkEnum` selects' option values.
 * @returns {Record<string, Set<string>>}
 */
export function oauth2EnumValues() {
  const out = {};
  for (const f of OAUTH2_FIELDS) {
    if (f.bulkEnum) out[f.key] = new Set(f.options.map((o) => o.value));
  }
  return out;
}
