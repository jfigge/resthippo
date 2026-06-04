/**
 * tests/response-viewer.test.js
 *
 * Rendering-coverage tests for the real ResponseViewer, driven directly through
 * the window events it subscribes to (`wurl:response-received`,
 * `wurl:request-loading`, `wurl:request-error`) under jsdom — no editor, no IPC,
 * no network. Where renderer-e2e.test.js proves the request→response *spine*,
 * this sweeps the viewer's content-type, status, error, loading, and cookie
 * render branches that a single end-to-end path never reaches.
 *
 * Run with:   node --test tests/response-viewer.test.js
 */

"use strict";

// MUST precede the component import (the Prism bundle reads `Element` on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ResponseViewer } from "../components/response-viewer.js";

/** Fresh DOM + viewer + a dev-mode window.wurl for each case. */
function mountViewer() {
  const window = resetDom();
  window.wurl = { isElectron: false };
  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);
  return { window, viewer };
}

/** Dispatch a response and let any deferred (rAF/microtask) render settle. */
async function showResponse(window, detail) {
  window.dispatchEvent(
    new window.CustomEvent("wurl:response-received", { detail }),
  );
  await new Promise((r) => setTimeout(r, 10));
}

const baseResponse = (overrides) => ({
  request: { method: "GET", url: "http://x" },
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  cookies: [],
  body: "",
  elapsed: 5,
  size: 0,
  consoleLog: [],
  ...overrides,
});

test("renders a JSON response: status line, headers, and body", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "application/json", "x-id": "req-9" },
      body: '{"name":"Ada"}',
    }),
  );

  assert.ok(
    viewer.element
      .querySelector(".res-status-badge")
      .textContent.includes("200"),
  );
  assert.ok(
    viewer.element.querySelector(".res-status-text").textContent.includes("OK"),
  );
  const headers = viewer.element.querySelector("#res-tab-headers");
  assert.match(headers.textContent, /x-id/i);
  assert.ok(headers.textContent.includes("req-9"));
  assert.ok(
    viewer.element.querySelector("#res-tab-body").textContent.includes("Ada"),
  );
});

test("renders an XML response through the XML pretty-printer", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "application/xml" },
      body: "<note><to>Tove</to><from>Jani</from></note>",
    }),
  );
  const body = viewer.element.querySelector("#res-tab-body").textContent;
  // Tag names and text survive pretty-printing + highlighting.
  assert.ok(body.includes("note"));
  assert.ok(body.includes("Tove"));
  assert.ok(body.includes("Jani"));
});

test("renders a plain-text response verbatim", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "text/plain" },
      body: "just some plain text",
    }),
  );
  assert.ok(
    viewer.element
      .querySelector("#res-tab-body")
      .textContent.includes("just some plain text"),
  );
});

test("renders a 4xx status with its status text", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "application/json" },
      body: '{"error":"missing"}',
    }),
  );
  assert.ok(
    viewer.element
      .querySelector(".res-status-badge")
      .textContent.includes("404"),
  );
  assert.ok(
    viewer.element
      .querySelector(".res-status-text")
      .textContent.includes("Not Found"),
  );
});

test("renders response cookies into the cookies pane", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      cookies: ["sid=abc123; HttpOnly; Path=/"],
      body: "{}",
    }),
  );
  const cookies = viewer.element.querySelector("#res-tab-cookies").textContent;
  assert.ok(cookies.includes("sid"), "cookie name rendered");
  assert.ok(cookies.includes("abc123"), "cookie value rendered");
  assert.ok(cookies.includes("HttpOnly"), "cookie attribute rendered");
});

test("shows a loading placeholder on wurl:request-loading", async () => {
  const { window, viewer } = mountViewer();
  window.dispatchEvent(new window.CustomEvent("wurl:request-loading"));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(
    viewer.element.querySelector("#res-tab-body").textContent,
    /Sending request/i,
  );
});

test("renders a transport error with message, hint, and console log", async () => {
  const { window, viewer } = mountViewer();
  window.dispatchEvent(
    new window.CustomEvent("wurl:request-error", {
      detail: {
        request: { method: "GET", url: "http://down" },
        name: "FetchError",
        message: "ECONNREFUSED",
        hint: "The server is unreachable.",
        elapsed: 0,
        consoleLog: ["* FetchError: ECONNREFUSED"],
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));

  const text = viewer.element.textContent;
  assert.ok(text.includes("ECONNREFUSED"), "error message rendered");
  assert.ok(text.includes("The server is unreachable."), "hint rendered");
  // No-status transport failures show the error badge.
  assert.match(
    viewer.element.querySelector(".res-status-badge").textContent,
    /ERR/,
  );
  assert.match(
    viewer.element.querySelector("#res-tab-console").textContent,
    /ECONNREFUSED/,
  );
});

test("applySettings raw mode still renders the body content", async () => {
  const { window, viewer } = mountViewer();
  viewer.applySettings({
    responseBodyRenderMode: "raw",
    wrapResponseText: false,
  });
  await showResponse(window, baseResponse({ body: '{"k":"raw-mode-value"}' }));
  assert.ok(
    viewer.element
      .querySelector("#res-tab-body")
      .textContent.includes("raw-mode-value"),
  );
});

// ── Binary responses (images / PDF / hex) ─────────────────────────────────────

// "Hello" → base64; reused across the binary cases.
const HELLO_B64 = "SGVsbG8=";

test("renders an image/png response as an inline <img>", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "image/png" },
      body: HELLO_B64,
      encoding: "base64",
      size: 5,
    }),
  );

  const img = viewer.element.querySelector("img.res-body-image");
  assert.ok(img, "an <img> preview is rendered");
  assert.ok(img.getAttribute("src"), "the image has a (blob:) src");
  // No garbled text body for an image.
  assert.equal(viewer.element.querySelector(".res-hex-dump"), null);
});

test("renders an octet-stream response as a hex + ASCII dump with intact bytes", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "application/octet-stream" },
      body: HELLO_B64,
      encoding: "base64",
      size: 5,
    }),
  );

  const dump = viewer.element.querySelector(".res-hex-dump");
  assert.ok(dump, "a hex dump is rendered");
  const text = dump.textContent;
  assert.ok(text.includes("00000000"), "row offset is shown");
  assert.ok(text.includes("48 65 6c 6c 6f"), "bytes are the real H-e-l-l-o");
  assert.ok(text.includes("|Hello|"), "ASCII gutter shows the decoded bytes");
});

test("a text/plain response is unaffected by the binary path", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "text/plain" },
      body: "just text",
      // no `encoding` — text path
    }),
  );

  assert.equal(viewer.element.querySelector("img.res-body-image"), null);
  assert.equal(viewer.element.querySelector(".res-hex-dump"), null);
  assert.ok(
    viewer.element
      .querySelector("#res-tab-body")
      .textContent.includes("just text"),
  );
});

test("a PDF response in dev mode offers a save fallback (no native overlay)", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "application/pdf" },
      body: HELLO_B64,
      encoding: "base64",
      size: 5,
    }),
  );

  assert.equal(
    viewer.element.querySelector(".res-pdf-host"),
    null,
    "no native overlay host in dev mode",
  );
  assert.match(
    viewer.element.querySelector("#res-tab-body").textContent,
    /desktop app/,
  );
});

// Right-click the Body tab and pick a context-menu item by its id. The viewer's
// menu delegates to window.wurl.ui.contextMenu, so the mock returns the choice.
async function pickBodyMenu(window, viewer, id) {
  window.wurl.ui = { contextMenu: async () => id };
  const bodyTab = viewer.element.querySelector('.res-tab-btn[data-tab="body"]');
  bodyTab.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 10));
}

test("the Hex render mode shows a hex dump for an image, replacing the preview", async () => {
  const { window, viewer } = mountViewer();
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "image/png" },
      body: HELLO_B64,
      encoding: "base64",
      size: 5,
    }),
  );
  assert.ok(viewer.element.querySelector("img.res-body-image"));

  await pickBodyMenu(window, viewer, "hex");

  assert.ok(
    viewer.element.querySelector(".res-hex-dump"),
    "hex dump is shown after choosing Hex",
  );
  assert.equal(viewer.element.querySelector("img.res-body-image"), null);
});

test("the Hex render mode dumps the bytes of a text (non-binary) response", async () => {
  const { window, viewer } = mountViewer();
  viewer.applySettings({ responseBodyRenderMode: "hex" });
  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "application/json" },
      body: "Hello",
    }),
  );

  const dump = viewer.element.querySelector(".res-hex-dump");
  assert.ok(dump, "a hex dump is rendered for a text body");
  assert.ok(dump.textContent.includes("48 65 6c 6c 6f"), "bytes are H-e-l-l-o");
  assert.ok(
    dump.textContent.includes("|Hello|"),
    "ASCII gutter shows the text",
  );
});

test("Download sends base64 bodies with base64 encoding and a typed name", async () => {
  const { window, viewer } = mountViewer();
  let captured = null;
  window.wurl.export = {
    saveFile: (filename, content, filters, encoding) => {
      captured = { filename, content, filters, encoding };
      return Promise.resolve(true);
    },
  };

  await showResponse(
    window,
    baseResponse({
      headers: { "content-type": "image/png" },
      body: HELLO_B64,
      encoding: "base64",
      size: 5,
      request: { method: "GET", url: "http://x/avatar" },
    }),
  );

  await pickBodyMenu(window, viewer, "download");

  assert.ok(captured, "export.saveFile was invoked");
  assert.equal(captured.encoding, "base64", "bytes are written, not UTF-8");
  assert.match(
    captured.filename,
    /\.png$/,
    "filename uses the image extension",
  );
  assert.equal(captured.content, HELLO_B64, "the raw base64 body is forwarded");
});
