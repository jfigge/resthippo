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

import { queryDataPath } from "./json-path.js";
import { normalizeStatusMatch, statusMatches } from "./status-match.js";
import { parse as parseYaml } from "../vendor/yaml.js";

/**
 * captures.js — Post-response capture evaluation (Feature 03).
 *
 * `applyCaptures` is a PURE function: given a response and a request's capture
 * rules, it returns the variable writes to perform plus any rules that resolved
 * to nothing. It performs:
 *   - Per-rule status gating — each rule carries a `status` selector (group /
 *     exact codes / "any"); a rule is evaluated only when the response code
 *     matches it. A rule whose status doesn't match is skipped silently (no
 *     write, no warning) — it simply doesn't apply to this response. This is
 *     what lets one request capture different values on success vs. error.
 *   - NO persistence — the caller routes each write to the appropriate variable
 *     scope store. Keeping this pure makes it trivially unit-testable.
 *
 * Capture rule shape:
 *   { id, enabled, source, path, target: { scope, name }, secure, status }
 *     source       ∈ "body" | "header" (name) | "status"
 *                    A "body" rule walks a dot-path (.a.b.[0]) over the parsed
 *                    body; the body may be JSON, YAML, or XML — anything else is
 *                    reported as "no value", never captured.
 *     target.scope ∈ "environment" | "collection" | "global"
 *     secure       — mark the written variable secret (encrypted at rest)
 *     status       — string[] of selector tokens ("any" | "2xx" | "404" | …);
 *                    an absent selector defaults to ["2xx"] (back-compat).
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

    // Per-rule status gate: skip rules whose selector doesn't cover this code.
    if (!statusMatches(status, normalizeStatusMatch(rule.status))) continue;

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
      // body — dot-path extraction over a JSON, YAML, or XML body. A body in
      // none of those formats (or a missing path) surfaces as a warning, never a
      // throw.
      const path = String(rule.path ?? "").trim() || ".";
      const data = _parseBody(body);
      if (data === undefined) return undefined; // not JSON / YAML / XML
      try {
        // queryDataPath returns null for paths outside the simple subset and ""
        // for a missing path; both count as "no value".
        const extracted = queryDataPath(data, path);
        return extracted === null || extracted === "" ? undefined : extracted;
      } catch {
        return undefined;
      }
    }
  }
}

/**
 * Parse a response body into a value the dot-path can walk. Tries, in order:
 *   1. strict JSON (fast and exact — preserves the original JSON behaviour),
 *   2. XML, when the body opens with "<" (renderer-only; absent under bare node,
 *      where step 3 covers it),
 *   3. YAML (a JSON superset, so this also tolerates JSON-ish input).
 * Returns `undefined` for an empty body or one that is none of those formats.
 *
 * @param {string} body
 * @returns {*}
 */
function _parseBody(body) {
  const text = typeof body === "string" ? body : "";
  if (!text.trim()) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    // not strict JSON — fall through
  }

  if (text.trim().startsWith("<") && typeof DOMParser !== "undefined") {
    return _parseXml(text);
  }

  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse an XML body to the same shape the dot-path walks for JSON/YAML, rooted
 * at the document element's tag (so `<user><id>1</id></user>` is addressed as
 * `.user.id`). Returns `undefined` for malformed XML.
 *
 * @param {string} text
 * @returns {object | undefined}
 */
function _parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    // A parse failure yields a <parsererror> element rather than throwing.
    if (doc.querySelector("parsererror")) return undefined;
    const root = doc.documentElement;
    if (!root) return undefined;
    const out = Object.create(null);
    out[root.tagName] = _xmlToValue(root);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Convert an XML element into a plain value:
 *   - a leaf element → its trimmed text content,
 *   - an element with child elements → an object keyed by child tag name,
 *   - repeated child tags → an array, addressable as `.tag.[0]`.
 * Attributes and namespaces are not represented — the simple dot-path subset
 * (`.name`) can't address them. A null-prototype object avoids any chance of a
 * crafted tag name (`__proto__`) polluting Object.prototype.
 *
 * @param {Element} el
 * @returns {string | object}
 */
function _xmlToValue(el) {
  const children = Array.from(el.children);
  if (children.length === 0) return el.textContent.trim();

  const obj = Object.create(null);
  for (const child of children) {
    const key = child.tagName;
    const val = _xmlToValue(child);
    if (key in obj) {
      if (Array.isArray(obj[key])) obj[key].push(val);
      else obj[key] = [obj[key], val];
    } else {
      obj[key] = val;
    }
  }
  return obj;
}
