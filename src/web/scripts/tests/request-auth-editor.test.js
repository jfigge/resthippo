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
 * tests/request-auth-editor.test.js
 *
 * Behavior-coverage tests for the standalone RequestAuthEditor (the Auth tab
 * sub-component normally owned by RequestEditor). These exercise the uncovered
 * surface: every auth-type renderer (none/basic/bearer/apikey/digest/ntlm/
 * aws-iam/oauth1/oauth2), the type-switch re-render, field→model wiring for the
 * plain inputs/selects, and the bulk-editor round-trip (the "key: value" textarea
 * and its per-type key parsing).
 *
 * Mount pattern mirrors request-editor.test.js: jsdom-setup MUST be imported
 * first (the component reaches for document / the Prism-loaded globals on import).
 *
 * Run with:   node --test tests/request-auth-editor.test.js
 */

"use strict";

// MUST precede the component import (jsdom globals + i18n catalog installed here).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { RequestAuthEditor } from "../components/request-auth-editor.js";

/**
 * Fresh DOM + a standalone RequestAuthEditor, mounted in the body.
 *
 * getCurrentNodeId returns a real id so #dispatchAuthUpdated fires the
 * `hippo:request-updated` event (it early-returns when the id is null), letting
 * the model-mutation tests observe the persisted detail. getContext/getItems are
 * inert stubs — pill editors don't need a real variable context to render.
 *
 * @param {object|null} model  optional node passed to setModel()
 * @returns {{ window: Window, auth: RequestAuthEditor }}
 */
function mount(model, nodeId = "node-1") {
  const window = resetDom();
  window.hippo = { isElectron: false };
  const auth = new RequestAuthEditor({
    getContext: () => ({ collectionVariables: {}, folderChain: [] }),
    getItems: () => [],
    ensureResponseCaches: () => {},
    getCurrentNodeId: () => nodeId,
  });
  document.body.appendChild(auth.element);
  if (model) auth.setModel(model);
  return { window, auth };
}

/** Labels of the rendered auth-form fields (each pill/select/input carries a
 *  `.auth-field-label`). Lets a test assert the exact field set for a type. */
function fieldLabels(auth) {
  return [...auth.element.querySelectorAll(".auth-field-label")].map((l) =>
    l.textContent.trim(),
  );
}

/** Capture the next `hippo:request-updated` detail dispatched on the window. */
function nextUpdate(window) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no request-updated")), 1000);
    window.addEventListener(
      "hippo:request-updated",
      (e) => {
        clearTimeout(t);
        resolve(e.detail);
      },
      { once: true },
    );
  });
}

// ── Per-type rendering ───────────────────────────────────────────────────────

test("none renders the empty-auth notice and no form fields", () => {
  const { auth } = mount({ id: "n", authType: "none" });
  assert.ok(
    auth.element.querySelector(".params-empty"),
    "shows the no-auth message",
  );
  assert.equal(fieldLabels(auth).length, 0, "no auth fields for None");
});

test("basic renders Username + Password pill fields", () => {
  const { auth } = mount({
    id: "b",
    authType: "basic",
    authBasic: { username: "alice", password: "pw" },
  });
  assert.deepEqual(fieldLabels(auth), ["Username", "Password"]);
  // Values land in the pill editors (aria-label === field label).
  const user = auth.element.querySelector('[aria-label="Username"]');
  assert.ok(user, "username pill editor present");
  // Strip the zero-width caret-anchor guards the pill editor pads with.
  assert.equal(user.textContent.replace(/​/g, ""), "alice");
});

test("bearer renders a single Token field", () => {
  const { auth } = mount({
    id: "be",
    authType: "bearer",
    authBearer: { token: "tok-1" },
  });
  assert.deepEqual(fieldLabels(auth), ["Token"]);
});

test("apikey renders Key name, Value, and an Add-to select", () => {
  const { auth } = mount({
    id: "k",
    authType: "apikey",
    authApiKey: { name: "X-API-Key", value: "secret", addTo: "query" },
  });
  assert.deepEqual(fieldLabels(auth), ["Key", "Value", "Add to"]);
  const addTo = auth.element.querySelector("select.auth-field-select");
  assert.ok(addTo, "Add-to select present");
  assert.equal(addTo.value, "query", "select reflects the model's addTo");
  // Two options: header / query.
  assert.deepEqual(
    [...addTo.options].map((o) => o.value),
    ["header", "query"],
  );
});

test("digest renders Username + Password", () => {
  const { auth } = mount({ id: "d", authType: "digest" });
  assert.deepEqual(fieldLabels(auth), ["Username", "Password"]);
});

test("ntlm renders Username, Password, Domain, Workstation", () => {
  const { auth } = mount({ id: "nt", authType: "ntlm" });
  assert.deepEqual(fieldLabels(auth), [
    "Username",
    "Password",
    "Domain",
    "Workstation",
  ]);
});

test("aws-iam renders the five SigV4 credential fields", () => {
  const { auth } = mount({ id: "a", authType: "aws-iam" });
  assert.deepEqual(fieldLabels(auth), [
    "Access Key ID",
    "Secret Access Key",
    "Region",
    "Service",
    "Session Token",
  ]);
});

test("oauth1 renders all six fields including the signature-method select", () => {
  const { auth } = mount({
    id: "o1",
    authType: "oauth1",
    authOAuth1: { signatureMethod: "HMAC-SHA256" },
  });
  assert.deepEqual(fieldLabels(auth), [
    "Consumer Key",
    "Consumer Secret",
    "Access Token",
    "Token Secret",
    "Signature Method",
    "Realm",
  ]);
  const sig = auth.element.querySelector("select.auth-field-select");
  assert.equal(
    sig.value,
    "HMAC-SHA256",
    "signature-method select reflects model",
  );
  assert.deepEqual(
    [...sig.options].map((o) => o.value),
    ["HMAC-SHA1", "HMAC-SHA256", "PLAINTEXT"],
  );
});

test("oauth2 renders the grant select and core fields, plus the Advanced toggle and Get-Token button", () => {
  const { auth } = mount({
    id: "o2",
    authType: "oauth2",
    authOAuth2: { grantType: "client_credentials" },
  });
  // The grant <select> is the first field; its value reflects the model.
  const grant = auth.element.querySelector("select.auth-field-select");
  assert.ok(grant, "grant select present");
  assert.equal(grant.value, "client_credentials");
  // The advanced toggle and the Get-Token button are always present.
  assert.ok(
    auth.element.querySelector("#oauth2-advanced-toggle"),
    "advanced toggle present",
  );
  assert.ok(
    auth.element.querySelector(".auth-get-token-btn"),
    "Get-Token button present",
  );
});

test("oauth2 authorization_code grant shows the client-type + auth-URL fields", () => {
  const { auth } = mount({
    id: "o2",
    authType: "oauth2",
    authOAuth2: { grantType: "authorization_code" },
  });
  const labels = fieldLabels(auth);
  // The authorization_code grant adds an Auth URL field that client_credentials
  // never shows — a concrete proof the visible-field set is grant-driven.
  assert.ok(
    labels.some((l) => /auth/i.test(l) && /url/i.test(l)),
    `authorization_code shows an auth-URL field (got: ${labels.join(", ")})`,
  );
});

test("oauth2 password grant shows resource-owner username + password fields", () => {
  const { auth } = mount({
    id: "o2",
    authType: "oauth2",
    authOAuth2: { grantType: "password" },
  });
  const labels = fieldLabels(auth);
  assert.ok(
    labels.includes("Username"),
    `password grant shows Username (got: ${labels.join(", ")})`,
  );
  assert.ok(
    labels.includes("Password"),
    `password grant shows Password (got: ${labels.join(", ")})`,
  );
});

// ── Type switching re-renders the field set ──────────────────────────────────

test("switching auth type via the selector re-renders the matching fields", () => {
  const { auth } = mount({ id: "s", authType: "basic" });
  assert.deepEqual(fieldLabels(auth), ["Username", "Password"]);

  const sel = auth.element.querySelector("#auth-type-select");
  sel.value = "aws-iam";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert.deepEqual(fieldLabels(auth), [
    "Access Key ID",
    "Secret Access Key",
    "Region",
    "Service",
    "Session Token",
  ]);
});

test("switching to None hides the bulk-editor + Enabled toggles and clears fields", () => {
  const { auth } = mount({ id: "s", authType: "basic" });
  const sel = auth.element.querySelector("#auth-type-select");
  sel.value = "none";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert.equal(fieldLabels(auth).length, 0, "no fields under None");
  assert.ok(
    auth.element.querySelector(".params-empty"),
    "shows the no-auth notice after switching",
  );
});

// ── Field → model wiring (plain inputs / selects) ────────────────────────────

test("changing the API-key Add-to select updates the model + dispatches an update", async () => {
  const { window, auth } = mount({
    id: "k",
    authType: "apikey",
    authApiKey: { name: "X-API-Key", value: "v", addTo: "header" },
  });
  const addTo = auth.element.querySelector("select.auth-field-select");
  const updated = nextUpdate(window);
  addTo.value = "query";
  addTo.dispatchEvent(new window.Event("change", { bubbles: true }));

  const detail = await updated;
  assert.equal(detail.authApiKey.addTo, "query", "event carries new addTo");
  assert.equal(auth.getModel().authApiKey.addTo, "query", "model updated");
});

test("typing in the API-key name input updates the model", async () => {
  const { window, auth } = mount({
    id: "k",
    authType: "apikey",
    authApiKey: { name: "", value: "", addTo: "header" },
  });
  // The name field is a plain <input> (combo) with an aria-label, not a pill.
  const nameInput = auth.element.querySelector(
    'input[name="resthippo-auth-apikey-name"]',
  );
  assert.ok(nameInput, "api-key name input present");
  const updated = nextUpdate(window);
  nameInput.value = "X-Custom-Key";
  nameInput.dispatchEvent(new window.InputEvent("input", { bubbles: true }));

  const detail = await updated;
  assert.equal(detail.authApiKey.name, "X-Custom-Key");
});

test("changing the OAuth1 signature-method select updates the model", async () => {
  const { window, auth } = mount({
    id: "o1",
    authType: "oauth1",
    authOAuth1: { signatureMethod: "HMAC-SHA1" },
  });
  const sig = auth.element.querySelector("select.auth-field-select");
  const updated = nextUpdate(window);
  sig.value = "PLAINTEXT";
  sig.dispatchEvent(new window.Event("change", { bubbles: true }));

  const detail = await updated;
  assert.equal(detail.authOAuth1.signatureMethod, "PLAINTEXT");
});

test("toggling the Enabled checkbox flips authEnabled and disables the content", async () => {
  const { window, auth } = mount({
    id: "b",
    authType: "basic",
    authEnabled: true,
  });
  const check = auth.element.querySelector("#auth-enabled-check");
  assert.equal(check.checked, true);
  const updated = nextUpdate(window);
  check.checked = false;
  check.dispatchEvent(new window.Event("change", { bubbles: true }));

  const detail = await updated;
  assert.equal(detail.authEnabled, false);
  assert.ok(
    auth.element
      .querySelector(".body-content")
      .classList.contains("auth-content--disabled"),
    "content area marked disabled",
  );
});

// ── Bulk editor round-trip ───────────────────────────────────────────────────

/** Enable bulk mode via its toggle and return the rendered textarea. */
function enableBulk(window, auth) {
  const bulkCheck = auth.element.querySelector(
    ".params-toolbar-toggle-label input.params-toolbar-toggle",
  );
  bulkCheck.checked = true;
  bulkCheck.dispatchEvent(new window.Event("change", { bubbles: true }));
  return auth.element.querySelector(".auth-bulk-textarea");
}

test("bulk editor pre-fills 'key: value' lines from the current basic model", () => {
  const { window, auth } = mount({
    id: "b",
    authType: "basic",
    authBasic: { username: "alice", password: "hunter2" },
  });
  const ta = enableBulk(window, auth);
  assert.ok(ta, "bulk textarea rendered");
  assert.equal(ta.value, "username: alice\npassword: hunter2");
});

test("editing the bulk textarea syncs values back into the basic model", async () => {
  const { window, auth } = mount({
    id: "b",
    authType: "basic",
    authBasic: { username: "alice", password: "pw" },
  });
  const ta = enableBulk(window, auth);
  const updated = nextUpdate(window);
  ta.value = "username: bob\npassword: s3cr3t";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));

  const detail = await updated;
  assert.equal(detail.authBasic.username, "bob");
  assert.equal(detail.authBasic.password, "s3cr3t");
  assert.equal(auth.getModel().authBasic.username, "bob");
});

test("bulk editor parses the api-key keys and constrains addTo to header/query", () => {
  const { window, auth } = mount({
    id: "k",
    authType: "apikey",
    authApiKey: { name: "", value: "", addTo: "header" },
  });
  const ta = enableBulk(window, auth);
  // A bogus addTo value must be rejected (stays "header"); name/value sync.
  ta.value = "name: X-Tok\nvalue: abc\naddTo: bogus";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  let m = auth.getModel().authApiKey;
  assert.equal(m.name, "X-Tok");
  assert.equal(m.value, "abc");
  assert.equal(m.addTo, "header", "invalid addTo rejected, default kept");

  // A valid addTo value is accepted.
  ta.value = "name: X-Tok\nvalue: abc\naddTo: query";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(auth.getModel().authApiKey.addTo, "query");
});

test("bulk editor parses all NTLM keys", () => {
  const { window, auth } = mount({ id: "nt", authType: "ntlm" });
  const ta = enableBulk(window, auth);
  ta.value = "username: u\npassword: p\ndomain: CORP\nworkstation: WS01";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  const m = auth.getModel().authNtlm;
  assert.deepEqual(
    { ...m },
    { username: "u", password: "p", domain: "CORP", workstation: "WS01" },
  );
});

test("bulk editor parses AWS-IAM keys and ignores unknown keys", () => {
  const { window, auth } = mount({ id: "a", authType: "aws-iam" });
  const ta = enableBulk(window, auth);
  ta.value =
    "accessKeyId: AKIA\nsecretAccessKey: shh\nregion: us-east-1\nservice: s3\nsessionToken: st\nbogus: nope";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  const m = auth.getModel().authAwsIam;
  assert.equal(m.accessKeyId, "AKIA");
  assert.equal(m.secretAccessKey, "shh");
  assert.equal(m.region, "us-east-1");
  assert.equal(m.service, "s3");
  assert.equal(m.sessionToken, "st");
  assert.equal(m.bogus, undefined, "unknown key not added to the model");
});

test("bulk editor constrains the OAuth1 signatureMethod enum", () => {
  const { window, auth } = mount({
    id: "o1",
    authType: "oauth1",
    authOAuth1: { signatureMethod: "HMAC-SHA1" },
  });
  const ta = enableBulk(window, auth);
  // Invalid method rejected.
  ta.value = "consumerKey: ck\nsignatureMethod: NOPE";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(auth.getModel().authOAuth1.consumerKey, "ck");
  assert.equal(
    auth.getModel().authOAuth1.signatureMethod,
    "HMAC-SHA1",
    "invalid signatureMethod rejected",
  );
  // Valid method accepted.
  ta.value = "consumerKey: ck\nsignatureMethod: PLAINTEXT";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(auth.getModel().authOAuth1.signatureMethod, "PLAINTEXT");
});

test("bulk editor skips lines without a colon and unknown keys", () => {
  const { window, auth } = mount({
    id: "be",
    authType: "bearer",
    authBearer: { token: "orig" },
  });
  const ta = enableBulk(window, auth);
  ta.value = "this line has no colon\nunknown: x\ntoken: new-token";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(auth.getModel().authBearer.token, "new-token");
});

test("bulk editor preserves a single leading space in the value", () => {
  const { window, auth } = mount({
    id: "be",
    authType: "bearer",
    authBearer: { token: "" },
  });
  const ta = enableBulk(window, auth);
  // Exactly one space after the colon is the separator; further spaces are kept.
  ta.value = "token:  two-leading-spaces";
  ta.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  assert.equal(auth.getModel().authBearer.token, " two-leading-spaces");
});

// ── setModel / getModel round-trip ───────────────────────────────────────────

test("setModel populates the model and getModel returns it; switching type is reflected", () => {
  const { auth, window } = mount({
    id: "rt",
    authType: "bearer",
    authEnabled: true,
    authBearer: { token: "abc" },
  });
  let m = auth.getModel();
  assert.equal(m.authType, "bearer");
  assert.equal(m.authBearer.token, "abc");
  assert.equal(m.authEnabled, true);

  // Switching type through the selector is reflected by getModel.
  const sel = auth.element.querySelector("#auth-type-select");
  sel.value = "digest";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(auth.getModel().authType, "digest");
});

test("setModel restores runtime token fields as empty (never persists acquired tokens)", () => {
  const { auth } = mount({
    id: "o2",
    authType: "oauth2",
    authOAuth2: {
      grantType: "client_credentials",
      clientId: "cid",
      token: "should-not-restore",
      refreshToken: "rt",
    },
  });
  const m = auth.getModel();
  assert.equal(m.authOAuth2.clientId, "cid", "persisted field restored");
  assert.equal(m.authOAuth2.token, "", "runtime access token not restored");
  assert.equal(
    m.authOAuth2.refreshToken,
    "",
    "runtime refresh token not restored",
  );
});

test("dispatchAuthUpdated omits runtime token fields from the persisted oauth2 detail", async () => {
  const { window, auth } = mount({
    id: "o2",
    authType: "oauth2",
    authOAuth2: { grantType: "client_credentials" },
  });
  const grant = auth.element.querySelector("select.auth-field-select");
  const updated = nextUpdate(window);
  grant.value = "password";
  grant.dispatchEvent(new window.Event("change", { bubbles: true }));

  const detail = await updated;
  assert.equal(detail.authOAuth2.grantType, "password");
  assert.ok(
    !("token" in detail.authOAuth2),
    "token excluded from persisted detail",
  );
  assert.ok(
    !("refreshToken" in detail.authOAuth2),
    "refreshToken excluded from persisted detail",
  );
  assert.ok(!("expiresAt" in detail.authOAuth2), "expiresAt excluded");
});

// ── gatherTemplates ──────────────────────────────────────────────────────────

test("gatherTemplates returns [] when auth is disabled or None", () => {
  const disabled = mount({
    id: "g",
    authType: "basic",
    authEnabled: false,
    authBasic: { username: "{{u}}", password: "{{p}}" },
  });
  assert.deepEqual(disabled.auth.gatherTemplates(), []);

  const none = mount({ id: "g2", authType: "none" });
  assert.deepEqual(none.auth.gatherTemplates(), []);
});

test("gatherTemplates surfaces the enabled auth fields' template strings", () => {
  const { auth } = mount({
    id: "g",
    authType: "basic",
    authEnabled: true,
    authBasic: { username: "{{user}}", password: "{{pass}}" },
  });
  const templates = auth.gatherTemplates();
  assert.ok(templates.includes("{{user}}"));
  assert.ok(templates.includes("{{pass}}"));
});

// ── No-id guard ──────────────────────────────────────────────────────────────

test("with no current node id, edits do not dispatch a request-updated event", async () => {
  const { window, auth } = mount(
    {
      id: "b",
      authType: "apikey",
      authApiKey: { name: "n", value: "v", addTo: "header" },
    },
    null, // getCurrentNodeId returns null → dispatch is suppressed
  );
  let fired = false;
  window.addEventListener("hippo:request-updated", () => {
    fired = true;
  });
  const addTo = auth.element.querySelector("select.auth-field-select");
  addTo.value = "query";
  addTo.dispatchEvent(new window.Event("change", { bubbles: true }));

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, false, "no event when there is no node id");
  // The model still updates locally even though nothing is dispatched.
  assert.equal(auth.getModel().authApiKey.addTo, "query");
});

/*
 * Deliberately not covered (genuinely untestable under jsdom):
 *   • Get-Token / Refresh — drives oauthExecutor.forceRefresh over IPC/fetch and
 *     opens a real OAuth window; no backend in jsdom.
 *   • Discover (OIDC well-known fetch) + the issuer dialog — depends on the
 *     backend HTTP bridge (window.hippo.http.execute) / dev-server /api/execute.
 *   • Clear-Session — calls window.hippo.oauth.clearSession (Electron only).
 *   • Copy-token clipboard write — needs navigator.clipboard.
 *   • Scope / API-key autocomplete dropdown geometry — relies on real layout
 *     (getBoundingClientRect), which jsdom stubs to zero.
 *   • Driving pill-editor (contenteditable) text via synthetic input — the
 *     sanitize/caret path needs a live selection; the plain inputs/selects and
 *     the bulk textarea cover the field→model wiring instead.
 */
