/**
 * auth/utils/params.js
 *
 * Shared assembly helpers for OAuth request parameters.
 */

"use strict";

/**
 * Merge user-supplied extra parameters into a token/authorization param object.
 *
 * Mirrors the guard every flow applied by hand: the source must be a non-null
 * object, and only entries with a truthy key and a non-null/non-empty value are
 * copied (each value is coerced to a string). Mutates and returns `target`.
 *
 * @param {Record<string,string>} target - param object being assembled (mutated)
 * @param {unknown} src - candidate extra params (e.g. config.extraParams)
 * @returns {Record<string,string>} the same `target`, for chaining
 */
export function mergeExtraParams(target, src) {
  if (!src || typeof src !== "object") return target;
  for (const [k, v] of Object.entries(src)) {
    if (k && v != null && v !== "") target[k] = String(v);
  }
  return target;
}
