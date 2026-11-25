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
 * components/command/command-exec.js — turn a Command request (Feature 70) into
 * an execution descriptor and run it through the `window.hippo.command` bridge.
 *
 * Shared by every path that runs a command — the interactive Execute button
 * (event-bus/command-handlers.js), the `{{response()}}`/`hippo.run` dependency
 * prefetch and folder runs (app.js) — so they resolve, approve and execute
 * identically.
 *
 * Resolution is per token AFTER parsing (command-line.js): a variable value with
 * spaces or quotes is always exactly one argument, never several.
 *
 * Approval: before a command template runs for the first time (or after it
 * changes) the user must confirm it. The main process keeps the approvals and
 * re-checks on execute; this module asks the user via the injected `confirm`.
 */

"use strict";

import { tokenize } from "./command-line.js";
import { resolveStringAsync } from "../variable-resolver.js";

/** Stdout parse/display types offered in the editor (value → i18n key suffix). */
export const OUTPUT_TYPES = ["auto", "json", "yaml", "xml", "text"];

/** The renderer's platform (drives backslash handling in the parser). */
export function rendererPlatform() {
  return globalThis.window?.hippo?.platform ?? "";
}

/** The UNRESOLVED template the user approves (hashed in main). */
export function commandTemplate(node) {
  return {
    commandLine: String(node?.commandLine ?? ""),
    commandEnv: Array.isArray(node?.commandEnv) ? node.commandEnv : [],
    commandStdin: String(node?.commandStdin ?? ""),
  };
}

/** Every template string of a command request (for the variable pre-flight). */
export function commandTemplates(node) {
  const tpl = commandTemplate(node);
  return [
    tpl.commandLine,
    tpl.commandStdin,
    ...tpl.commandEnv
      .filter((r) => r && r.enabled !== false)
      .map((r) => String(r.value ?? "")),
  ];
}

/**
 * Resolve a command request into the descriptor the main process executes.
 * @param {object} node   the request (commandLine, commandEnv, …)
 * @param {object} ctx    variable-resolution context
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @returns {Promise<{ requestId: string|null, executable: string, args: string[],
 *   env: {key:string,value:string,enabled:boolean}[], stdin: string,
 *   timeoutMs: number, outputType: string, template: object,
 *   commandLine: string }>}
 */
export async function buildCommandDescriptor(node, ctx, opts = {}) {
  const platform = opts.platform ?? rendererPlatform();
  const rv = (s) => resolveStringAsync(s, ctx);
  const template = commandTemplate(node);
  const tokens = tokenize(template.commandLine, platform);
  const resolved = [];
  for (const tok of tokens) resolved.push(await rv(tok.value));
  const env = [];
  for (const r of template.commandEnv) {
    if (!r || r.enabled === false) continue;
    // Editor rows carry `name` (like params/headers); settings rows `key`.
    const key = String(r.name ?? r.key ?? "").trim();
    if (!key) continue;
    env.push({ key, value: await rv(String(r.value ?? "")), enabled: true });
  }
  return {
    requestId: node?.id ?? null,
    name: String(node?.name ?? ""),
    executable: resolved[0] ?? "",
    args: resolved.slice(1),
    env,
    stdin: template.commandStdin ? await rv(template.commandStdin) : "",
    timeoutMs: Math.max(0, Number(node?.commandTimeoutMs) || 0),
    outputType: OUTPUT_TYPES.includes(node?.commandOutputType)
      ? node.commandOutputType
      : "auto",
    template,
    commandLine: template.commandLine,
  };
}

/**
 * A snapshot of the run in the `{ method, url, headers, body }` request shape the
 * response viewer, Timeline and error panes use. The "url" is the UNRESOLVED
 * command line (resolved argument values may be secrets).
 */
export function commandRequestSnapshot(desc) {
  return {
    method: "CMD",
    url: desc?.commandLine ?? "",
    headers: {},
    body: desc?.template?.commandStdin || null,
  };
}

/**
 * Make sure the user approved this command template, asking when needed.
 * @param {object} desc  from buildCommandDescriptor
 * @param {object} deps
 * @param {object} deps.bridge   window.hippo.command
 * @param {(desc: object) => Promise<boolean>} deps.confirm  ask the user
 * @returns {Promise<boolean>} true when approved (now or before)
 */
export async function ensureApproved(desc, { bridge, confirm }) {
  const args = { requestId: desc.requestId, template: desc.template };
  let approved = false;
  try {
    approved = (await bridge.approval.check(args))?.approved === true;
  } catch {
    approved = false;
  }
  if (approved) return true;
  if (!(await confirm(desc))) return false;
  try {
    return (await bridge.approval.grant(args))?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Approve + execute. Resolves to the main-process result (HTTP-shaped), or a
 * status-0 error result when the user declines or the bridge is unavailable.
 * @param {object} desc
 * @param {object} deps
 * @param {object} [deps.bridge]   defaults to window.hippo.command
 * @param {(desc: object) => Promise<boolean>} deps.confirm
 * @param {string} [deps.id]       execution id (cancel handle)
 */
export async function runCommand(desc, { bridge, confirm, id } = {}) {
  const b = bridge ?? globalThis.window?.hippo?.command;
  const err = (name, message) => ({
    status: 0,
    kind: "command",
    body: "",
    headers: {},
    consoleLog: [`* ${name}: ${message}`],
    error: { name, message },
  });
  if (!b || typeof b.execute !== "function") {
    return err("Unavailable", "Command requests need the desktop app.");
  }
  if (!desc.executable) return err("CommandError", "No command given.");
  if (!(await ensureApproved(desc, { bridge: b, confirm }))) {
    return err("CommandNotApproved", "The command was not approved to run.");
  }
  return b.execute({
    id: id ?? globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    requestId: desc.requestId,
    executable: desc.executable,
    args: desc.args,
    env: desc.env,
    stdin: desc.stdin,
    timeoutMs: desc.timeoutMs,
    outputType: desc.outputType,
    template: desc.template,
  });
}
