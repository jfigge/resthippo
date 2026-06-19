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

import { jsString as js } from "./util.js";

/**
 * JavaScript `fetch` target. Emits modern async/await using the platform fetch
 * API (browsers, Deno, Node 18+). File-bearing bodies can't reference a
 * filesystem path from a browser, so those fields are emitted as commented
 * placeholders the user wires to a File/Blob.
 */
export const fetchJs = {
  id: "fetch",
  label: "JavaScript — fetch",
  language: "javascript",
  comment: "//",

  generate(model) {
    const pre = []; // statements before the fetch() call (FormData setup, …)
    const opts = [`  method: ${js(model.method)},`];

    if (model.headers.length) {
      const entries = model.headers
        .map((h) => `    ${js(h.name)}: ${js(h.value)},`)
        .join("\n");
      opts.push(`  headers: {\n${entries}\n  },`);
    }

    const b = model.body;
    if (b.kind === "raw") {
      opts.push(`  body: ${js(b.text)},`);
    } else if (b.kind === "urlencoded") {
      const entries = b.fields
        .map((f) => `    ${js(f.name)}: ${js(f.value)},`)
        .join("\n");
      opts.push(`  body: new URLSearchParams({\n${entries}\n  }),`);
    } else if (b.kind === "multipart") {
      pre.push("const form = new FormData();");
      for (const f of b.fields) {
        if (f.kind === "file") {
          pre.push(
            `// Attach a File/Blob for ${js(f.name)} (a browser can't read ${js(f.file)} by path):`,
          );
          pre.push(`// form.append(${js(f.name)}, fileInput.files[0]);`);
        } else {
          pre.push(`form.append(${js(f.name)}, ${js(f.value)});`);
        }
      }
      opts.push("  body: form,");
    } else if (b.kind === "file") {
      pre.push(
        `// Supply a File/Blob as the body (a browser can't read ${js(b.path)} by path):`,
      );
      opts.push("  body: fileBlob,");
    }

    const preBlock = pre.length ? pre.join("\n") + "\n\n" : "";
    return (
      `${preBlock}const response = await fetch(${js(model.url)}, {\n` +
      `${opts.join("\n")}\n` +
      `});\n` +
      `const data = await response.text();\n` +
      `console.log(data);`
    );
  },
};
