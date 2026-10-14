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

"use strict";

/**
 * env-access.js — allow-list gate for renderer-reachable OS environment vars.
 *
 * The `{{environmentVariable(name)}}` template function reaches the main process
 * through the `env` op of the `functions:invoke` IPC handler, which reads
 * `process.env`. Without a gate, *every* host variable — AWS_SECRET_ACCESS_KEY,
 * session tokens, anything the launching shell exported — would be readable by
 * *any* loaded collection. A maliciously-crafted imported collection could then
 * smuggle one into a request URL or header (`{{environmentVariable("AWS…")}}`)
 * and exfiltrate it to an attacker-controlled server on the next send, with no
 * user action beyond opening the collection.
 *
 * To keep the feature useful without that risk we follow the Vite / CRA
 * convention: only variables whose name carries an explicit opt-in prefix are
 * exposed; every other name reads as empty. The prefix is NOT stripped — a
 * request references the full name, e.g.
 * `{{environmentVariable("RESTHIPPO_API_KEY")}}`.
 */

/** Only env vars whose name starts with this prefix are renderer-readable. */
const ENV_ALLOW_PREFIX = "RESTHIPPO_";

/**
 * @param {unknown} name
 * @returns {boolean} true when `name` is a string opted into renderer exposure.
 */
function isAllowedEnvName(name) {
  return typeof name === "string" && name.startsWith(ENV_ALLOW_PREFIX);
}

/**
 * Read an opt-in environment variable. Returns "" when the name is disallowed,
 * not a string, or unset. Always returns a string (never undefined) so the
 * template resolver substitutes cleanly.
 *
 * @param {unknown} name
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
function readEnv(name, env = process.env) {
  if (!isAllowedEnvName(name)) return "";
  const val = env[name];
  return val !== undefined ? String(val) : "";
}

module.exports = { ENV_ALLOW_PREFIX, isAllowedEnvName, readEnv };
