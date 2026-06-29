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
