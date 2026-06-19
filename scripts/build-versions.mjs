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

// Build website/versions.json from the GitHub Releases API.
//
// The static site reads this file to render its download buttons and version
// history, so download links always track real release assets (whatever they
// are named) instead of hardcoded filenames. Run in CI with GITHUB_TOKEN set,
// or locally:  GITHUB_TOKEN=$(gh auth token) node scripts/build-versions.mjs
//
// Usage: node scripts/build-versions.mjs [--repo owner/name] [--out path]
import { writeFile } from "node:fs/promises";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = arg("--repo", process.env.REPO || "jfigge/resthippo");
const out = arg("--out", "website/versions.json");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

// Classify a release asset by filename. Returns null for non-installer assets
// (electron-updater metadata: *.blockmap, latest*.yml, etc.) so they're dropped.
function classify(name) {
  const n = name.toLowerCase();
  const arch = /arm64|aarch64/.test(n) ? "arm64" : "x64"; // amd64/x86_64 -> x64
  if (n.endsWith(".dmg")) return { platform: "mac", arch, kind: "dmg", label: "Disk Image", primary: true };
  if (n.endsWith(".zip") && n.includes("mac")) return { platform: "mac", arch, kind: "zip", label: "ZIP Archive", primary: false };
  if (n.endsWith(".exe"))
    return n.includes("setup")
      ? { platform: "win", arch, kind: "setup", label: "Installer", primary: true }
      : { platform: "win", arch, kind: "portable", label: "Portable", primary: true };
  if (n.endsWith(".appimage")) return { platform: "linux", arch, kind: "appimage", label: "AppImage", primary: true };
  if (n.endsWith(".deb")) return { platform: "linux", arch, kind: "deb", label: "Debian Package", primary: true };
  return null;
}

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "resthippo-build-versions" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const raw = await gh(`/repos/${repo}/releases?per_page=100`);

const releases = raw
  .filter((r) => !r.draft)
  .map((r) => ({
    version: String(r.tag_name || "").replace(/^v/, ""),
    tag: r.tag_name,
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    prerelease: !!r.prerelease,
    url: r.html_url,
    assets: (r.assets || [])
      .map((a) => {
        const c = classify(a.name);
        return c ? { name: a.name, size: a.size, url: a.browser_download_url, ...c } : null;
      })
      .filter(Boolean),
  }));

const latest = releases.find((r) => !r.prerelease) || releases[0] || null;

const data = {
  repo,
  generatedAt: new Date().toISOString(),
  latest: latest ? latest.version : null,
  releases,
};

await writeFile(out, JSON.stringify(data, null, 2) + "\n");
console.log(`Wrote ${out}: ${releases.length} release(s), latest ${data.latest ?? "(none)"}`);
