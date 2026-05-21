"use strict";

/**
 * @param {string} fn
 * @param {Record<string, string>} args
 * @returns {Promise<string>}
 */
export async function invokeBackend(fn, args) {
  if (window.wurl?.isElectron === true) {
    const result = await window.wurl.functions?.invoke(fn, args);
    if (result.error) throw new Error(result.error);
    return result.result ?? "";
  }

  const response = await fetch("/api/functions/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.result ?? "";
}
