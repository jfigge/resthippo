/**
 * body-filter.js — evaluate a filter expression against a styled response body
 * and return the filtered text, re-serialized in the body's own format.
 *
 * The expression language is chosen by the body's render category:
 *   • json — a jq program, run by the bundled pure-JS jq (vendor/jq.js).
 *   • yaml — yq: the YAML is parsed to a plain value, the same jq engine runs
 *            over it, and each jq output is re-emitted as a YAML document.
 *   • xml  — an XPath expression, evaluated natively by the renderer's
 *            DOMParser + document.evaluate (no third-party dependency).
 *
 * Every entry point throws on a malformed body or expression; the caller
 * (ResponseFilter) surfaces the message and leaves the original body in place.
 */
"use strict";

import { compile } from "../../vendor/jq.js";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "../../vendor/yaml.js";

// Render categories (from response-viewer's classifyContentType) that support
// filtering. Anything else falls back to the "unsupported" notification.
const FILTERABLE = new Set(["json", "yaml", "xml"]);

/** True when a body of `category` can be filtered. */
export function isFilterable(category) {
  return FILTERABLE.has(category);
}

/**
 * Apply `expr` to `body` (a styled response body of `category`) and return the
 * filtered text. Throws on a parse error or an invalid expression.
 *
 * @param {string} category  "json" | "yaml" | "xml"
 * @param {string} body      the raw (unfiltered) response body text
 * @param {string} expr      the user's filter expression
 * @returns {string} the filtered body, serialized in the same format
 */
export function filterBody(category, body, expr) {
  if (category === "json") return filterJson(body, expr);
  if (category === "yaml") return filterYaml(body, expr);
  if (category === "xml") return filterXml(body, expr);
  throw new Error(`Filtering is not supported for ${category} bodies`);
}

// ── jq (JSON / YAML) ──────────────────────────────────────────────────────────

/**
 * Run a jq program over a parsed value and collect every output. compile()
 * throws a SyntaxError on a malformed program; the generator may throw at run
 * time (e.g. indexing the wrong type), so both phases are inside the try at the
 * call sites.
 */
function runJq(value, expr) {
  return [...compile(expr)(value)];
}

function filterJson(body, expr) {
  const value = JSON.parse(body);
  return runJq(value, expr).map(toJsonText).join("\n");
}

function toJsonText(value) {
  // jq's `null` survives as JS null; a missing field can surface as undefined,
  // which JSON.stringify drops entirely — normalize it to a literal null.
  return value === undefined ? "null" : JSON.stringify(value, null, 2);
}

function filterYaml(body, expr) {
  const value = parseYaml(body);
  const outputs = runJq(value, expr);
  // Multiple jq outputs become a multi-document YAML stream (`---` separated),
  // matching how yq prints more than one result.
  return outputs
    .map((o) => stringifyYaml(o === undefined ? null : o).replace(/\n+$/, ""))
    .join("\n---\n");
}

// ── XPath (XML) ───────────────────────────────────────────────────────────────

function filterXml(body, expr) {
  const doc = new DOMParser().parseFromString(body, "application/xml");
  // A parse failure yields a document containing a <parsererror> element rather
  // than throwing — detect it and report a clean error.
  if (doc.querySelector("parsererror")) {
    throw new Error("The response is not well-formed XML");
  }

  let result;
  try {
    result = doc.evaluate(expr, doc, null, XPathResult.ANY_TYPE, null);
  } catch (err) {
    // Normalize the DOM's verbose XPath SyntaxError to a short message.
    throw new Error(`Invalid XPath expression: ${err.message ?? err}`);
  }

  return serializeXPathResult(result);
}

/** Serialize an XPath result of any type to display text. */
function serializeXPathResult(result) {
  switch (result.resultType) {
    case XPathResult.NUMBER_TYPE:
      return String(result.numberValue);
    case XPathResult.STRING_TYPE:
      return result.stringValue;
    case XPathResult.BOOLEAN_TYPE:
      return String(result.booleanValue);
    default: {
      // A node-set — serialize each matched node, one per line.
      const serializer = new XMLSerializer();
      const parts = [];
      for (let node = result.iterateNext(); node; node = result.iterateNext()) {
        parts.push(serializeNode(node, serializer));
      }
      return parts.join("\n");
    }
  }
}

function serializeNode(node, serializer) {
  // Attribute and text nodes have no element serialization; emit their value so
  // expressions like `//@id` or `//title/text()` produce readable output.
  if (node.nodeType === Node.ATTRIBUTE_NODE) {
    return `${node.name}="${node.value}"`;
  }
  if (
    node.nodeType === Node.TEXT_NODE ||
    node.nodeType === Node.CDATA_SECTION_NODE
  ) {
    return node.nodeValue;
  }
  return serializer.serializeToString(node);
}
