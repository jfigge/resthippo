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

import { buildRequestModel } from "./request-model.js";
import { curl } from "./curl.js";
import { fetchJs } from "./fetch.js";
import { python } from "./python.js";
import { golang } from "./go.js";
import { httpie } from "./httpie.js";

/**
 * code-gen/index.js — the code-generation registry.
 *
 * Adding a language is a localized change: write a `<lang>.js` exporting a
 * descriptor `{ id, label, language, comment, generate(model) }` and append it
 * to `TARGETS` below. `generate` receives the normalized model from
 * `buildRequestModel` (see ./request-model.js) and returns the snippet string;
 * `language` is the Prism grammar id used to highlight it; `comment` is the
 * line-comment token used to render any model `notes` as leading comments.
 */

export { buildRequestModel };

/** Ordered list of code-generation targets (first is the default / cURL). */
export const TARGETS = [curl, fetchJs, python, golang, httpie];

const BY_ID = new Map(TARGETS.map((target) => [target.id, target]));

/**
 * Generate a code snippet for one target from a normalized request model.
 * Unknown ids fall back to cURL. Model `notes` (e.g. the AWS SigV4 caveat) are
 * prepended as the target's line comments.
 * @param {string} targetId
 * @param {object} model  output of buildRequestModel()
 * @returns {string}
 */
export function generateCode(targetId, model) {
  const target = BY_ID.get(targetId) ?? curl;
  const notes = model.notes ?? [];
  const noteBlock = notes.length
    ? notes.map((n) => `${target.comment} ${n}`).join("\n") + "\n\n"
    : "";
  return noteBlock + target.generate(model);
}
