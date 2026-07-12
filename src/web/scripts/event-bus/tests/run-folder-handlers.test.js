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
