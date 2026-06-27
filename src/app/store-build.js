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
