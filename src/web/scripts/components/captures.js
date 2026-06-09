"use strict";

import { extractJsonPath } from "./json-path.js";

/**
 * captures.js — Post-response capture evaluation (Feature 03).
 *
 * `applyCaptures` is a PURE function: given a response and a request's capture
 * rules, it returns the variable writes to perform plus any rules that resolved
 * to nothing. It performs:
 *   - NO status gating — the caller decides when to run it (the interactive path
 *     and the future collection runner both gate on a 2xx response).
 *   - NO persistence — the caller routes each write to the appropriate variable
 *     scope store. Keeping this pure makes it trivially unit-testable.
 *
 * Capture rule shape:
 *   { id, enabled, source, path, target: { scope, name }, secure }
 *     source       ∈ "body" (jq dot-path) | "header" (name) | "status"
 *     target.scope ∈ "environment" | "collection" | "global"
 *     secure       — mark the written variable secret (encrypted at rest)
 *
 * Secret-safe: the returned `warnings` carry only names/scopes, never values, so
 * callers can surface them without leaking a `secure` capture's contents.
 */

/** Body dot-path / header name that yields no value is reported, not written. */

/**
 * @param {{ status:number, headers:object, body:string }} response
 *   `headers` is the lowercase-keyed response header map (as cached by app.js).
 * @param {Array} rules  The request's capture rules.
 * @returns {{
 *   writes:   { scope:string, name:string, value:string, secure:boolean }[],
 *   warnings: { name:string, scope:string }[],
 * }}
 */
export function applyCaptures(response, rules) {
  const writes = [];
  const warnings = [];
  if (!Array.isArray(rules)) return { writes, warnings };

  const status = response?.status ?? 0;
  const headers = response?.headers ?? {};
  const body = typeof response?.body === "string" ? response.body : "";

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;

    const name = String(rule.target?.name ?? "").trim();
    if (!name) continue; // no destination — nothing to write
    const scope = rule.target?.scope ?? "environment";

    const value = _extract(rule, { status, headers, body });

    // An absent / empty / unsupported-path result is reported, never written,
    // so a missing field can't clobber a good value with "".
    if (value === undefined || value === null || value === "") {
      warnings.push({ name, scope });
      continue;
    }
    writes.push({ scope, name, value: String(value), secure: !!rule.secure });
  }

  return { writes, warnings };
}

/** Extract a single rule's raw value from the response, or `undefined`. */
function _extract(rule, { status, headers, body }) {
  switch (rule.source ?? "body") {
    case "status":
      return String(status);

    case "header": {
      const key = String(rule.path ?? "")
        .trim()
        .toLowerCase();
      return key ? headers[key] : undefined;
    }

    default: {
      // body — dot-path extraction over JSON; tolerate non-JSON and missing
      // paths (both surface as a warning rather than a throw).
      const path = String(rule.path ?? "").trim() || ".";
      try {
        // extractJsonPath returns null for paths outside the simple subset and
        // "" for an empty body / missing path; both count as "no value".
        const extracted = extractJsonPath(body, path);
        return extracted === null || extracted === "" ? undefined : extracted;
      } catch {
        return undefined;
      }
    }
  }
}
