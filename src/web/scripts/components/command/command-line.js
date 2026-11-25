/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * components/command/command-line.js — parse / re-serialise the command line of
 * a Command request (Feature 70). Pure; no DOM.
 *
 * The command line is the canonical source: the Arguments tab is a view of its
 * tokens, kept in two-way sync. Syntax (our own, not a shell's — nothing is ever
 * expanded or interpreted, there are no pipes/redirects/globs):
 *
 *   • whitespace separates tokens; token 0 is the executable
 *   • '…'   single quotes: literal
 *   • "…"   double quotes: `\"` (and on POSIX `\\`) escape inside
 *   • \x    outside quotes on POSIX escapes the next character; on Windows a
 *           backslash is literal (so `C:\tools\az.cmd` just works) except `\"`
 *   • {{…}} variable / function pills are opaque — spaces and quotes inside
 *           `{{now("ISO")}}` never split a token
 *
 * Variables are resolved per token AFTER parsing, so a variable whose value has
 * spaces or quotes can never inject extra arguments.
 */

"use strict";

/** @typedef {{ value: string, start: number, end: number }} Token */

const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Split a command line into tokens.
 * @param {string} line
 * @param {string} [platform]  "win32" switches backslash handling
 * @returns {Token[]}  `value` is unquoted; `start`/`end` span the raw text
 */
export function tokenize(line, platform = "") {
  const s = String(line ?? "");
  const win = platform === "win32";
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isWs(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let value = "";
    while (i < s.length && !isWs(s[i])) {
      const c = s[i];
      if (c === "{" && s[i + 1] === "{") {
        const close = s.indexOf("}}", i + 2);
        const end = close === -1 ? s.length : close + 2;
        value += s.slice(i, end);
        i = end;
      } else if (c === "'") {
        const close = s.indexOf("'", i + 1);
        const end = close === -1 ? s.length : close;
        value += s.slice(i + 1, end);
        i = close === -1 ? s.length : close + 1;
      } else if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "{" && s[i + 1] === "{") {
            const close = s.indexOf("}}", i + 2);
            const end = close === -1 ? s.length : close + 2;
            value += s.slice(i, end);
            i = end;
            continue;
          }
          if (
            s[i] === "\\" &&
            (s[i + 1] === '"' || (!win && s[i + 1] === "\\"))
          ) {
            value += s[i + 1];
            i += 2;
            continue;
          }
          value += s[i++];
        }
        i++; // closing quote (or past the end when unterminated)
      } else if (c === "\\" && i + 1 < s.length) {
        if (!win || s[i + 1] === '"') {
          value += s[i + 1];
          i += 2;
        } else {
          value += c;
          i++;
        }
      } else {
        value += c;
        i++;
      }
    }
    tokens.push({ value, start, end: Math.min(i, s.length) });
  }
  return tokens;
}

/**
 * Split a command line into the executable and its argument values.
 * @returns {{ executable: string, args: string[] }}
 */
export function parseCommandLine(line, platform = "") {
  const t = tokenize(line, platform);
  return {
    executable: t[0]?.value ?? "",
    args: t.slice(1).map((x) => x.value),
  };
}

/** The value with every `{{…}}` pill blanked out (for "needs quoting" checks). */
function withoutPills(value) {
  return value.replace(/\{\{[\s\S]*?(\}\}|$)/g, "x");
}

/**
 * Quote one value so `tokenize` reads it back as a single identical token.
 * Plain values stay bare; otherwise single quotes are preferred (literal on
 * every platform), falling back to double quotes when the value contains `'`.
 * @param {string} value
 * @param {string} [platform]
 */
export function quoteArg(value, platform = "") {
  const v = String(value ?? "");
  if (v === "") return "''";
  const win = platform === "win32";
  const bare = withoutPills(v);
  const special = win ? /[\s'"]/ : /[\s'"\\]/;
  // A bare "{{" in a non-pill position would re-parse as a pill: same value.
  if (!special.test(bare)) return v;
  if (!v.includes("'")) return `'${v}'`;
  const body = win
    ? v.replace(/"/g, '\\"')
    : v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${body}"`;
}

/**
 * Replace the argument values of a command line, keeping the executable token
 * and every unchanged argument exactly as the user typed them (their quoting
 * style survives an edit elsewhere in the Arguments tab).
 *
 * @param {string} line      the current command line
 * @param {string[]} args    the new argument values (excluding the executable)
 * @param {string} [platform]
 * @returns {string}
 */
export function setArgs(line, args, platform = "") {
  const s = String(line ?? "");
  const tokens = tokenize(s, platform);
  const old = tokens.slice(1);
  const next = (args || []).map((a) => String(a ?? ""));

  // Same count → splice changed tokens in place (preserves spacing).
  if (old.length === next.length && tokens.length > 0) {
    let out = s;
    for (let i = old.length - 1; i >= 0; i--) {
      if (old[i].value === next[i]) continue;
      out =
        out.slice(0, old[i].start) +
        quoteArg(next[i], platform) +
        out.slice(old[i].end);
    }
    return out;
  }

  // Count changed (add / remove / reorder) → rebuild, reusing the raw text of
  // any token whose value is unchanged at the same position.
  const exeRaw =
    tokens.length > 0 ? s.slice(tokens[0].start, tokens[0].end) : "";
  const parts = next.map((v, i) =>
    old[i] && old[i].value === v
      ? s.slice(old[i].start, old[i].end)
      : quoteArg(v, platform),
  );
  return [exeRaw, ...parts].join(" ").replace(/^ /, "");
}

/**
 * Replace just the executable token.
 * @returns {string}
 */
export function setExecutable(line, executable, platform = "") {
  const s = String(line ?? "");
  const t = tokenize(s, platform);
  const q = quoteArg(executable, platform);
  if (t.length === 0) return q;
  return s.slice(0, t[0].start) + q + s.slice(t[0].end);
}
