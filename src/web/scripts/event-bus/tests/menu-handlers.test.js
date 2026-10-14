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
 * menu-handlers.test.js — the import/export menu event-bus handlers. Most of
 * these open a modal singleton (covered by those components' own tests); the
 * directly-testable seam is hippo:export-collection, which forwards the chosen
 * collection straight to the host's export handler. Installing the handlers must
 * also not throw.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installMenuHandlers } from "../menu-handlers.js";

function setup() {
  resetDom();
  const calls = { export: [] };
  assert.doesNotThrow(() =>
    installMenuHandlers({
      handleExport: (c) => calls.export.push(c),
    }),
  );
  const fire = (type, detail) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));
  return { calls, fire };
}

test("hippo:export-collection forwards the chosen collection to handleExport", () => {
  const { calls, fire } = setup();
  const collection = { id: "c1", name: "Alpha" };
  fire("hippo:export-collection", { collection });
  assert.deepEqual(calls.export, [collection]);
});

test("installMenuHandlers wires listeners without throwing", () => {
  // setup() asserts the install itself; a second, listener-free dispatch must be
  // harmless (no matching handler → no-op).
  const { calls, fire } = setup();
  fire("hippo:export-collection", { collection: { id: "c2" } });
  assert.equal(calls.export.length, 1);
});
