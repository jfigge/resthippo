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

import { shellSingleQuote as sq } from "./util.js";

/**
 * cURL target. Long-form flags (--request/--url/--header/--data/--form) so the
 * output matches common style guides and reproduces the command the Send button
 * issues. Reproduces the original TreeView.#buildCurl() byte-for-byte.
 */
export const curl = {
  id: "curl",
  label: "cURL",
  language: "bash",
  comment: "#",

  generate(model) {
    let cmd = `curl --request ${model.method}`;
    cmd += ` \\\n  --url ${sq(model.url)}`;

    for (const h of model.headers) {
      cmd += ` \\\n  --header ${sq(`${h.name}: ${h.value}`)}`;
    }

    const b = model.body;
    if (b.kind === "multipart") {
      // One --form per field; curl sets the multipart Content-Type + boundary.
      for (const f of b.fields) {
        if (f.kind === "file") {
          // curl needs an `@` prefix on the path to upload a file; without it the
          // field is sent as a literal text value (and `;type=`/`;filename=` are
          // only valid alongside `@<file>`).
          let spec = `${f.name}=@${f.file}`;
          if (f.contentType) spec += `;type=${f.contentType}`;
          if (f.filename) spec += `;filename=${f.filename}`;
          cmd += ` \\\n  --form ${sq(spec)}`;
        } else {
          cmd += ` \\\n  --form ${sq(`${f.name}=${f.value}`)}`;
        }
      }
    } else if (b.kind === "urlencoded") {
      // One --data per field; URLSearchParams gives correct, shell-safe encoding
      // (already percent-encoded — no spaces/quotes/glob chars), so no quoting.
      const sp = new URLSearchParams();
      b.fields.forEach((f) => sp.append(f.name, f.value));
      for (const pair of sp.toString().split("&").filter(Boolean)) {
        cmd += ` \\\n  --data ${pair}`;
      }
    } else if (b.kind === "file") {
      cmd += ` \\\n  --data-binary '@${b.path.replace(/'/g, "'\\''")}'`;
    } else if (b.kind === "raw") {
      cmd += ` \\\n  --data ${sq(b.text)}`;
    }

    return cmd;
  },
};
