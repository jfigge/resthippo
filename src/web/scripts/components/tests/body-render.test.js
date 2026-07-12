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

/**
 * body-render.test.js — the pure DOM builders for the response Body pane
 * (extracted from ResponseViewer). These take an element + data and produce DOM
 * with no component state, so they are directly exercisable under jsdom. Covers
 * highlight/plain routing, the hex dump, the NDJSON hint, markdown code
 * re-highlighting, and the foldable-code renderer (line numbers, fold toggles,
 * collapse visibility, and the large-body fallbacks).
 *
 * jsdom-setup is imported first so the Prism vendor bundle (dereferenced by
 * body-render at module-load) has its DOM globals in place.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "../../tests/jsdom-setup.js";
import {
  fillHighlighted,
  appendCodeBlock,
  fillHexDump,
  buildNdjsonStreamHint,
  highlightMarkdownCode,
  renderFoldableCode,
} from "../response/body-render.js";

// ── fillHighlighted ─────────────────────────────────────────────────────────

test("fillHighlighted: a known grammar produces Prism token markup", () => {
  resetDom();
  const el = document.createElement("code");
  fillHighlighted(el, '{"a":1}', "json");
  // JSON grammar is bundled, so highlighting produces token spans.
  assert.ok(el.querySelector("span.token"), "expected Prism token spans");
  assert.equal(el.textContent, '{"a":1}', "visible text is preserved verbatim");
});

test("fillHighlighted: an unknown grammar falls back to escaped plain text", () => {
  resetDom();
  const el = document.createElement("code");
  // No grammar for this language → textContent path, which escapes markup.
  fillHighlighted(el, "<script>alert(1)</script>", "no-such-lang");
  assert.equal(el.children.length, 0, "no child elements — set as text");
  assert.equal(el.textContent, "<script>alert(1)</script>");
  assert.ok(
    el.innerHTML.includes("&lt;script&gt;"),
    "angle brackets are HTML-escaped, not injected as live nodes",
  );
});

test("fillHighlighted: explicit grammar:null forces plain text even for a real lang", () => {
  resetDom();
  const el = document.createElement("code");
  fillHighlighted(el, '{"a":1}', "json", null);
  assert.equal(el.children.length, 0);
  assert.equal(el.textContent, '{"a":1}');
});

// ── appendCodeBlock ─────────────────────────────────────────────────────────

test("appendCodeBlock: appends a language-classed <code> child", () => {
  resetDom();
  const pre = document.createElement("pre");
  appendCodeBlock(pre, "body: 1", "yaml");
  const code = pre.querySelector("code");
  assert.ok(code, "a <code> was appended");
  assert.equal(code.className, "language-yaml");
});

test("appendCodeBlock: grammar:null keeps the language class but skips highlight", () => {
  resetDom();
  const pre = document.createElement("pre");
  appendCodeBlock(pre, "<b>x</b>", "json", null);
  const code = pre.querySelector("code");
  assert.equal(code.className, "language-json");
  assert.equal(code.children.length, 0);
  assert.equal(code.textContent, "<b>x</b>");
});

// ── fillHexDump ─────────────────────────────────────────────────────────────

test("fillHexDump: renders offset, hex bytes, and printable-only ASCII", () => {
  resetDom();
  const pre = document.createElement("pre");
  // 0x00 (control), 0x41 'A', 0x7f (DEL, non-printable), 0x80 (>0x7e)
  const bytes = new Uint8Array([0x00, 0x41, 0x7f, 0x80]);
  fillHexDump(pre, bytes, bytes.length);

  const offset = pre.querySelector(".res-hex-offset");
  const hex = pre.querySelector(".res-hex-bytes");
  assert.equal(offset.textContent, "00000000", "8-digit hex offset");
  assert.ok(hex.textContent.startsWith("00 41 7f 80 "), "byte columns in hex");
  // Only 0x41 is printable; the other three collapse to '.'.
  assert.ok(pre.textContent.includes("|.A..|"), "ASCII gutter masks non-print");
});

test("fillHexDump: a second 16-byte row gets its own offset and a leading newline", () => {
  resetDom();
  const pre = document.createElement("pre");
  const bytes = new Uint8Array(20).fill(0x61); // 'a' × 20 → two rows
  fillHexDump(pre, bytes, bytes.length);

  const offsets = [...pre.querySelectorAll(".res-hex-offset")].map(
    (s) => s.textContent,
  );
  assert.deepEqual(offsets, ["00000000", "00000010"]);
  assert.ok(pre.textContent.includes("\n"), "rows are newline-separated");
  // Row 2 has only 4 bytes → its ASCII gutter shows exactly 4 chars.
  assert.ok(pre.textContent.includes("|aaaa|"));
});

// ── buildNdjsonStreamHint ───────────────────────────────────────────────────

test("buildNdjsonStreamHint: banner carries localized (non-key) text", () => {
  resetDom();
  const banner = buildNdjsonStreamHint();
  assert.equal(banner.className, "res-stream-hint-banner");
  const text = banner.querySelector(".res-stream-hint-text");
  assert.ok(text, "has a text span");
  assert.ok(text.textContent.length > 0);
  assert.notEqual(
    text.textContent,
    "response.streamHint.ndjson",
    "resolved through t(), not a bare key",
  );
});

// ── highlightMarkdownCode ───────────────────────────────────────────────────

test("highlightMarkdownCode: maps a known info-string and re-highlights", () => {
  resetDom();
  const root = document.createElement("div");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-js"; // marked's info-string, mapped → javascript
  code.textContent = "const x = 1;";
  pre.appendChild(code);
  root.appendChild(pre);

  highlightMarkdownCode(root);
  assert.equal(code.className, "language-javascript", "class normalized");
  assert.ok(
    code.querySelector("span.token"),
    "re-highlighted with token spans",
  );
});

test("highlightMarkdownCode: leaves an unlisted language untouched", () => {
  resetDom();
  const root = document.createElement("div");
  root.innerHTML = '<pre><code class="language-brainfuck">+++.</code></pre>';
  const code = root.querySelector("code");
  highlightMarkdownCode(root);
  assert.equal(code.className, "language-brainfuck", "class unchanged");
  assert.equal(code.children.length, 0, "no highlighting applied");
});

// ── renderFoldableCode ──────────────────────────────────────────────────────

const opts = (over = {}) => ({
  folding: false,
  lineNumbers: false,
  setFoldReveal: () => {},
  ...over,
});

test("renderFoldableCode: one .res-fold-line per source line with 1-based numbers", () => {
  resetDom();
  const pre = document.createElement("pre");
  renderFoldableCode(
    pre,
    "line1\nline2\nline3",
    "json",
    opts({ lineNumbers: true }),
  );

  const rows = pre.querySelectorAll(".res-fold-line");
  assert.equal(rows.length, 3);
  assert.ok(pre.classList.contains("res-body-pre--foldable"));
  assert.ok(pre.classList.contains("res-body-pre--line-numbers"));
  const nums = [...pre.querySelectorAll(".res-fold-num")].map(
    (n) => n.textContent,
  );
  assert.deepEqual(nums, ["1", "2", "3"]);
  // Line-number gutter width reserves the widest number.
  assert.equal(pre.style.getPropertyValue("--res-num-ch"), "1ch");
});

test("renderFoldableCode: folding draws a toggle at an opener and collapse hides its children", () => {
  resetDom();
  const pre = document.createElement("pre");
  const text = ["{", '  "a": 1,', '  "b": 2', "}"].join("\n");
  renderFoldableCode(pre, text, "json", opts({ folding: true }));

  assert.ok(pre.classList.contains("res-body-pre--folding"));
  const rows = pre.querySelectorAll(".res-fold-line");
  assert.equal(rows.length, 4);

  // The '{' opener (line 0) carries a fold toggle; the closing '}' does not.
  const toggle = rows[0].querySelector(".res-fold-toggle");
  assert.ok(toggle, "opener has a fold toggle");
  assert.equal(rows[3].querySelector(".res-fold-toggle"), null);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  // Collapse → children (lines 1,2) hidden; the closer (line 3) stays visible.
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(rows[1].hidden, true);
  assert.equal(rows[2].hidden, true);
  assert.equal(rows[3].hidden, false);

  // Expand restores visibility.
  toggle.click();
  assert.equal(rows[1].hidden, false);
  assert.equal(rows[2].hidden, false);
});

test("renderFoldableCode: setFoldReveal is registered only when folding is on", () => {
  resetDom();
  let onCalls = 0;
  renderFoldableCode(
    document.createElement("pre"),
    "a\n  b",
    "json",
    opts({ folding: true, setFoldReveal: () => onCalls++ }),
  );
  assert.equal(onCalls, 1, "fold-reveal hook registered when folding");

  let offCalls = 0;
  renderFoldableCode(
    document.createElement("pre"),
    "a\n  b",
    "json",
    opts({ folding: false, setFoldReveal: () => offCalls++ }),
  );
  assert.equal(offCalls, 0, "no hook when folding is off (returns early)");
});

test("renderFoldableCode: very large bodies fall back to a single code block", () => {
  resetDom();
  const pre = document.createElement("pre");
  const text = Array(5001).fill("x").join("\n"); // > MAX_FOLD_LINES (5000)
  renderFoldableCode(
    pre,
    text,
    "json",
    opts({ folding: true, lineNumbers: true }),
  );

  assert.equal(
    pre.querySelectorAll(".res-fold-line").length,
    0,
    "no per-line rows",
  );
  assert.ok(pre.querySelector("code.language-json"), "one fallback code block");
  assert.ok(
    !pre.classList.contains("res-body-pre--foldable"),
    "structural classes are skipped on the fallback path",
  );
});
