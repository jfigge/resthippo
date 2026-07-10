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
 * tests/vars-editor.test.js
 *
 * Unit tests for VarsEditor — the in-panel variable editor shown when a
 * container (collection / folder) is selected in the tree. Pins its observable
 * behaviour: which { scopeId, variables } payload reaches onSave from each mode,
 * the immediate-vs-debounced save timing, the flush-on-scope-switch, and the
 * bulk-editor toggle callback.
 *
 * Run with:   node --test components/tests/vars-editor.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals the editor needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { VarsEditor } from "../vars-editor.js";
import { t } from "../../i18n.js";

function makeEditor() {
  const window = resetDom();
  const saves = [];
  const bulkChanges = [];
  const renames = [];
  const ed = new VarsEditor({
    onSave: (p) => saves.push(p),
    onBulkEditorChange: (p) => bulkChanges.push(p),
    onProfileRename: (p) => renames.push(p),
  });
  document.body.appendChild(ed.element);
  const fire = (el, type) =>
    el.dispatchEvent(new window.Event(type, { bubbles: true }));
  const key = (el, k) =>
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
  return { ed, saves, bulkChanges, renames, fire, key };
}

test("bulk-mode edit + flush dispatches the parsed variables for the scope", () => {
  const { ed, saves, fire } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [],
    bulkEditor: true,
  });

  const ta = ed.element.querySelector(".vars-textarea");
  ta.value = "base=https://x\n$ key=s3cr3t";
  fire(ta, "input"); // schedules a debounced save
  ed.flush(); // force it now

  assert.equal(saves.at(-1).scopeId, "f1");
  assert.deepEqual(saves.at(-1).variables, [
    { name: "base", value: "https://x", secure: false },
    { name: "key", value: "s3cr3t", secure: true },
  ]);
});

test("KV-mode row edit dispatches the row variables for the scope (debounced; flush forces it)", () => {
  const { ed, saves, fire } = makeEditor();
  ed.load({
    scopeId: "c1",
    scopeName: "API",
    variables: [{ name: "a", value: "1", secure: false }],
    bulkEditor: false,
  });

  const valIn = ed.element.querySelector(".vars-kv-row .params-value");
  valIn.value = "2";
  fire(valIn, "input"); // schedules a debounced save
  ed.flush(); // force it now

  assert.equal(saves.at(-1).scopeId, "c1");
  assert.deepEqual(saves.at(-1).variables, [
    { name: "a", value: "2", secure: false },
  ]);
});

test("loading a new scope flushes a pending save for the previous scope", () => {
  const { ed, saves, fire } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [],
    bulkEditor: true,
  });

  const ta = ed.element.querySelector(".vars-textarea");
  ta.value = "x=1";
  fire(ta, "input"); // pending (debounced) save for f1

  ed.load({
    scopeId: "f2",
    scopeName: "Other",
    variables: [],
    bulkEditor: true,
  });

  assert.equal(
    saves.length,
    1,
    "the pending f1 save was flushed by the switch",
  );
  assert.equal(saves[0].scopeId, "f1");
  assert.deepEqual(saves[0].variables, [
    { name: "x", value: "1", secure: false },
  ]);
});

test("toggling the bulk editor off reports the change and re-saves as rows", () => {
  const { ed, saves, bulkChanges, fire } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [{ name: "a", value: "1", secure: false }],
    bulkEditor: true,
  });

  const toggle = ed.element.querySelector(".vars-bulk-toggle");
  toggle.checked = false;
  fire(toggle, "change");

  assert.deepEqual(bulkChanges.at(-1), { bulkEditor: false });
  assert.deepEqual(saves.at(-1).variables, [
    { name: "a", value: "1", secure: false },
  ]);
});

test("flush is a no-op when there is no pending save", () => {
  const { ed, saves } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [],
    bulkEditor: true,
  });
  ed.flush();
  assert.equal(saves.length, 0);
});

// ── Folder profiles: rename + structure lock ─────────────────────────────────

const PROFILES = [{ id: "p1", name: "Prod" }];

function loadFolder(ed, { activeProfileId = null, bulkEditor = true } = {}) {
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [{ name: "host", value: "", secure: false }],
    bulkEditor,
    profilesEnabled: true,
    profiles: PROFILES,
    activeProfileId,
  });
}

test("rename popup pre-fills the active profile name and commits via onProfileRename", () => {
  const { ed, renames, key } = makeEditor();
  loadFolder(ed, { activeProfileId: "p1" });

  const renameBtn = ed.element.querySelector(".vars-profile-rename-btn");
  assert.equal(renameBtn.disabled, false); // enabled for a named profile
  renameBtn.click();

  const input = document.querySelector(".vars-profile-name-input");
  assert.ok(input, "rename popup opened");
  assert.equal(input.value, "Prod"); // defaulted to the current name

  input.value = "Production";
  key(input, "Enter");
  assert.deepEqual(renames.at(-1), { profileId: "p1", name: "Production" });
  // popup closed after commit
  assert.equal(document.querySelector(".vars-profile-name-input"), null);
});

test("Escape cancels a rename without firing onProfileRename", () => {
  const { ed, renames, key } = makeEditor();
  loadFolder(ed, { activeProfileId: "p1" });

  ed.element.querySelector(".vars-profile-rename-btn").click();
  const input = document.querySelector(".vars-profile-name-input");
  input.value = "Nope";
  key(input, "Escape");

  assert.equal(renames.length, 0);
  assert.equal(document.querySelector(".vars-profile-name-input"), null);
});

test("the Default profile cannot be renamed (button disabled, click is a no-op)", () => {
  const { ed, renames } = makeEditor();
  loadFolder(ed, { activeProfileId: null }); // Default active

  const renameBtn = ed.element.querySelector(".vars-profile-rename-btn");
  assert.equal(renameBtn.disabled, true);
  renameBtn.click();
  assert.equal(document.querySelector(".vars-profile-name-input"), null);
  assert.equal(renames.length, 0);
});

test("a named profile locks the KV structure: name read-only, add hidden, secure disabled, delete → reset-to-inherit", () => {
  const { ed } = makeEditor();
  loadFolder(ed, { activeProfileId: "p1", bulkEditor: false });

  const nameIn = ed.element.querySelector(".vars-kv-row .params-name");
  assert.equal(nameIn.readOnly, true);
  assert.equal(
    ed.element
      .querySelector(".vars-kv-row")
      .classList.contains("vars-kv-row--locked"),
    true,
  );
  // Secure button is shown but disabled on a non-Default profile.
  assert.equal(
    ed.element.querySelector(".vars-kv-row .params-secure-btn").disabled,
    true,
  );
  // The delete slot becomes the reset-to-inherit control (no plain delete).
  assert.equal(
    ed.element.querySelector(".vars-kv-row .params-delete-btn"),
    null,
  );
  assert.ok(ed.element.querySelector(".vars-kv-row .params-inherit-btn"));
  // Add-variable button is hidden outside the Default profile.
  assert.equal(ed.element.querySelector(".vars-add-btn").style.display, "none");
});

test("the Default profile keeps the KV structure editable (name editable, add shown)", () => {
  const { ed } = makeEditor();
  loadFolder(ed, { activeProfileId: null, bulkEditor: false });

  const nameIn = ed.element.querySelector(".vars-kv-row .params-name");
  assert.equal(nameIn.readOnly, false);
  assert.equal(ed.element.querySelector(".vars-add-btn").style.display, "");
});

// Load a named profile whose one variable ("host") starts as an explicit override.
function loadOverridden(ed) {
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [
      { name: "host", value: "prod", secure: false, overridden: true },
    ],
    bulkEditor: false,
    profilesEnabled: true,
    profiles: PROFILES,
    activeProfileId: "p1",
  });
}

test("an inheriting named-profile value shows the 'inherits default' placeholder + a disabled reset", () => {
  const { ed } = makeEditor();
  loadFolder(ed, { activeProfileId: "p1", bulkEditor: false });
  const valIn = ed.element.querySelector(".vars-kv-row .params-value");
  const reset = ed.element.querySelector(".vars-kv-row .params-inherit-btn");
  assert.equal(valIn.placeholder, t("profiles.inheritsDefault"));
  assert.ok(reset, "named profile row has a reset-to-inherit control");
  assert.equal(reset.disabled, true, "nothing to reset while inheriting");
});

test("the Default profile keeps the generic value placeholder + a real delete (no inherit control)", () => {
  const { ed } = makeEditor();
  loadFolder(ed, { activeProfileId: null, bulkEditor: false });
  assert.equal(
    ed.element.querySelector(".vars-kv-row .params-value").placeholder,
    t("kv.value"),
  );
  assert.equal(
    ed.element.querySelector(".vars-kv-row .params-inherit-btn"),
    null,
  );
  assert.ok(ed.element.querySelector(".vars-kv-row .params-delete-btn"));
});

test("typing a value turns an inheriting row into an explicit override (reset enabled)", () => {
  const { ed, fire } = makeEditor();
  loadFolder(ed, { activeProfileId: "p1", bulkEditor: false });
  const valIn = ed.element.querySelector(".vars-kv-row .params-value");
  const reset = ed.element.querySelector(".vars-kv-row .params-inherit-btn");
  valIn.value = "prod.example.com";
  fire(valIn, "input");
  assert.equal(reset.disabled, false, "now an override");
  assert.notEqual(valIn.placeholder, t("profiles.inheritsDefault"));
});

test("a named-profile save names the explicit overrides so an empty override survives", () => {
  const { ed, saves, fire } = makeEditor();
  loadFolder(ed, { activeProfileId: "p1", bulkEditor: false });
  const valIn = ed.element.querySelector(".vars-kv-row .params-value");
  valIn.value = "x";
  fire(valIn, "input");
  ed.flush();
  const last = saves.at(-1);
  assert.equal(last.profileId, "p1");
  assert.deepEqual(last.overrides, ["host"]);
});

test("reset-to-inherit drops the override, restores the hint, and saves no overrides", () => {
  const { ed, saves } = makeEditor();
  loadOverridden(ed);
  const reset = ed.element.querySelector(".vars-kv-row .params-inherit-btn");
  assert.equal(reset.disabled, false);
  reset.click();
  const valIn = ed.element.querySelector(".vars-kv-row .params-value");
  assert.equal(valIn.value, "");
  assert.equal(valIn.placeholder, t("profiles.inheritsDefault"));
  assert.equal(reset.disabled, true);
  assert.deepEqual(saves.at(-1).overrides, []); // host is back to inheriting
});
