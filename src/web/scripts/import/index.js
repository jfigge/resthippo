"use strict";

import { parse as parseYaml } from "../vendor/yaml.js";
import { parsePostman }  from "./postman.js";
import { parseInsomnia } from "./insomnia.js";
import { parseOpenApi }  from "./openapi.js";

/**
 * Sniff the format of a parsed data object.
 * @param {object} data
 * @returns {"postman"|"insomnia"|"openapi"|null}
 */
function detectFormat(data) {
  if (!data || typeof data !== "object") return null;

  // Postman — top-level or wrapped in { collection: { info: { schema } } }
  const schema = data.info?.schema ?? data.collection?.info?.schema ?? "";
  if (schema.includes("getpostman.com")) return "postman";

  // Insomnia v3 / v4
  if (data._type === "export" && data.__export_format != null) return "insomnia";

  // OpenAPI 3.x
  if (typeof data.openapi === "string" && data.openapi.startsWith("3.")) return "openapi";

  // Swagger 2.0
  if (data.swagger === "2.0") return "openapi";

  return null;
}

/**
 * Parse a raw file string (JSON or YAML) and return a wurl collection.
 *
 * Supports:
 *   - Postman v2.0 / v2.1 (.json)
 *   - Insomnia v3 / v4 (.json)
 *   - OpenAPI 3.x and Swagger 2.0 (.json, .yaml, .yml)
 *
 * @param {string} content  Raw file content
 * @returns {{ collection: object, variables: object }}
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
    case "postman":  return parsePostman(data);
    case "insomnia": return parseInsomnia(data);
    case "openapi":  return parseOpenApi(data);
    default:
      throw new Error(
        "Unrecognized format. Supported: Postman v2.x, Insomnia v3/v4, OpenAPI 3.x, Swagger 2.0.",
      );
  }
}
