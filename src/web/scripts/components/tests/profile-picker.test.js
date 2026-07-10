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
 * tests/profile-picker.test.js
 *
 * Unit tests for ProfilePicker — the variable-profile selector that opens a
 * native OS menu (window.hippo.ui.contextMenu.show). Pins the item list it builds
 * (Default + named profiles, checkbox state on the active one, the ⌥⌘0–9 switch
 * accelerators) and that only a real change routes to onActivate.
 *
 * Run with:   node --test components/tests/profile-picker.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals the picker needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ProfilePicker } from "../profile-picker.js";

const P1 = { id: "p1", name: "Staging" };
const P2 = { id: "p2", name: "Prod" };

/** Flush the picker's fire-and-forget async menu handler. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Bind a picker to a fresh button, mock the native menu to capture the item list
 * and return `choose(items)` as the clicked id, then click the trigger.
 * @returns {Promise<{ items: any[], activated: (string|null)[] }>}
 */
async function openAndPick({ profiles, activeProfileId, choose }) {
  const window = resetDom();
  let items = null;
  const activated = [];
  window.hippo = {
    ui: {
      contextMenu: {
        show: async (opts) => {
          items = opts.items;
          return choose ? choose(items) : null;
        },
      },
    },
  };
  const picker = new ProfilePicker({ onActivate: (id) => activated.push(id) });
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  picker.bindTrigger(btn);
  picker.load({ profiles, activeProfileId });
  btn.dispatchEvent(
    new window.MouseEvent("mousedown", { button: 0, bubbles: true }),
  );
  await flush();
  return { items, activated };
}

test("menu lists Default + named profiles, checks the active one, advertises ⌥⌘ shortcuts", async () => {
  const { items } = await openAndPick({
    profiles: [P1, P2],
    activeProfileId: "p2",
  });
  assert.equal(items.length, 3); // Default + 2 named
  // Every row is a checkbox with a slot accelerator (0 = Default, 1..N named).
  items.forEach((it, i) => {
    assert.equal(it.type, "checkbox");
    assert.equal(it.accelerator, `Alt+CmdOrCtrl+${i}`);
  });
  // Only the active profile (P2 → index 2) is checked.
  assert.deepEqual(
    items.map((it) => it.checked),
    [false, false, true],
  );
});

test("choosing a different named profile routes its id to onActivate", async () => {
  const { activated } = await openAndPick({
    profiles: [P1, P2],
    activeProfileId: null, // Default active
    choose: (items) => items[1].id, // first named (Staging)
  });
  assert.deepEqual(activated, ["p1"]);
});

test("choosing Default from a named profile routes null to onActivate", async () => {
  const { activated } = await openAndPick({
    profiles: [P1, P2],
    activeProfileId: "p1",
    choose: (items) => items[0].id, // Default row
  });
  assert.deepEqual(activated, [null]);
});

test("re-selecting the already-active profile is a no-op", async () => {
  const { activated } = await openAndPick({
    profiles: [P1, P2],
    activeProfileId: "p2",
    choose: (items) => items[2].id, // Prod — already active
  });
  assert.deepEqual(activated, []);
});

test("dismissing the menu does not activate anything", async () => {
  const { activated } = await openAndPick({
    profiles: [P1, P2],
    activeProfileId: "p1",
    choose: () => null, // dismissed
  });
  assert.deepEqual(activated, []);
});

test("no native menu host (non-Electron) is a safe no-op", async () => {
  const window = resetDom();
  window.hippo = { isElectron: false }; // no ui.contextMenu
  const activated = [];
  const picker = new ProfilePicker({ onActivate: (id) => activated.push(id) });
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  picker.bindTrigger(btn);
  picker.load({ profiles: [P1], activeProfileId: null });
  btn.dispatchEvent(
    new window.MouseEvent("mousedown", { button: 0, bubbles: true }),
  );
  await flush();
  assert.deepEqual(activated, []);
});
