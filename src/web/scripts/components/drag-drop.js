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

/**
 * drag-drop.js — pure drop-position logic for the collections tree.
 *
 * Extracted verbatim (behaviour-preserving) from TreeView's `dragover` handler
 * so the geometry-free decision — given a vertical ratio over a row, do we drop
 * before / after / inside it — is unit-testable without a layout engine. The
 * caller measures the row rect and supplies the ratio; this module owns only the
 * decision. See drag-drop.test.js for the truth table, and the e2e geometry
 * harness for the ratio-from-real-rect half jsdom can't exercise.
 */
"use strict";

/**
 * Decide where a drag should drop relative to a hovered row.
 *
 * @param {number} ratio   Vertical cursor position within the row, 0 (top) → 1
 *                          (bottom): `(clientY - rect.top) / rect.height`.
 * @param {string} nodeType  The hovered node's type ("collection" | "request").
 * @param {boolean} isOpen    Whether the hovered collection is expanded (only
 *                            consulted when dragging a collection onto a
 *                            collection).
 * @param {boolean} draggedIsCollection  Whether the dragged node is a collection.
 * @returns {"before"|"after"|"inside"} drop position relative to the row.
 */
export function computeDropPos(ratio, nodeType, isOpen, draggedIsCollection) {
  if (nodeType === "collection") {
    if (draggedIsCollection) {
      // Dragging a folder onto another folder: the target's open/closed state —
      // not the cursor depth — decides whether we nest or stay at the same
      // level. A thin top zone still allows dropping *before* the target.
      //   • open target   → drop *inside* it (as the first child)
      //   • closed target → drop *after* it, a sibling at the same level
      if (isOpen) {
        return ratio < 0.25 ? "before" : "inside";
      }
      return ratio < 0.5 ? "before" : "after";
    }
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "inside";
  }
  return ratio < 0.5 ? "before" : "after";
}
