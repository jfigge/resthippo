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
 * settings-popup.test.js — the SettingsPopup (previously the largest wholly
 * untested renderer surface: ~1.8k lines behind a 501-line #build). Exercised
 * through its public seam under jsdom: load() builds + applies a settings object
 * to the form controls, and a control `change` synchronously re-collects the
 * values and dispatches "hippo:settings-changed". These cover the load-bearing
 * apply / read round-trip, the inverted removeHeaders mapping, the layout
 * picker, numeric-field defaulting, and the unchanged-emit dedup — without
 * opening it through PopupManager (open() also pulls in async window.hippo
 * loads + Escape wiring).
 */
"use strict";

import "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { SettingsPopup } from "../components/settings-popup.js";

/** Fresh DOM + a built popup (load builds via #ensureBuilt, no PopupManager). */
function makePopup() {
  resetDom();
  // The build/apply path only touches window.hippo through optional chaining
  // (updater/app/cli/secretStorage are called on open()/interaction). A minimal
  // stub keeps any incidental touch from throwing.
  window.hippo = { isStoreBuild: false };
  const popup = new SettingsPopup();
  popup.load({}); // build with defaults
  return { popup, el: popup.element };
}

const q = (el, sel) => el.querySelector(sel);
/** Valid option values of a <select>, excluding the empty/placeholder. */
const optionValues = (sel) =>
  [...sel.querySelectorAll("option")].map((o) => o.value).filter(Boolean);
/** A valid option value different from the select's current one. */
const otherOption = (sel) =>
  optionValues(sel).find((v) => v !== sel.value) ?? sel.value;

test("builds the dialog shell and the key controls across panels", () => {
  const { el } = makePopup();
  assert.equal(el.getAttribute("role"), "dialog");
  assert.equal(el.getAttribute("aria-modal"), "true");
  for (const id of [
    "#setting-language",
    "#setting-theme",
    "#setting-font-size",
    "#setting-font-family",
    "#setting-remove-headers",
    "#setting-verify-ssl",
    "#setting-timeout",
    "#setting-proxy-url",
    "#setting-proxy-password",
    "#setting-picker-debounce",
    ".settings-layout-picker",
  ]) {
    assert.ok(q(el, id), `missing control ${id}`);
  }
});

test("load() applies a settings object to the controls", () => {
  const { popup, el } = makePopup();
  const locale = otherOption(q(el, "#setting-language"));
  const theme = otherOption(q(el, "#setting-theme"));
  const fontSize = otherOption(q(el, "#setting-font-size"));

  popup.load({
    locale,
    theme,
    fontSize: Number(fontSize),
    removeHeaders: true, // inverted → the "show headers" checkbox is UNchecked
    methodIcons: false,
    verifySsl: false,
    proxyEnabled: true,
    proxyUrl: "http://proxy.local:8080",
    layout: 3,
  });

  assert.equal(q(el, "#setting-language").value, locale);
  assert.equal(q(el, "#setting-theme").value, theme);
  assert.equal(q(el, "#setting-font-size").value, fontSize);
  // Inverted display mapping.
  assert.equal(q(el, "#setting-remove-headers").checked, false);
  assert.equal(q(el, "#setting-verify-ssl").checked, false);
  assert.equal(q(el, "#setting-proxy-enabled").checked, true);
  assert.equal(q(el, "#setting-proxy-url").value, "http://proxy.local:8080");
  // Layout picker reflects the chosen layout.
  const selected = q(el, ".settings-layout-option--selected");
  assert.ok(selected);
  assert.equal(selected.dataset.layout, "3");
});

test("a control change re-collects values and dispatches hippo:settings-changed", () => {
  const { popup, el } = makePopup();
  popup.load({ verifySsl: true, removeHeaders: false, proxyUrl: "http://p:1" });

  let detail = null;
  window.addEventListener(
    "hippo:settings-changed",
    (e) => (detail = e.detail),
    { once: true },
  );

  // Flip a checkbox (synchronous #emitChange on 'change').
  const verify = q(el, "#setting-verify-ssl");
  verify.checked = false;
  verify.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert.ok(detail, "settings-changed should fire on a checkbox change");
  assert.equal(detail.verifySsl, false); // reflects the flip
  // removeHeaders is stored inverted from the "show headers" checkbox.
  assert.equal(detail.removeHeaders, false);
  assert.equal(detail.proxyUrl, "http://p:1");
  // historyCount is deferred (committed only on Close), never in a plain emit.
  assert.ok(!("historyCount" in detail));
});

test("an unchanged re-emit is deduplicated", () => {
  const { popup, el } = makePopup();
  popup.load({});

  let count = 0;
  window.addEventListener("hippo:settings-changed", () => count++);

  const cb = q(el, "#setting-method-icons");
  // Two identical emits (no DOM change between them) → only the first dispatches.
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(count, 1);
});

test("a blank numeric field reads back its default (finite 0 preserved)", () => {
  const { popup, el } = makePopup();
  popup.load({});

  let detail = null;
  window.addEventListener(
    "hippo:settings-changed",
    (e) => (detail = e.detail),
    { once: true },
  );

  q(el, "#setting-timeout").value = ""; // blank → default 0
  q(el, "#setting-picker-debounce").value = "0"; // finite 0 kept, not defaulted
  q(el, "#setting-verify-ssl").dispatchEvent(
    new window.Event("change", { bubbles: true }),
  );

  assert.equal(detail.timeout, 0);
  assert.equal(detail.pickerDebounceMs, 0);
});
