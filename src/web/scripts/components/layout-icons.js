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
