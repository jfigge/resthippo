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
 * components/command/availability.js — can this build run Command requests
 * (Feature 70)? Only the desktop app, and never the Mac App Store build (its
 * sandbox blocks spawning arbitrary processes — the feature is hidden there
 * entirely, not greyed out). The single gate shared by the tree, Settings and
 * the command editor.
 */

"use strict";

/** @returns {boolean} */
export function commandsAvailable() {
  const h = globalThis.window?.hippo;
  return h?.isElectron === true && h?.isMas !== true;
}
