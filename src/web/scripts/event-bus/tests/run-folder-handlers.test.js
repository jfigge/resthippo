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
 * run-folder-handlers.test.js — the single hippo:run-folder bus listener that
 * forwards a folder id to ctx.runFolder().
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installRunFolderHandler } from "../run-folder-handlers.js";

function setup() {
  resetDom();
  const seen = [];
  installRunFolderHandler({ runFolder: (id) => seen.push(id) });
  const fire = (detail) =>
    window.dispatchEvent(new CustomEvent("hippo:run-folder", { detail }));
  return { seen, fire };
}

test("hippo:run-folder forwards the folder id to ctx.runFolder", () => {
  const { seen, fire } = setup();
  fire({ folderId: "f-42" });
  assert.deepEqual(seen, ["f-42"]);
});

test("hippo:run-folder tolerates a missing detail (passes undefined)", () => {
  const { seen, fire } = setup();
  fire(undefined);
  assert.deepEqual(seen, [undefined]);
});
