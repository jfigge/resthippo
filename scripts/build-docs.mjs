#!/usr/bin/env node
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

// Build the hosted user guide: render src/web/docs/*.md into themed static HTML
// under website/docs/, copy the images, and emit website/sitemap.xml. The same
// Markdown drives the in-app guide (DocsViewer), so the website never drifts.
//
//   node scripts/build-docs.mjs
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src/web/docs");
const OUT = resolve(ROOT, "website/docs");
const SITE_URL = "https://resthippo.com";

// marked is an ESM-only package; bare specifiers don't honor NODE_PATH, so
// resolve it by file path. Locally it's a src/ devDependency; CI installs it to
// a temp prefix and points us at it via MARKED_DIR (see deploy-site.yml).
const MARKED_CANDIDATES = [
  process.env.MARKED_DIR && resolve(process.env.MARKED_DIR, "marked/lib/marked.esm.js"),
  resolve(ROOT, "src/node_modules/marked/lib/marked.esm.js"),
  resolve(ROOT, "node_modules/marked/lib/marked.esm.js"),
].filter(Boolean);
const markedPath = MARKED_CANDIDATES.find(existsSync);
if (!markedPath) {
  console.error("marked not found. Tried:\n  " + MARKED_CANDIDATES.join("\n  "));
  process.exit(1);
}
const { marked } = await import(pathToFileURL(markedPath).href);

// Keep in sync with PAGES in src/web/scripts/components/docs-viewer.js (order + titles).
const PAGES = [
  { slug: "overview", file: "README", title: "Overview" },
  { slug: "getting-started", title: "Getting Started" },
  { slug: "collections", title: "Collections & the Tree" },
  { slug: "requests", title: "Building Requests" },
  { slug: "authentication", title: "Authentication" },
  { slug: "variables-and-environments", title: "Variables & Environments" },
  { slug: "graphql", title: "GraphQL" },
  { slug: "websocket", title: "WebSockets" },
  { slug: "responses", title: "Reading Responses" },
  { slug: "scripting", title: "Scripts" },
  { slug: "import-export-and-backup", title: "Import, Export & Backup" },
  { slug: "settings-and-themes", title: "Settings & Themes" },
  { slug: "keyboard-shortcuts", title: "Keyboard Shortcuts" },
];

const outFile = (p) => (p.slug === "overview" ? "index.html" : `${p.slug}.html`);

function slugifyHeading(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Rewrite a Markdown-relative href for the static site.
function rewriteHref(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, anchor] = href.split("#");
  const frag = anchor ? `#${anchor}` : "";
  if (path === "../README.md") return "https://github.com/jfigge/resthippo#readme";
  const base = path.replace(/^\.\//, "");
  if (/README\.md$/i.test(base)) return `index.html${frag}`;
  if (/\.md$/i.test(base)) return `${base.replace(/\.md$/i, ".html")}${frag}`;
  return href;
}

function renderBody(md) {
  let html = marked.parse(md, { gfm: true });
  // Heading anchors (h2–h6) so cross-page #fragment links resolve.
  html = html.replace(/<h([2-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => `<h${lvl} id="${slugifyHeading(inner)}">${inner}</h${lvl}>`);
  // Rewrite .md links to .html (and README → index, project README → GitHub).
  html = html.replace(/href="([^"]+)"/g, (_m, href) => `href="${esc(rewriteHref(href))}"`);
  return html;
}

const LOGO_SVG = `<svg width="24" height="24" viewBox="0 0 512 512" role="img" aria-label="Rest Hippo"><rect width="512" height="512" rx="114" fill="#6C5CE7"/><circle cx="170" cy="146" r="40" fill="#fff"/><circle cx="342" cy="146" r="40" fill="#fff"/><rect x="144" y="140" width="224" height="190" rx="74" fill="#fff"/><rect x="118" y="260" width="276" height="150" rx="74" fill="#fff"/><circle cx="201" cy="198" r="17" fill="#6C5CE7"/><circle cx="311" cy="198" r="17" fill="#6C5CE7"/><ellipse cx="210" cy="330" rx="14" ry="20" fill="#6C5CE7"/><ellipse cx="302" cy="330" rx="14" ry="20" fill="#6C5CE7"/></svg>`;

const STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#1c1c1c;--mantle:#161616;--crust:#101010;--surface-0:#2a2a2a;--surface-1:#383838;--overlay-0:#686868;--text:#e8e8e8;--subtext:#b0b0b0;--accent:#d0d0d0;--green:#80c080}
html{scroll-behavior:smooth}
body{font-family:"Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);line-height:1.65}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:"Cascadia Code","JetBrains Mono","Fira Code",monospace;font-size:.88em;background:var(--surface-0);padding:1px 6px;border-radius:4px;color:var(--text)}
pre{background:var(--crust);border:1px solid var(--surface-0);border-radius:10px;padding:14px 16px;overflow:auto;margin:16px 0}
pre code{background:none;padding:0}
kbd{font-family:inherit;font-size:.8em;background:var(--surface-0);border:1px solid var(--surface-1);border-bottom-width:2px;border-radius:5px;padding:1px 6px}
.topbar{position:sticky;top:0;z-index:10;height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:var(--mantle);border-bottom:1px solid var(--surface-0)}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;color:var(--accent);font-size:1.1rem}
.brand:hover{text-decoration:none}
.topbar .back{color:var(--subtext);font-size:.85rem}
.layout{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:260px 1fr;gap:40px;padding:32px 24px 80px}
.sidebar{position:sticky;top:90px;align-self:start;max-height:calc(100vh - 110px);overflow:auto}
.sidebar-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--overlay-0);padding:0 12px 8px}
.doc-nav-link{display:block;padding:7px 12px;border-radius:7px;color:var(--subtext);font-size:.9rem;margin-bottom:2px}
.doc-nav-link:hover{background:var(--surface-0);color:var(--text);text-decoration:none}
.doc-nav-link--active{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-weight:600}
.content{min-width:0;max-width:760px}
.content h1{font-size:2.1rem;font-weight:800;letter-spacing:-1px;margin:0 0 20px;line-height:1.2}
.content h2{font-size:1.45rem;font-weight:700;margin:36px 0 12px;padding-top:12px;border-top:1px solid var(--surface-0)}
.content h3{font-size:1.12rem;font-weight:700;margin:26px 0 10px}
.content p,.content ul,.content ol,.content blockquote,.content table{margin:0 0 16px}
.content ul,.content ol{padding-left:24px}
.content li{margin:4px 0}
.content img{max-width:100%;height:auto;border:1px solid var(--surface-0);border-radius:10px;margin:8px 0}
.content blockquote{border-left:3px solid var(--accent);background:var(--mantle);padding:10px 16px;border-radius:0 8px 8px 0;color:var(--subtext)}
.content blockquote p:last-child{margin:0}
.content table{border-collapse:collapse;width:100%;font-size:.9rem;display:block;overflow:auto}
.content th,.content td{border:1px solid var(--surface-0);padding:8px 12px;text-align:left}
.content th{background:var(--mantle)}
.content hr{border:none;border-top:1px solid var(--surface-0);margin:28px 0}
@media(max-width:820px){.layout{grid-template-columns:1fr;gap:20px}.sidebar{position:static;max-height:none;border-bottom:1px solid var(--surface-0);padding-bottom:16px}}
`;

function page({ title, slug, body }) {
  const nav = PAGES.map((p) => {
    const cls = p.slug === slug ? "doc-nav-link doc-nav-link--active" : "doc-nav-link";
    return `        <a class="${cls}" href="${outFile(p)}">${esc(p.title)}</a>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <title>${esc(title)} · Rest Hippo Guide</title>
  <meta name="description" content="${esc(title)} — the Rest Hippo user guide." />
  <link rel="canonical" href="${SITE_URL}/docs/${outFile({ slug })}" />
  <style>${STYLE}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">${LOGO_SVG}<span>Rest Hippo</span></a>
    <a class="back" href="/">← Back to site</a>
  </header>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-title">User Guide</div>
${nav}
    </nav>
    <main class="content">
${body}
    </main>
  </div>
</body>
</html>
`;
}

// ── Build ─────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const p of PAGES) {
  const mdPath = resolve(SRC, `${p.file ?? p.slug}.md`);
  if (!existsSync(mdPath)) {
    console.warn(`! missing ${mdPath} — skipping`);
    continue;
  }
  const body = renderBody(readFileSync(mdPath, "utf8"));
  writeFileSync(resolve(OUT, outFile(p)), page({ title: p.title, slug: p.slug, body }));
}

if (existsSync(resolve(SRC, "images"))) {
  cpSync(resolve(SRC, "images"), resolve(OUT, "images"), { recursive: true });
}

// Sitemap: homepage + every guide page.
const urls = [`${SITE_URL}/`, ...PAGES.map((p) => `${SITE_URL}/docs/${outFile(p)}`)];
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
  `\n</urlset>\n`;
writeFileSync(resolve(ROOT, "website/sitemap.xml"), sitemap);

console.log(`Built ${PAGES.length} guide pages → website/docs/, copied images, wrote website/sitemap.xml`);
