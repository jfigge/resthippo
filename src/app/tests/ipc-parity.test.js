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
 * tests/ipc-parity.test.js
 *
 * Guards the cardinal IPC rule: every request/response channel registered in
 * main.js with `ipcMain.handle(...)` must have exactly one matching
 * `ipcRenderer.invoke(...)` exposure in a preload script, and vice versa. A
 * rename on one side without the other silently breaks the feature with no
 * runtime signal, so this static check fails the build instead of shipping a
 * dead channel.
 *
 * It also asserts every such channel follows the documented naming convention
 * (see CLAUDE.md → "IPC channel naming"): colon-separated `area:noun:verb`
 * segments, each lowercase and hyphen-delimited. That catches camelCase /
 * underscore regressions (e.g. a reintroduced `htmlPreview:loadUrl`).
 *
 * Scope: the request/response contract (`ipcMain.handle` ↔ `ipcRenderer.invoke`)
 * AND the one-way main→renderer push topology (main's `webContents.send(...)` /
 * the `sendTo(sender, ...)` wrapper ↔ a preload `ipcRenderer.on(...)`). A push
 * channel renamed on only one side silently breaks the feature with no runtime
 * signal, exactly like the invoke/handle case, so both are guarded here. The
 * renderer→main `ipcRenderer.send` / `ipcMain.on` direction is unused.
 *
 * Pure text analysis — no Electron process is started.
 *
 * Run with:   node --test tests/ipc-parity.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(APP_DIR, file), "utf8");

// Collect every channel string passed as the first argument to `fnPattern(...)`,
// e.g. channelsFor(src, "ipcMain\\.handle") → ["store:manifest:get", …].
function channelsFor(source, fnPattern) {
  const re = new RegExp(`${fnPattern}\\(\\s*["']([^"']+)["']`, "g");
  const out = [];
  let match;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
  return out;
}

// The main-process IPC surface is split across main.js and the modules it
// delegates registration to — the HTTP engine (http:execute / http:body:* /
// http:stream:*) registers its handlers from net/http-engine.js, and the
// scripting sandbox (script:run-pre / script:run-post / script:validate) from
// scripting/sandbox.js. Scan them as one source so the parity + push-topology
// checks see the whole surface.
const mainProcessSource =
  read("main.js") +
  "\n" +
  read("net/http-engine.js") +
  "\n" +
  read("scripting/sandbox.js");

const handlers = channelsFor(mainProcessSource, "ipcMain\\.handle");
const invokes = [
  ...channelsFor(read("preload.js"), "ipcRenderer\\.invoke"),
  ...channelsFor(read("preload-theme-editor.js"), "ipcRenderer\\.invoke"),
  ...channelsFor(read("preload-docs.js"), "ipcRenderer\\.invoke"),
];

// Push channels (main → renderer). main pushes two ways: directly via
// `webContents.send("channel", …)` (channel is the first string arg) and via the
// `sendTo(sender, "channel", …)` wrapper (channel is the SECOND arg, used for the
// http:stream:* and ws:* streams). Capture both forms.
function sendChannels(source) {
  const out = [];
  const patterns = [
    /webContents\.send\(\s*["']([^"']+)["']/g, // webContents.send("x", …)
    /sendTo\([^,]+,\s*["']([^"']+)["']/g, // sendTo(sender, "x", …)
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) out.push(match[1]);
  }
  return out;
}

const sends = sendChannels(mainProcessSource);
const listens = [
  ...channelsFor(read("preload.js"), "ipcRenderer\\.on"),
  ...channelsFor(read("preload-theme-editor.js"), "ipcRenderer\\.on"),
  ...channelsFor(read("preload-docs.js"), "ipcRenderer\\.on"),
];

test("no IPC channel is handled more than once across the main process", () => {
  const seen = new Set();
  const dupes = [];
  for (const channel of handlers) {
    if (seen.has(channel)) dupes.push(channel);
    seen.add(channel);
  }
  assert.deepEqual(dupes, [], `duplicate ipcMain.handle channels: ${dupes}`);
});

test("every ipcMain.handle channel is invoked from a preload, and vice versa", () => {
  const handlerSet = new Set(handlers);
  const invokeSet = new Set(invokes);

  const orphanHandlers = [...handlerSet].filter((c) => !invokeSet.has(c));
  const orphanInvokes = [...invokeSet].filter((c) => !handlerSet.has(c));

  assert.deepEqual(
    orphanHandlers,
    [],
    `ipcMain.handle channels with no preload invoke: ${orphanHandlers.join(", ")}`,
  );
  assert.deepEqual(
    orphanInvokes,
    [],
    `preload invoke channels with no handler: ${orphanInvokes.join(", ")}`,
  );
});

test("every main→renderer push channel has a preload listener, and vice versa", () => {
  const sendSet = new Set(sends);
  const listenSet = new Set(listens);

  const orphanSends = [...sendSet].filter((c) => !listenSet.has(c));
  const orphanListens = [...listenSet].filter((c) => !sendSet.has(c));

  assert.deepEqual(
    orphanSends,
    [],
    `main pushes these channels with no preload ipcRenderer.on listener: ${orphanSends.join(", ")}`,
  );
  assert.deepEqual(
    orphanListens,
    [],
    `preload listens on these channels but main never pushes them: ${orphanListens.join(", ")}`,
  );
});

test("every invoke/handle channel follows the area:noun:verb naming convention", () => {
  // Two or more colon-separated segments; each segment lowercase, starting with
  // a letter, with hyphens only between alphanumerics (no camelCase, no _).
  const SEGMENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
  const CONVENTION = new RegExp(`^${SEGMENT}(?::${SEGMENT})+$`);

  const offenders = [
    ...new Set([...handlers, ...invokes, ...sends, ...listens]),
  ].filter((channel) => !CONVENTION.test(channel));
  assert.deepEqual(
    offenders,
    [],
    `channels off-convention (want lowercase, hyphenated, colon-separated area:noun:verb): ${offenders.join(", ")}`,
  );
});
