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
 * coalesce.test.js — the async coalescing primitive extracted from app.js's
 * tree-save loop. The load-bearing property: overlapping triggers collapse to a
 * single in-flight run plus exactly one final re-run reflecting the latest
 * state — never one run per trigger, never a dropped last change.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { coalesce } from "../coalesce.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("a single trigger runs the task once", async () => {
  let runs = 0;
  const trigger = coalesce(async () => {
    runs++;
  });
  trigger();
  await tick();
  assert.equal(runs, 1);
  assert.equal(trigger.pending(), false);
});

test("overlapping triggers collapse to one in-flight run plus one re-run", async () => {
  let runs = 0;
  let gate = deferred();
  const trigger = coalesce(async () => {
    runs++;
    await gate.promise;
  });

  trigger(); // starts run 1 (awaits the gate)
  trigger();
  trigger();
  trigger(); // 3 more while run 1 is in flight → only set dirty
  assert.equal(runs, 1, "still just the first run while it is in flight");
  assert.equal(trigger.pending(), true);

  // Release run 1; the loop sees dirty and runs exactly once more.
  const g1 = gate;
  gate = deferred();
  g1.resolve();
  await tick();
  assert.equal(runs, 2, "one coalesced re-run, not one per trigger");

  // Release run 2; no triggers arrived during it → the loop exits.
  gate.resolve();
  await tick();
  assert.equal(runs, 2);
  assert.equal(trigger.pending(), false);
});

test("the final run reflects the LATEST state (task reads state at run time)", async () => {
  let state = 0;
  const seen = [];
  let gate = deferred();
  const trigger = coalesce(async () => {
    const snapshot = state; // read the current state at run time
    await gate.promise;
    seen.push(snapshot);
  });

  state = 1;
  trigger(); // run 1 snapshots 1
  state = 2;
  trigger();
  state = 3;
  trigger(); // dirty; state is now 3

  const g1 = gate;
  gate = deferred();
  g1.resolve(); // run 1 → seen [1]; re-run snapshots the LATEST state (3)
  await tick();

  gate.resolve(); // run 2 → seen [1, 3]
  await tick();

  assert.deepEqual(seen, [1, 3], "coalesced run sees 3, never the stale 2");
});

test("onError is invoked and the trigger recovers (not stuck in-flight)", async () => {
  const errors = [];
  const trigger = coalesce(
    async () => {
      throw new Error("boom");
    },
    (e) => errors.push(e),
  );
  trigger();
  await tick();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "boom");
  assert.equal(trigger.pending(), false);
  // A later trigger still runs (the failure cleared the in-flight flag).
  let ran = false;
  const ok = coalesce(async () => {
    ran = true;
  });
  ok();
  await tick();
  assert.equal(ran, true);
});
