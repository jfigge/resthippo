/**
 * http-content-type.js — Classify a response body as text or binary.
 *
 * Used by the HTTP execution path in main.js to decide whether a response body
 * can safely cross IPC as a UTF-8 string or must be carried as raw bytes
 * (base64). Pure and dependency-free so it can be unit-tested in isolation.
 */
"use strict";

// Content-Type substrings/exact types that are text even though they are not
// under the `text/*` tree. Matched against the lowercased type (params stripped).
const TEXT_SUBSTRINGS = [
  "json",
  "xml",
  "yaml",
  "javascript",
  "ecmascript",
  "csv",
];
const TEXT_EXACT = new Set([
  "application/x-www-form-urlencoded",
  "image/svg+xml", // SVG is UTF-8 markup — render as an image, but it is text in transit
]);

/**
 * Strip parameters and lowercase a Content-Type value.
 * @param {string} ct  raw Content-Type header value (may include charset/boundary)
 * @returns {string} the bare lowercased type, or "" when absent
 */
function baseType(ct) {
  return (ct ?? "").toLowerCase().split(";")[0].trim();
}

/**
 * Decide whether a Content-Type denotes a binary (non-text) body.
 *
 * Text = the `text/*` tree, any type containing json/xml/yaml/javascript/
 * ecmascript/csv, form-urlencoded, or SVG. Everything else — octet-stream,
 * raster images, PDF, fonts, audio/video, protobuf, … — is binary. An
 * empty/absent Content-Type is treated as text here; callers should sniff the
 * bytes (see looksBinary) before trusting that.
 *
 * @param {string} ct  raw Content-Type header value
 * @returns {boolean}
 */
function isBinaryContentType(ct) {
  const base = baseType(ct);
  if (!base) return false;
  if (base.startsWith("text/")) return false;
  if (TEXT_EXACT.has(base)) return false;
  if (TEXT_SUBSTRINGS.some((s) => base.includes(s))) return false;
  return true;
}

/**
 * Heuristic byte sniff for when no Content-Type is present. Reports binary when
 * the sample contains a NUL byte or a high proportion of non-printable control
 * bytes (excluding tab/newline/carriage-return/form-feed).
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {boolean}
 */
function looksBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = Math.min(buf.length, 1024);
  let control = 0;
  for (let i = 0; i < sample; i++) {
    const b = buf[i];
    if (b === 0) return true; // a NUL byte never occurs in UTF-8 text
    // Allow tab (9), LF (10), FF (12), CR (13); count other C0 controls.
    if (b < 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) control++;
  }
  return control / sample > 0.1;
}

// Content-Type → file extension for "Save to file" naming of binary bodies.
const BINARY_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/wasm": "wasm",
  "application/octet-stream": "bin",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
};

/**
 * Map a Content-Type to a save-dialog file extension for a binary body.
 * Falls back to the subtype after `/` (sanitised), else "bin".
 *
 * @param {string} ct  raw Content-Type header value
 * @returns {string} extension without a leading dot
 */
function binaryExtensionFor(ct) {
  const base = baseType(ct);
  if (BINARY_EXT[base]) return BINARY_EXT[base];
  const subtype = base.split("/")[1] ?? "";
  const cleaned = subtype.replace(/\+.*$/, "").replace(/[^a-z0-9]/g, "");
  return cleaned || "bin";
}

module.exports = {
  isBinaryContentType,
  looksBinary,
  binaryExtensionFor,
};
