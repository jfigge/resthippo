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
