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
