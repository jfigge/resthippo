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

  const response = await fetch("/api/functions/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(errorMessage(result.error));
  return result.result ?? "";
}
