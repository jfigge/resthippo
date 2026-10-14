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
