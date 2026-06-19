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

/**
 * tests/renderer-e2e.test.js
 *
 * End-to-end test of the renderer's core request→response cycle, run headlessly
 * under `node --test` with jsdom and a mocked IPC surface — no real network and
 * no running Electron main process.
 *
 * It wires the two real components that bracket the cycle:
 *
 *     RequestEditor  ──(hippo:send-request)──►  [bridge]  ──window.hippo.http.execute──►  (mock)
 *          ▲                                                                               │
 *          │            (hippo:response-received  |  hippo:request-error)                    ▼
 *     ResponseViewer  ◄───────────────────────────────────────────────────────────────────
 *
 * The [bridge] in the middle mirrors the documented contract of app.js's
 * `hippo:send-request` handler (app.js:1554): it assembles the native descriptor,
 * calls the (mocked) `window.hippo.http.execute` IPC channel, and routes the
 * outcome down the same two branches app.js uses — an HTTP response re-dispatches
 * as `hippo:response-received`, while a transport failure (status 0 + error)
 * re-dispatches as `hippo:request-error`. app.js itself is a monolithic
 * DOMContentLoaded bootstrap that cannot be imported in isolation, so the bridge
 * is reproduced here at exactly the seam the editor and viewer agree on. The two
 * components on either side are the real production classes.
 *
 * What this pins down:
 *   • editing method / URL / headers / body in the real RequestEditor produces
 *     the correct wire payload, and that payload reaches the mocked IPC intact;
 *   • feeding a mock HTTP response back through the bridge makes the real
 *     ResponseViewer render the status line, headers, and body;
 *   • a transport failure routes to the error branch and renders an error
 *     instead of a response.
 *
 * Run with:   node --test tests/renderer-e2e.test.js
 */

"use strict";

// MUST come first: installs the jsdom globals the component modules (and the
// Prism bundle they import) need at evaluation time.
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { RequestEditor } from "../components/request-editor.js";
import { ResponseViewer } from "../components/response-viewer.js";

/**
 * Install the app.js request→response bridge.
 *
 * Mirrors app.js:1554 in full — listens for the editor's `hippo:send-request`,
 * builds the native descriptor app.js would build, hands it to the mocked IPC
 * channel, and routes the outcome down the SAME two branches app.js uses: a
 * transport failure (`status === 0` with an `error`) re-emits as
 * `hippo:request-error`, while any HTTP response re-emits as
 * `hippo:response-received`. Reproducing both branches in one place keeps this a
 * faithful stand-in for the (un-importable) bootstrap handler rather than a
 * happy-path-only shim.
 *
 * @param {Window} window    the active jsdom window (fresh per test)
 * @param {object} settings  the subset of app settings the descriptor reads
 * @returns {{ executed: object[] }}  records every nativeDesc sent to the IPC mock
 */
function installBridge(window, settings = {}) {
  const executed = [];
  window.addEventListener("hippo:send-request", async (e) => {
    const d = e.detail;
    const nativeDesc = {
      method: d.method,
      url: d.url,
      headers: d.headers ?? {},
      body: typeof d.body === "string" ? d.body : null,
      bodyFilePath: d.bodyFilePath ?? null,
      timeout: settings.timeout ?? 30000,
      followRedirects: settings.followRedirects ?? true,
      verifySsl: settings.verifySsl ?? true,
      awsIam: d.awsIam ?? null,
      authDigest: d.authDigest ?? null,
      authNtlm: d.authNtlm ?? null,
    };
    executed.push(nativeDesc);

    const result = await window.hippo.http.execute(nativeDesc);
    const request = {
      method: nativeDesc.method,
      url: nativeDesc.url,
      headers: nativeDesc.headers,
      body: nativeDesc.body,
    };

    if (result.error && result.status === 0) {
      // Transport-level failure — no HTTP response was received.
      window.dispatchEvent(
        new window.CustomEvent("hippo:request-error", {
          detail: {
            request,
            name: result.error.name,
            message: result.error.message,
            hint: "Connection failed.",
            elapsed: result.elapsed ?? 0,
            consoleLog: result.consoleLog ?? [],
          },
        }),
      );
    } else {
      // An HTTP response (any status code, including 4xx / 5xx).
      window.dispatchEvent(
        new window.CustomEvent("hippo:response-received", {
          detail: {
            request,
            status: result.status,
            statusText: result.statusText,
            headers: result.headers ?? {},
            cookies: result.cookies ?? [],
            body: result.body ?? "",
            elapsed: result.elapsed ?? 0,
            size: result.size ?? 0,
            consoleLog: result.consoleLog ?? [],
            // "base64" marks a binary body; the viewer decodes it back to raw
            // bytes. app.js forwards this same field (app.js:1691) — the bridge
            // must too, or binary responses silently degrade to the text path.
            encoding: result.encoding ?? "utf8",
          },
        }),
      );
    }
  });
  return { executed };
}

/**
 * Resolve once one of `events` fires on `window`, or reject after `timeoutMs`.
 * Deterministic alternative to a fixed sleep: the test advances the moment the
 * cycle actually completes rather than waiting out a worst-case delay.
 *
 * @param {Window} window
 * @param {string[]} events
 * @param {number} [timeoutMs]
 * @returns {Promise<{ type: string, detail: any }>}
 */
function waitForEvent(window, events, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${events.join(" / ")}`));
    }, timeoutMs);
    const onEvent = (e) => {
      cleanup();
      resolve({ type: e.type, detail: e.detail });
    };
    function cleanup() {
      clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, onEvent);
    }
    for (const name of events) window.addEventListener(name, onEvent);
  });
}

test("E2E: edit → execute → render drives the real editor and viewer", async () => {
  const window = resetDom();

  // ── Mock IPC: the only transport. Records the descriptor and returns a canned
  //    HTTP response, standing in for the Electron main process. ───────────────
  let executeArg = null;
  window.hippo = {
    isElectron: true,
    http: {
      execute: async (desc) => {
        executeArg = desc;
        return {
          status: 201,
          statusText: "Created",
          headers: {
            "content-type": "application/json",
            "x-request-id": "abc-123",
          },
          cookies: [],
          body: JSON.stringify({ id: 7, name: "Ada" }),
          elapsed: 8,
          size: 24,
          consoleLog: [],
        };
      },
    },
  };

  const { executed } = installBridge(window, { timeout: 5000 });

  // ── Instantiate the real components (ResponseViewer self-subscribes to the
  //    response events in its constructor). ────────────────────────────────────
  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ collectionVariables: {}, folderChain: [] });

  // ── Select a request, then edit method / URL / headers / body. load() is the
  //    editor's public "a request was selected" entry point. ──────────────────
  editor.load({
    id: "req-1",
    method: "POST",
    url: "https://api.example.com/users",
    headers: [{ name: "X-Trace", value: "t-42", enabled: true }],
    bodyType: "json",
    bodyText: '{"name":"Ada"}',
  });

  // ── Trigger execute by clicking the real Send button, and wait for the
  //    response-received event that closes the cycle. ──────────────────────────
  const settled = waitForEvent(window, [
    "hippo:response-received",
    "hippo:request-error",
  ]);
  const sendBtn = editor.element.querySelector('[aria-label="Send request"]');
  assert.ok(sendBtn, "Send button is present in the editor DOM");
  sendBtn.click();
  const outcome = await settled;
  assert.equal(
    outcome.type,
    "hippo:response-received",
    "the cycle ended in a rendered response, not an error",
  );

  // ── Assert the built payload reached the mocked IPC intact. ────────────────
  assert.equal(executed.length, 1, "exactly one request was executed");
  assert.ok(executeArg, "the IPC execute channel received a descriptor");
  assert.equal(executeArg.method, "POST");
  assert.equal(executeArg.url, "https://api.example.com/users");
  // Header typed in the editor survives onto the wire…
  assert.equal(executeArg.headers["X-Trace"], "t-42");
  // …and the JSON body type contributes its Content-Type.
  assert.equal(executeArg.headers["Content-Type"], "application/json");
  assert.equal(executeArg.body, '{"name":"Ada"}');
  // Bridge-supplied transport settings are present.
  assert.equal(executeArg.timeout, 5000);

  // ── Assert the ResponseViewer rendered status / headers / body. ────────────
  const badge = viewer.element.querySelector(".res-status-badge");
  const statusText = viewer.element.querySelector(".res-status-text");
  assert.ok(badge.textContent.includes("201"), "status code is shown");
  assert.ok(statusText.textContent.includes("Created"), "status text is shown");

  const headersPane = viewer.element.querySelector("#res-tab-headers");
  assert.match(
    headersPane.textContent,
    /x-request-id/i,
    "a response header name is rendered",
  );
  assert.ok(
    headersPane.textContent.includes("abc-123"),
    "a response header value is rendered",
  );

  const bodyPane = viewer.element.querySelector("#res-tab-body");
  assert.ok(
    bodyPane.textContent.includes("Ada"),
    "the response body is rendered",
  );
});

test("E2E: a base64 (binary) response is forwarded with its encoding and renders as an image", async () => {
  const window = resetDom();

  // The main process returns binary bodies as base64 with encoding:"base64".
  // This is the contract the bridge (and app.js) must forward; dropping the
  // encoding field silently degrades images to a broken <img> and PDFs to a
  // jumble of text. Regression guard for that field plumbing.
  window.hippo = {
    isElectron: true,
    http: {
      execute: async () => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/png" },
        cookies: [],
        body: "SGVsbG8=", // "Hello" — stand-in raw bytes
        encoding: "base64",
        elapsed: 4,
        size: 5,
        consoleLog: [],
      }),
    },
  };

  installBridge(window);

  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ collectionVariables: {}, folderChain: [] });
  editor.load({
    id: "req-3",
    method: "GET",
    url: "https://api.example.com/logo.png",
  });

  const settled = waitForEvent(window, [
    "hippo:response-received",
    "hippo:request-error",
  ]);
  editor.element.querySelector('[aria-label="Send request"]').click();
  const outcome = await settled;

  assert.equal(
    outcome.type,
    "hippo:response-received",
    "the cycle ended in a rendered response",
  );
  // The encoding must survive the bridge so the viewer takes the binary path.
  assert.equal(
    outcome.detail.encoding,
    "base64",
    "the binary encoding is forwarded in the event detail",
  );

  const img = viewer.element.querySelector("img.res-body-image");
  assert.ok(img, "an <img> preview is rendered for the image response");
  assert.ok(img.getAttribute("src"), "the image has a (blob:) src");
  // The raw base64 must NOT have leaked into a text <pre> body.
  const bodyPane = viewer.element.querySelector("#res-tab-body");
  assert.ok(
    !bodyPane.textContent.includes("SGVsbG8="),
    "the base64 string is not rendered as text",
  );
});

test("E2E: a network-style failure renders the error state, not a response", async () => {
  const window = resetDom();

  // The bridge re-emits the IPC result; here the mock resolves to a transport
  // failure shape (status 0 + error) which app.js routes to hippo:request-error.
  let executeArg = null;
  window.hippo = {
    isElectron: true,
    http: {
      execute: async (desc) => {
        executeArg = desc;
        return {
          status: 0,
          error: { name: "FetchError", message: "ECONNREFUSED" },
          elapsed: 0,
          consoleLog: ["* FetchError: ECONNREFUSED"],
        };
      },
    },
  };

  // The SAME bridge as the success path — its status===0 branch routes this to
  // hippo:request-error, exercising the error fork of the one real handler.
  installBridge(window);

  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ collectionVariables: {}, folderChain: [] });
  editor.load({ id: "req-2", method: "GET", url: "https://down.example.com" });

  const settled = waitForEvent(window, [
    "hippo:response-received",
    "hippo:request-error",
  ]);
  editor.element.querySelector('[aria-label="Send request"]').click();
  const outcome = await settled;

  assert.equal(
    outcome.type,
    "hippo:request-error",
    "a transport failure routes to the error event, not a response",
  );
  assert.ok(executeArg, "the request was still dispatched to the IPC channel");
  assert.equal(executeArg.method, "GET");
  // The error message surfaces somewhere in the viewer's rendered output.
  assert.match(
    viewer.element.textContent,
    /ECONNREFUSED/,
    "the error is rendered",
  );
});
