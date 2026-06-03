/**
 * tests/request-editor.test.js
 *
 * Payload-coverage tests for the real RequestEditor. Each case loads a request
 * (the editor's public "selected" entry point), clicks the real Send button, and
 * captures the `wurl:send-request` descriptor the editor builds — asserting that
 * params, the various body types, and the static auth transforms all reach the
 * wire correctly.
 *
 * This complements renderer-e2e.test.js (which proves the full cycle for one
 * request) by sweeping the editor's load()/gather/build branches that a single
 * end-to-end path never touches. No IPC is needed: the editor dispatches
 * `wurl:send-request` after building the payload, so the test only listens.
 *
 * Run with:   node --test tests/request-editor.test.js
 */

"use strict";

// MUST precede the component import (the Prism bundle reads `Element` on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { RequestEditor } from "../components/request-editor.js";

/**
 * Fresh DOM + editor; load `node`, click Send, and resolve the captured
 * `wurl:send-request` descriptor (or reject if the editor never dispatches).
 */
async function sendAndCapture(node) {
  const window = resetDom();
  window.wurl = { isElectron: false };

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ envVariables: {}, folderChain: [] });
  editor.load(node);

  const captured = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("editor never dispatched wurl:send-request")),
      1000,
    );
    window.addEventListener("wurl:send-request", (e) => {
      clearTimeout(timer);
      resolve(e.detail);
    });
  });

  editor.element.querySelector('[aria-label="Send request"]').click();
  return captured;
}

test("query params are appended to the URL, disabled rows skipped", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://api.example.com/search",
    params: [
      { name: "q", value: "a b", enabled: true },
      { name: "skip", value: "no", enabled: false },
      { name: "page", value: "2", enabled: true },
    ],
  });
  assert.equal(detail.url, "https://api.example.com/search?q=a%20b&page=2");
});

test("form-urlencoded body is encoded with the right Content-Type", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "POST",
    url: "https://x",
    bodyType: "form-urlencoded",
    bodyFormRows: [
      { name: "a", value: "1 2", enabled: true },
      { name: "b", value: "y&z", enabled: true },
    ],
  });
  assert.equal(detail.body, "a=1+2&b=y%26z");
  assert.equal(
    detail.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
});

test("form-data body produces a multipart Content-Type and parts", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "POST",
    url: "https://x",
    bodyType: "form-data",
    bodyFormRows: [{ name: "field", value: "val", enabled: true }],
  });
  assert.match(
    detail.headers["Content-Type"],
    /^multipart\/form-data; boundary=/,
  );
  assert.match(detail.body, /name="field"/);
});

test("basic auth builds a base64 Authorization header", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: true,
    authType: "basic",
    authBasic: { username: "alice", password: "hunter2" },
  });
  assert.equal(
    detail.headers["Authorization"],
    `Basic ${btoa("alice:hunter2")}`,
  );
});

test("bearer auth builds a Bearer Authorization header", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: true,
    authType: "bearer",
    authBearer: { token: "tok-123" },
  });
  assert.equal(detail.headers["Authorization"], "Bearer tok-123");
});

test("api-key auth in query placement appends to the URL, not the headers", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: true,
    authType: "apikey",
    authApiKey: { name: "api_key", value: "k 1", addTo: "query" },
  });
  assert.equal(detail.headers["api_key"], undefined);
  // The editor normalises the base URL via encodeBaseUrl(), so a bare host gains
  // a trailing slash before the api-key query param is appended.
  assert.equal(detail.url, "https://x/?api_key=k%201");
});

test("a GET request carries no body even if a body type is set", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    bodyType: "json",
    bodyText: '{"a":1}',
  });
  assert.equal(detail.body, null);
  assert.equal(detail.headers["Content-Type"], undefined);
});

test("disabled auth contributes no Authorization header", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: false,
    authType: "basic",
    authBasic: { username: "u", password: "p" },
  });
  assert.equal(detail.headers["Authorization"], undefined);
});
