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

import { pyString as py } from "./util.js";

/**
 * Python `requests` target. Uses requests.request(method, url, …) uniformly so
 * every HTTP method maps the same way; the library sets the form/multipart
 * Content-Type automatically when given `data=`/`files=` dicts.
 */
export const python = {
  id: "python",
  label: "Python — requests",
  language: "python",
  comment: "#",

  generate(model) {
    const lines = ["import requests", ""];
    const kwargs = [];

    if (model.headers.length) {
      const entries = model.headers
        .map((h) => `    ${py(h.name)}: ${py(h.value)},`)
        .join("\n");
      lines.push(`headers = {\n${entries}\n}`);
      kwargs.push("headers=headers");
    }

    const b = model.body;
    if (b.kind === "raw") {
      lines.push(`payload = ${py(b.text)}`);
      kwargs.push("data=payload");
    } else if (b.kind === "urlencoded") {
      const entries = b.fields
        .map((f) => `    ${py(f.name)}: ${py(f.value)},`)
        .join("\n");
      lines.push(`payload = {\n${entries}\n}`);
      kwargs.push("data=payload");
    } else if (b.kind === "multipart") {
      const text = b.fields.filter((f) => f.kind === "text");
      const files = b.fields.filter((f) => f.kind === "file");
      if (text.length) {
        const entries = text
          .map((f) => `    ${py(f.name)}: ${py(f.value)},`)
          .join("\n");
        lines.push(`data = {\n${entries}\n}`);
        kwargs.push("data=data");
      }
      if (files.length) {
        const entries = files
          .map((f) => {
            const parts = [py(f.filename || ""), `open(${py(f.file)}, "rb")`];
            if (f.contentType) parts.push(py(f.contentType));
            return `    ${py(f.name)}: (${parts.join(", ")}),`;
          })
          .join("\n");
        lines.push(`files = {\n${entries}\n}`);
        kwargs.push("files=files");
      }
    } else if (b.kind === "file") {
      lines.push(`payload = open(${py(b.path)}, "rb")`);
      kwargs.push("data=payload");
    }

    lines.push("");
    const args = [py(model.method), py(model.url), ...kwargs].join(", ");
    lines.push(`response = requests.request(${args})`);
    lines.push("print(response.text)");
    return lines.join("\n");
  },
};
