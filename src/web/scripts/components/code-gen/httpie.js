"use strict";

import { shellSingleQuote as sq } from "./util.js";

/**
 * HTTPie CLI target. Headers are `Name:value` args; form/multipart bodies use
 * `--form` with `field=value` (and `field@path` for files). Raw bodies are
 * piped in on stdin and a binary file body is redirected from the file, since
 * HTTPie's request-item syntax only models structured fields.
 */
export const httpie = {
  id: "httpie",
  label: "HTTPie",
  language: "bash",
  comment: "#",

  generate(model) {
    const b = model.body;

    // For form/multipart bodies HTTPie sets the Content-Type itself, so drop a
    // user-supplied one to avoid a conflicting header.
    const headerArgs = model.headers
      .filter(
        (h) => b.kind === "raw" || h.name.toLowerCase() !== "content-type",
      )
      .map((h) => sq(`${h.name}:${h.value}`));

    const head = (...rest) =>
      ["http", model.method, sq(model.url), ...headerArgs, ...rest].join(" ");

    if (b.kind === "raw") {
      return `printf %s ${sq(b.text)} | ${head()}`;
    }
    if (b.kind === "urlencoded" || b.kind === "multipart") {
      const fields = b.fields.map((f) =>
        f.kind === "file"
          ? sq(`${f.name}@${f.file}`)
          : sq(`${f.name}=${f.value}`),
      );
      return [
        "http",
        "--form",
        model.method,
        sq(model.url),
        ...headerArgs,
        ...fields,
      ].join(" ");
    }
    if (b.kind === "file") {
      return `${head()} < ${sq(b.path)}`;
    }
    return head();
  },
};
