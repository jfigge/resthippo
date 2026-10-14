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

// Refresh electron-updater metadata after an out-of-band signer rewrote the
// installer bytes.
//
// Why this exists: SignPath signs the Windows .exe AFTER electron-builder has
// already hashed it into latest.yml (and emitted the differential-download
// *.blockmap sidecars). Signing changes the bytes, so latest.yml's sha512/size
// no longer match the shipped file and electron-updater
// (electron-updater auto-update) rejects every release with a checksum
// mismatch. This script recomputes the base64 SHA-512 + byte size for each file
// referenced in the update manifest(s) and deletes the now-stale blockmaps —
// electron-updater simply falls back to a full download when a blockmap is
// absent.
//
// Dependency-free on purpose (Node builtins only) and a line-oriented rewrite,
// not a YAML round-trip, so it can't reorder/normalize electron-builder's
// manifest or pull in a parser.
//
// Usage: node scripts/resign-update-metadata.mjs [distDir]   (default build/src/dist)

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const distDir = process.argv[2] || "build/src/dist";

// electron-builder writes one manifest per platform on its native runner; on the
// Windows runner that's latest.yml. The others are handled defensively in case
// this is ever pointed at a combined directory.
const MANIFESTS = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];

const sha512Base64 = (file) =>
  createHash("sha512").update(readFileSync(file)).digest("base64");

// Recompute sha512/size for every file the manifest references and drop the
// blockMapSize hints (their sidecar files are deleted below). Returns false when
// the manifest isn't present.
function rewriteManifest(manifestPath) {
  if (!existsSync(manifestPath)) return false;

  const lines = readFileSync(manifestPath, "utf8").split(/\r?\n/);
  let current = null; // on-disk path the following indented sha512/size describe
  const out = [];

  for (const line of lines) {
    // Stale differential-download hint — the matching *.blockmap is removed, so
    // force a full download by dropping the line entirely.
    if (/^\s*blockMapSize:\s*/.test(line)) continue;

    // A `- url: NAME` entry (files list) or the top-level `path: NAME` selects
    // the file whose hash/size the subsequent indented lines describe.
    const ref = line.match(/^\s*(?:-\s*url|path):\s*(.+?)\s*$/);
    if (ref) {
      const name = basename(ref[1].replace(/^['"]|['"]$/g, ""));
      const p = join(distDir, name);
      current = existsSync(p) ? p : null;
      if (!current) {
        console.warn(
          `resign: ${name} referenced in ${basename(manifestPath)} not found in ${distDir} — left untouched`,
        );
      }
      out.push(line);
      continue;
    }

    if (current) {
      const sha = line.match(/^(\s*)sha512:\s*/);
      if (sha) {
        out.push(`${sha[1]}sha512: ${sha512Base64(current)}`);
        continue;
      }
      const sz = line.match(/^(\s*)size:\s*/);
      if (sz) {
        out.push(`${sz[1]}size: ${statSync(current).size}`);
        continue;
      }
    }

    out.push(line);
  }

  writeFileSync(manifestPath, out.join("\n"));
  console.log(`resign: rewrote ${basename(manifestPath)}`);
  return true;
}

if (!existsSync(distDir)) {
  console.error(`resign: dist directory ${distDir} does not exist`);
  process.exit(1);
}

let rewrote = 0;
for (const name of MANIFESTS) {
  if (rewriteManifest(join(distDir, name))) rewrote++;
}
if (rewrote === 0) {
  console.warn(`resign: no update manifest found in ${distDir} — nothing to refresh`);
}

for (const f of readdirSync(distDir)) {
  if (f.endsWith(".blockmap")) {
    unlinkSync(join(distDir, f));
    console.log(`resign: removed stale ${f}`);
  }
}
