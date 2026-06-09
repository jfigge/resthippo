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
 * Scope: the invoke/handle (request → response) contract only. One-way push
 * channels (`ipcMain.on` / `webContents.send` / `ipcRenderer.on` /
 * `ipcRenderer.send`) are a separate topology with a different sender/receiver
 * shape and are intentionally not checked here.
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

const handlers = channelsFor(read("main.js"), "ipcMain\\.handle");
const invokes = [
  ...channelsFor(read("preload.js"), "ipcRenderer\\.invoke"),
  ...channelsFor(read("preload-theme-editor.js"), "ipcRenderer\\.invoke"),
];

test("no IPC channel is handled more than once in main.js", () => {
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

test("every invoke/handle channel follows the area:noun:verb naming convention", () => {
  // Two or more colon-separated segments; each segment lowercase, starting with
  // a letter, with hyphens only between alphanumerics (no camelCase, no _).
  const SEGMENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
  const CONVENTION = new RegExp(`^${SEGMENT}(?::${SEGMENT})+$`);

  const offenders = [...new Set([...handlers, ...invokes])].filter(
    (channel) => !CONVENTION.test(channel),
  );
  assert.deepEqual(
    offenders,
    [],
    `channels off-convention (want lowercase, hyphenated, colon-separated area:noun:verb): ${offenders.join(", ")}`,
  );
});
