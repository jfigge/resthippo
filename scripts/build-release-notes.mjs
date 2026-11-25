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

// build-release-notes.mjs — write website/releases.html, the website's release
// notes, FROM website/release-notes.json: every release since 1.0.0, newest
// first, one line per commit that went into it.
//
// The JSON is the record and the page a projection of it. `make release-notes`
// re-renders the page, and the committed copy is held to the JSON by
// src/web/scripts/tests/website-releases.test.js.
//
// The rule for a line: a commit whose message is a single line (trailers such
// as Signed-off-by don't count) is listed as that line, verbatim; a commit with
// a longer message is listed as a SUMMARY of the whole message, written by hand.
// A NEW release's entry is added by `make release` through `--add`: one line
// per commit since the last tag, each its subject. `--add` names the commits
// that have a longer message — replace their lines in the JSON with a summary,
// then run `make release-notes`. A release may also carry a `note`, a sentence
// shown above its lines (e.g. a rebuild with no commits of its own).
//
// Plain Node with no dependencies beyond git for `--add`.
//
//   node scripts/build-release-notes.mjs                 # render the page
//   node scripts/build-release-notes.mjs --add 1.20.0    # add 1.20.0, render
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const NOTES = resolve(ROOT, "website/release-notes.json");
export const OUT = resolve(ROOT, "website/releases.html");
const SITE_URL = "https://resthippo.com";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** HTML-escape text for element content and attribute values. */
export const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The release commits `make release` itself makes, which are not news. */
export const isReleaseCommit = (subject) => /^Release v\d+\.\d+\.\d+$/.test(subject); // prettier-ignore

/**
 * A release's entry from its commits, oldest first, as `git log --format=%h
 * %s` lines. The version bump `make release` commits is left out.
 * @param {string} version
 * @param {string} date - YYYY-MM-DD
 * @param {string[]} lines
 * @returns {{version: string, date: string, commits: Array<{hash: string, summary: string}>}}
 */
export function releaseEntry(version, date, lines) {
  const commits = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(" ");
      return { hash: line.slice(0, at), summary: line.slice(at + 1).trim() };
    })
    .filter((c) => c.hash && !isReleaseCommit(c.summary));
  return { version, date, commits };
}

/**
 * The notes with `entry` added at the top. A version already listed is
 * refused: its lines may have been edited by hand, and a re-run must never
 * overwrite them.
 */
export function withRelease(notes, entry) {
  if (!VERSION_RE.test(entry.version)) {
    throw new Error(`not an x.y.z version: ${entry.version}`);
  }
  if (notes.releases.some((r) => r.version === entry.version)) {
    throw new Error(`release-notes.json already lists ${entry.version}`);
  }
  return { ...notes, releases: [entry, ...notes.releases] };
}

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const TRAILER_RE = /^[a-z][\w-]*-by:|^claude-session:/i;

/**
 * Whether a commit message body (everything after the subject) says anything
 * beyond trailers such as Signed-off-by — i.e. whether its release-note line
 * should be a summary rather than the subject verbatim.
 * @param {string} body
 */
export const hasBody = (body) =>
  body.split("\n").some((l) => l.trim() && !TRAILER_RE.test(l.trim()));

/** Hashes of the commits in `range` whose message is more than one line. */
function multiLineCommits(range) {
  const out = git("log", "--no-merges", "--format=%h%x00%b%x1e", range);
  return out
    .split("\x1e")
    .map((rec) => rec.trim().split("\0"))
    .filter(([hash, body = ""]) => hash && hasBody(body))
    .map(([hash]) => hash);
}

/** The range from the last release tag to HEAD. */
function sinceLastTag() {
  const last = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD"); // prettier-ignore
  return `${last}..HEAD`;
}

/** The commits in `range`, oldest first, as `%h %s` lines. */
function commitLines(range) {
  const log = git("log", "--reverse", "--no-merges", "--format=%h %s", range); // prettier-ignore
  return log ? log.split("\n") : [];
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const LOGO = `<svg width="20" height="20" viewBox="0 0 512 512" role="img" aria-label="Rest Hippo"><rect width="512" height="512" rx="114" fill="#6C5CE7"/><circle cx="170" cy="146" r="40" fill="#fff"/><circle cx="342" cy="146" r="40" fill="#fff"/><rect x="144" y="140" width="224" height="190" rx="74" fill="#fff"/><rect x="118" y="260" width="276" height="150" rx="74" fill="#fff"/><circle cx="201" cy="198" r="17" fill="#6C5CE7"/><circle cx="311" cy="198" r="17" fill="#6C5CE7"/><ellipse cx="210" cy="330" rx="14" ry="20" fill="#6C5CE7"/><ellipse cx="302" cy="330" rx="14" ry="20" fill="#6C5CE7"/></svg>`;

// The site chrome of privacy.html / code-signing-policy.html (palette mirrors
// website/index.html), plus the release list's own pieces.
const STYLE = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #1c1c1c; --mantle: #161616; --crust: #101010;
      --surface-0: #2a2a2a; --surface-1: #383838; --overlay-0: #686868;
      --text: #e8e8e8; --subtext: #b0b0b0;
      --brand: #6C5CE7; --accent: #a49af0;
    }
    html { scroll-behavior: smooth; }
    body { font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; display: flex; flex-direction: column; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { background: var(--mantle); border-bottom: 1px solid var(--surface-0); position: sticky; top: 0; z-index: 100; padding: 0 2rem; display: flex; align-items: center; justify-content: space-between; height: 58px; }
    .nav-logo { display: flex; align-items: center; gap: 10px; }
    .nav-logo:hover { text-decoration: none; }
    .logo-mark { width: 32px; height: 32px; border-radius: 8px; background: #1c1c1c; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--surface-1); }
    .nav-wordmark { font-size: 1.2rem; font-weight: 800; color: var(--accent); letter-spacing: -0.5px; }
    .nav-right { display: flex; align-items: center; gap: 1.5rem; }
    .nav-link { color: var(--subtext); font-size: 0.875rem; transition: color 0.15s; }
    .nav-link:hover { color: var(--text); text-decoration: none; }
    .btn { display: inline-flex; align-items: center; padding: 8px 18px; border-radius: 8px; font-size: 0.875rem; font-weight: 600; line-height: 1; transition: transform 0.15s, background 0.15s, box-shadow 0.15s; }
    .btn-primary { background: var(--brand); color: #fff; }
    .btn-primary:hover { text-decoration: none; background: color-mix(in srgb, var(--brand) 86%, var(--crust)); transform: translateY(-1px); box-shadow: 0 4px 18px color-mix(in srgb, var(--brand) 45%, transparent); }
    .page { flex: 1; max-width: 800px; width: 100%; margin: 0 auto; padding: 64px 2rem 80px; }
    .page-tag { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); margin-bottom: 12px; }
    .page h1 { font-size: clamp(2rem, 5vw, 3rem); font-weight: 900; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 16px; }
    .page > p { color: var(--subtext); margin-bottom: 14px; }
    .release { margin-top: 44px; }
    .release h2 { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; font-size: 1.3rem; font-weight: 800; letter-spacing: -0.4px; padding-bottom: 8px; margin-bottom: 6px; border-bottom: 1px solid var(--surface-0); }
    .release-date { font-size: 0.85rem; font-weight: 600; color: var(--overlay-0); letter-spacing: 0; }
    .release-link { font-size: 0.85rem; font-weight: 600; letter-spacing: 0; margin-left: auto; }
    .release-note { color: var(--subtext); font-style: italic; margin: 10px 0 4px; }
    .release ul { list-style: none; }
    .release li { display: flex; gap: 14px; padding: 6px 0; border-bottom: 1px solid var(--surface-0); color: var(--subtext); }
    .release li:last-child { border-bottom: none; }
    .release li a.commit { flex-shrink: 0; font-family: "Cascadia Code", "JetBrains Mono", "Fira Code", monospace; font-size: 0.82rem; padding-top: 2px; color: var(--overlay-0); }
    .release li a.commit:hover { color: var(--accent); }
    footer { background: var(--crust); border-top: 1px solid var(--surface-0); padding: 48px 2rem; text-align: center; }
    .footer-inner { max-width: 700px; margin: 0 auto; }
    .footer-logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 16px; }
    .footer-name { font-size: 1.1rem; font-weight: 800; color: var(--accent); }
    footer p { color: var(--overlay-0); font-size: 0.83rem; line-height: 1.8; }
    @media (max-width: 640px) {
      nav { padding: 0 1rem; }
      .nav-right .nav-link { display: none; }
      .page { padding: 44px 1rem 64px; }
    }`;

function renderRelease(repo, r) {
  const note = r.note ? `\n    <p class="release-note">${esc(r.note)}</p>` : "";
  const items = r.commits
    .map(
      (c) =>
        `      <li><a class="commit" href="https://github.com/${repo}/commit/${esc(c.hash)}" rel="noopener noreferrer">${esc(c.hash)}</a><span>${esc(c.summary)}</span></li>`,
    )
    .join("\n");
  const list = items ? `\n    <ul>\n${items}\n    </ul>` : "";
  const id = `v${r.version}`;
  return `  <section class="release" id="${id}">
    <h2>${id} <span class="release-date">${esc(r.date)}</span><a class="release-link" href="https://github.com/${repo}/releases/tag/${id}" rel="noopener noreferrer">Release on GitHub →</a></h2>${note}${list}
  </section>`;
}

/**
 * The whole of website/releases.html.
 * @param {{repo: string, releases: Array}} notes
 * @returns {string}
 */
export function renderReleasesPage(notes) {
  const { repo, releases } = notes;
  const description =
    "What changed in every Rest Hippo release since 1.0.0, one line for each change.";
  return `<!DOCTYPE html>
<!-- GENERATED by scripts/build-release-notes.mjs from website/release-notes.json
     — do not edit by hand. Change the JSON, then run \`make release-notes\`. -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#6C5CE7" />
  <!-- No scripts at all, so script-src is 'none'; the inline <style> is what
       needs 'unsafe-inline'. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <meta name="description" content="${esc(description)}" />
  <title>Release notes — Rest Hippo</title>
  <link rel="canonical" href="${SITE_URL}/releases.html" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Rest Hippo" />
  <meta property="og:title" content="Release notes — Rest Hippo" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${SITE_URL}/releases.html" />
  <meta property="og:image" content="${SITE_URL}/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@RestHippo" />
  <meta name="twitter:title" content="Release notes — Rest Hippo" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${SITE_URL}/og-image.png" />
  <style>${STYLE}
  </style>
</head>
<body>

<nav>
  <a class="nav-logo" href="/">
    <span class="logo-mark">${LOGO}</span>
    <span class="nav-wordmark">Rest Hippo</span>
  </a>
  <div class="nav-right">
    <a class="nav-link" href="/#features">Features</a>
    <a class="nav-link" href="/#downloads">Downloads</a>
    <a class="nav-link" href="/vs-postman.html">Compare</a>
    <a class="nav-link" href="/features.html">Feature Requests</a>
    <a class="nav-link" href="/docs/">Guide</a>
    <a class="nav-link" href="https://github.com/sponsors/jfigge" rel="noopener noreferrer">Donate</a>
    <a class="btn btn-primary" href="/#downloads">Download</a>
  </div>
</nav>

<main class="page">
  <p class="page-tag">Releases</p>
  <h1>Release notes</h1>
  <p>
    Every Rest Hippo release since 1.0.0, newest first, with one line for each change
    that went into it. Each change links to its commit, and each release to its page on
    <a href="https://github.com/${repo}/releases" rel="noopener noreferrer">GitHub Releases</a>,
    where its installers are. The latest version is always on the
    <a href="/#downloads">download page</a>.
  </p>

${releases.map((r) => renderRelease(repo, r)).join("\n\n")}
</main>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <span class="logo-mark">${LOGO}</span>
      <span class="footer-name">Rest Hippo</span>
    </div>
    <p style="margin-bottom:14px">
      <a href="/">Home</a>
      &nbsp;·&nbsp;
      <a href="/docs/">User Guide</a>
      &nbsp;·&nbsp;
      <a href="/features.html">Feature Requests</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/${repo}" rel="noopener noreferrer">GitHub</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/sponsors/jfigge" rel="noopener noreferrer">Donate</a>
      &nbsp;·&nbsp;
      <a href="https://x.com/RestHippo" rel="noopener noreferrer">@RestHippo</a>
      &nbsp;·&nbsp;
      <a href="/privacy.html">Privacy</a>
      &nbsp;·&nbsp;
      <a href="/code-signing-policy.html">Code Signing</a>
      &nbsp;·&nbsp;
      <a href="mailto:hippoherd@gmail.com">Contact</a>
    </p>
    <p>Copyright &copy; 2026 Jason Figge. Released under the GNU GPL v3.<br>
    Built with Electron &amp; Vanilla JS. No telemetry, no accounts, fully offline.</p>
  </div>
</footer>

</body>
</html>
`;
}

export const readNotes = () => JSON.parse(readFileSync(NOTES, "utf8"));

// ── Build ─────────────────────────────────────────────────────────────────────
// Only write when run directly, so a test can import the renderer.
const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  let notes = readNotes();
  const at = process.argv.indexOf("--add");
  if (at !== -1) {
    const version = process.argv[at + 1] ?? "";
    const range = sinceLastTag();
    const entry = releaseEntry(version, today(), commitLines(range));
    notes = withRelease(notes, entry);
    writeFileSync(NOTES, `${JSON.stringify(notes, null, 2)}\n`);
    console.log(
      `Added v${version} to website/release-notes.json (${entry.commits.length} commits)`,
    );
    const listed = new Set(entry.commits.map((c) => c.hash));
    const toSummarize = multiLineCommits(range).filter((h) => listed.has(h));
    if (toSummarize.length) {
      console.log(
        `  These commits have a multi-line message — replace their subject line with a summary of the message:\n    ${toSummarize.join(" ")}`,
      );
    }
  }
  writeFileSync(OUT, renderReleasesPage(notes));
  console.log(
    `Wrote website/releases.html (${notes.releases.length} releases)`,
  );
}
