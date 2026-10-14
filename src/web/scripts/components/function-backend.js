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
 * Extract a human message from a function-backend error field. The Electron IPC
 * path returns the structured `{ name, message }` error the rest of the HTTP
 * path uses; the Go dev server still returns a bare string. Handle both.
 *
 * @param {string|{message?: string}} error
 * @returns {string}
 */
function errorMessage(error) {
  if (typeof error === "string") return error;
  return error?.message ?? "Function call failed";
}

// Cap on a single dev-server function call so a hung backend can't stall the
// whole template resolution (and thus the request send) indefinitely.
const BACKEND_FETCH_TIMEOUT_MS = 15000;

/**
 * @param {string} fn
 * @param {Record<string, string>} args
 * @returns {Promise<string>}
 */
export async function invokeBackend(fn, args) {
  if (window.hippo?.isElectron === true) {
    const result = await window.hippo.functions?.invoke(fn, args);
    if (!result) throw new Error("IPC unavailable");
    if (result.error) throw new Error(errorMessage(result.error));
    return result.result ?? "";
  }

  // Dev-server path: bound the request with an abortable timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("/api/functions/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fn, args }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        `Function "${fn}" timed out after ${BACKEND_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(errorMessage(result.error));
  return result.result ?? "";
}
