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
