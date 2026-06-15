"use strict";

import { goString as go } from "./util.js";

/**
 * Go `net/http` target. Builds a runnable `package main` program; the import
 * block is assembled from exactly the packages each body kind needs (strings /
 * net/url / bytes+mime/multipart / os) so the snippet compiles as-is.
 */
export const golang = {
  id: "go",
  label: "Go — net/http",
  language: "go",
  comment: "//",

  generate(model) {
    const imports = new Set(["fmt", "io", "net/http"]);
    const body = model.body;
    const lines = []; // func-body lines, each already tab-indented
    let payloadExpr = "nil";

    if (body.kind === "raw") {
      imports.add("strings");
      lines.push(`\tpayload := strings.NewReader(${go(body.text)})`);
      payloadExpr = "payload";
    } else if (body.kind === "urlencoded") {
      imports.add("net/url");
      imports.add("strings");
      lines.push("\tform := url.Values{}");
      for (const f of body.fields) {
        lines.push(`\tform.Set(${go(f.name)}, ${go(f.value)})`);
      }
      lines.push("\tpayload := strings.NewReader(form.Encode())");
      payloadExpr = "payload";
    } else if (body.kind === "multipart") {
      imports.add("bytes");
      imports.add("mime/multipart");
      lines.push("\tbuf := &bytes.Buffer{}");
      lines.push("\twriter := multipart.NewWriter(buf)");
      for (const f of body.fields) {
        if (f.kind === "file") {
          imports.add("os");
          // Only pull in path/filepath when we actually derive the upload name
          // from the path — importing it unused would fail to compile.
          let fname;
          if (f.filename) {
            fname = go(f.filename);
          } else {
            imports.add("path/filepath");
            fname = `filepath.Base(${go(f.file)})`;
          }
          lines.push("\t{");
          lines.push(`\t\tfile, _ := os.Open(${go(f.file)})`);
          lines.push("\t\tdefer file.Close()");
          lines.push(
            `\t\tpart, _ := writer.CreateFormFile(${go(f.name)}, ${fname})`,
          );
          lines.push("\t\tio.Copy(part, file)");
          lines.push("\t}");
        } else {
          lines.push(`\twriter.WriteField(${go(f.name)}, ${go(f.value)})`);
        }
      }
      lines.push("\twriter.Close()");
      payloadExpr = "buf";
    } else if (body.kind === "file") {
      imports.add("os");
      lines.push(`\tpayload, _ := os.Open(${go(body.path)})`);
      lines.push("\tdefer payload.Close()");
      payloadExpr = "payload";
    }

    lines.push(
      `\treq, _ := http.NewRequest(${go(model.method)}, url, ${payloadExpr})`,
    );
    for (const h of model.headers) {
      lines.push(`\treq.Header.Add(${go(h.name)}, ${go(h.value)})`);
    }
    if (body.kind === "multipart") {
      lines.push(
        '\treq.Header.Set("Content-Type", writer.FormDataContentType())',
      );
    }

    const importBlock = [...imports]
      .sort()
      .map((i) => `\t${JSON.stringify(i)}`)
      .join("\n");

    return [
      "package main",
      "",
      "import (",
      importBlock,
      ")",
      "",
      "func main() {",
      `\turl := ${go(model.url)}`,
      ...lines,
      "\tres, _ := http.DefaultClient.Do(req)",
      "\tdefer res.Body.Close()",
      "\tbody, _ := io.ReadAll(res.Body)",
      "\tfmt.Println(string(body))",
      "}",
    ].join("\n");
  },
};
