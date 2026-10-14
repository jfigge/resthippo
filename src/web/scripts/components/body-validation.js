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
 * Format a body-validation reason for display on a validity badge.
 *
 * `errors` is the located-error array carried on the PillCodeEditor
 * `pce:validity` event (`{ line, col, length, message }`; 0 or 1 entry, since
 * the parsers stop at the first error). Returns a short, single-line reason like
 * `"3:12  Unexpected token }"` (line:col prefix when known), or `""` when there
 * is no usable message. The parser messages are technical and stay verbatim
 * (not localized), matching how the GraphQL query badge surfaces its errors.
 */
export function formatValidationReason(errors) {
  const err = Array.isArray(errors) ? errors[0] : null;
  if (!err) return "";
  const message = String(err.message ?? "").trim();
  if (!message) return "";
  return err.line ? `${err.line}:${err.col}  ${message}` : message;
}
