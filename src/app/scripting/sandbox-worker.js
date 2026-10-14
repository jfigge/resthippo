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
 * scripting/sandbox-worker.js — worker_threads entry for the script sandbox.
 *
 * Runs the same synchronous `runScript()` as the in-process path, but off the
 * main thread. A script that detaches an async loop (which the in-vm wall-clock
 * timeout cannot interrupt) therefore wedges only THIS worker; the parent
 * terminates the worker after each run, so the runaway work dies with it instead
 * of pinning the main process. See `runScriptIsolated` in sandbox.js.
 */
"use strict";

const { parentPort } = require("worker_threads");
const { runScript } = require("./sandbox.js");

// One job per message. Always post a plain-data result back (runScript already
// fails closed internally; the catch is a last-resort guard).
parentPort.on("message", (msg) => {
  const payload = (msg && msg.payload) || {};
  let result;
  try {
    result = runScript(payload);
  } catch (err) {
    result = {
      request: payload.phase === "pre" ? null : undefined,
      varWrites: [],
      logs: [],
      tests: [],
      error: {
        name: (err && err.name) || "Error",
        message: (err && err.message) || String(err),
      },
    };
  }
  parentPort.postMessage({ jobId: msg && msg.jobId, result });
});
