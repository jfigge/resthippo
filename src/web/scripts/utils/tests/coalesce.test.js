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
