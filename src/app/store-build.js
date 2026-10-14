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

// store-build.js — single source of truth for "is this a sandboxed store build?".
//
// Rest Hippo ships ONE codebase to every channel: the direct GitHub-release
// builds (DMG/ZIP, NSIS/portable, AppImage/deb) AND the Mac App Store (MAS) and
// Microsoft Store (MSIX/appx) builds. The store builds run under tighter
// sandbox/policy rules, so a handful of features must be disabled there. Rather
// than branch the build, every store-incompatible feature gates on the helpers
// below at runtime.
//
// Electron sets these globals for us — we never set them ourselves:
//   • process.mas          true in a Mac App Store build (sandboxed MAS Electron).
//   • process.windowsStore true in an appx/MSIX build (full-trust Desktop Bridge).
//
// Gate scopes (see also CLAUDE.md / STORE-PUBLISHING.md):
//   • isStoreBuild() — disable the self-updater (both stores deliver their own
//     updates) and the `hippo` CLI launcher (MAS can't write outside the
//     container; MSIX virtualizes the PATH so the shim never lands for real).
//   • isMas()        — additionally disable re-reading persisted mTLS cert file
//     paths and statting arbitrary cURL-import paths (the macOS App Sandbox
//     blocks re-reading user files without a security-scoped bookmark). MSIX is
//     full-trust, so those stay enabled there.
"use strict";

/** True in a Mac App Store (sandboxed) build. */
function isMas() {
  return process.mas === true;
}

/** True in a Microsoft Store (appx/MSIX) build. */
function isAppx() {
  return process.windowsStore === true;
}

/** True in any store build (Mac App Store OR Microsoft Store). */
function isStoreBuild() {
  return isMas() || isAppx();
}

/**
 * Distribution flavor, surfaced in the About panel / diagnostics so a bug report
 * records which channel produced the build.
 * @returns {"store" | "direct"}
 */
function distribution() {
  return isStoreBuild() ? "store" : "direct";
}

module.exports = { isMas, isAppx, isStoreBuild, distribution };
