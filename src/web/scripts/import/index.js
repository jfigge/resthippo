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

import { parse as parseYaml } from "../vendor/yaml.js";
import { parsePostman } from "./postman.js";
import { parseInsomnia, parseInsomniaV5 } from "./insomnia.js";
import { parseOpenApi } from "./openapi.js";
import { parseHar } from "./har.js";

// Re-export the cURL importer so `app.js` has one import surface for the
// importers. cURL is paste-driven (no file), so it is not part of detectFormat.
export { parseCurl } from "./curl.js";

/**
 * Sniff the format of a parsed data object.
 * @param {object} data
 * @returns {"postman"|"insomnia"|"insomnia-v5"|"openapi"|"har"|null}
 */
function detectFormat(data) {
  if (!data || typeof data !== "object") return null;

  // Postman — top-level or wrapped in { collection: { info: { schema } } }.
  // Coerce to string: a malformed file may carry a non-string `schema`, and
  // `.includes` on a number/object would throw out of the format sniff.
  const schema = String(
    data.info?.schema ?? data.collection?.info?.schema ?? "",
  );
  if (schema.includes("getpostman.com")) return "postman";

  // Insomnia v3 / v4
  if (data._type === "export" && data.__export_format != null)
    return "insomnia";

  // Insomnia v5 (YAML, type: "collection.insomnia.rest/5.0")
  if (
    typeof data.type === "string" &&
    data.type.includes("insomnia.rest/5") &&
    Array.isArray(data.collection)
  )
    return "insomnia-v5";

  // OpenAPI 3.x
  if (typeof data.openapi === "string" && data.openapi.startsWith("3."))
    return "openapi";

  // Swagger 2.0
  if (data.swagger === "2.0") return "openapi";

  // HAR 1.2 — { log: { version, entries: [...] } }
  if (data.log && Array.isArray(data.log.entries)) return "har";

  return null;
}

/**
 * Parse a raw file string (JSON or YAML) and return a Rest Hippo collection.
 *
 * Supports:
 *   - Postman v2.0 / v2.1 (.json)
 *   - Insomnia v3 / v4 (.json)
 *   - Insomnia v5 (.yaml)
 *   - OpenAPI 3.x and Swagger 2.0 (.json, .yaml, .yml)
 *   - HAR 1.2 (.har)
 *
 * Error contract: only `parseImport` throws, and only when the input cannot be
 * dispatched at all — content that is neither JSON nor YAML, or a parsed object
 * whose format is unrecognized. Once a format is identified, the per-format
 * sub-parser (`parsePostman`/`parseInsomnia`/`parseOpenApi`) never throws on
 * malformed-but-parseable input: it produces a best-effort collection and
 * reports any non-fatal lossy conversions through `warnings`. All three
 * sub-parsers return the same `{ collection, variables, warnings }` shape, so
 * the consumer (`app.js`) can read `warnings` uniformly.
 *
 * @param {string} content  Raw file content
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}  Variables use the canonical array shape.
 * @throws {Error} if the format is unrecognized or the file is invalid
 */
export function parseImport(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    try {
      data = parseYaml(content);
    } catch {
      throw new Error("File is not valid JSON or YAML.");
    }
  }

  const format = detectFormat(data);
  switch (format) {
    case "postman":
      return parsePostman(data);
    case "insomnia":
      return parseInsomnia(data);
    case "insomnia-v5":
      return parseInsomniaV5(data);
    case "openapi":
      return parseOpenApi(data);
    case "har":
      return parseHar(data);
    default:
      throw new Error(
        "Unrecognized format. Supported: Postman v2.x, Insomnia v3/v4/v5, OpenAPI 3.x, Swagger 2.0, HAR 1.2.",
      );
  }
}

/**
 * Collect the local paths referenced by file-kind form rows anywhere in a parsed
 * import tree. A cURL `-F name=@file` (or Rest Hippo's `name=path;filename=…`) becomes
 * a file row carrying `filePath`; the renderer existence-checks these before
 * deciding whether to warn.
 *
 * @param {object} node  A collection or request node
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function collectFormFilePaths(node, out = []) {
  if (!node) return out;
  if (node.type === "request") {
    for (const row of node.bodyFormRows ?? []) {
      if (row.kind === "file" && row.filePath) out.push(row.filePath);
    }
  }
  for (const child of node.children ?? []) collectFormFilePaths(child, out);
  return out;
}

/**
 * Push a "re-attach this file" warning for every file-kind form row whose path
 * is in `missingPaths`. Split out of the (synchronous, pure) parsers because
 * file existence can only be resolved asynchronously by the main process: the
 * renderer existence-checks the paths from `collectFormFilePaths`, then calls
 * this with the subset that isn't on disk. A file that *does* exist is read at
 * send time, so it needs no warning. Mutates and returns `parsed`.
 *
 * @param {{ collection: object, warnings: string[] }} parsed
 * @param {string[]} missingPaths
 */
export function warnMissingFormFiles(parsed, missingPaths) {
  const missing = new Set(missingPaths ?? []);
  if (missing.size === 0) return parsed;
  const visit = (node) => {
    if (!node) return;
    if (node.type === "request") {
      for (const row of node.bodyFormRows ?? []) {
        if (row.kind === "file" && row.filePath && missing.has(row.filePath)) {
          (parsed.warnings ??= []).push(
            `Form field "${row.name}" references a local file ("${row.filePath}") that isn't on disk; re-attach it before sending.`,
          );
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parsed.collection);
  return parsed;
}
