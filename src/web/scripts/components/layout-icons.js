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

"use strict";

/**
 * layout-icons.js — Panel-layout arrangement glyphs
 *
 * The four `LAYOUT_ICONS` SVGs visualise the available panel arrangements
 * (1–4). They are shared rather than inlined so the Settings → Appearance
 * layout picker draws exactly the same glyphs the app uses elsewhere.
 *
 * Each glyph uses fill="currentColor" with three fill-opacity levels marking
 * the three panels — nav 0.38 · request 0.72 · response 0.52 — so a single
 * `color` (e.g. the accent on the selected option) tints the whole icon.
 */

const _NAV = `fill-opacity="0.38"`;
const _REQ = `fill-opacity="0.72"`;
const _RES = `fill-opacity="0.52"`;

export const LAYOUT_ICONS = {
  // 1 — three equal columns: [nav | request | response]
  1: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0"  y="0" width="7"  height="20" rx="1" ${_NAV}/>
        <rect x="9"  y="0" width="9"  height="20" rx="1" ${_REQ}/>
        <rect x="20" y="0" width="8"  height="20" rx="1" ${_RES}/>
      </svg>`,

  // 2 — nav full-height left; request top-right / response bottom-right
  2: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0" y="0"  width="7"  height="20" rx="1" ${_NAV}/>
        <rect x="9" y="0"  width="19" height="9"  rx="1" ${_REQ}/>
        <rect x="9" y="11" width="19" height="9"  rx="1" ${_RES}/>
      </svg>`,

  // 3 — nav + request side-by-side top; response full width bottom
  3: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0"  y="0"  width="11" height="9" rx="1" ${_NAV}/>
        <rect x="13" y="0"  width="15" height="9" rx="1" ${_REQ}/>
        <rect x="0"  y="11" width="28" height="9" rx="1" ${_RES}/>
      </svg>`,

  // 4 — all three panels stacked top to bottom
  4: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0" y="0"  width="28" height="5" rx="1" ${_NAV}/>
        <rect x="0" y="7"  width="28" height="6" rx="1" ${_REQ}/>
        <rect x="0" y="15" width="28" height="5" rx="1" ${_RES}/>
      </svg>`,
};
