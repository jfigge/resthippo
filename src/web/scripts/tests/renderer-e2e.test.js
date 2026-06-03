/**
 * tests/renderer-e2e.test.js
 *
 * End-to-end test of the renderer's core request→response cycle, run headlessly
 * under `node --test` with jsdom and a mocked IPC surface — no real network and
 * no running Electron main process.
 *
 * It wires the two real components that bracket the cycle:
 *
 *     RequestEditor  ──(wurl:send-request)──►  [bridge]  ──window.wurl.http.execute──►  (mock)
 *          ▲                                                                               │
 *          │            (wurl:response-received  |  wurl:request-error)                    ▼
 *     ResponseViewer  ◄───────────────────────────────────────────────────────────────────
 *
 * The [bridge] in the middle mirrors the documented contract of app.js's
 * `wurl:send-request` handler (app.js:1554): it assembles the native descriptor,
 * calls the (mocked) `window.wurl.http.execute` IPC channel, and routes the
 * outcome down the same two branches app.js uses — an HTTP response re-dispatches
 * as `wurl:response-received`, while a transport failure (status 0 + error)
 * re-dispatches as `wurl:request-error`. app.js itself is a monolithic
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
 * Mirrors app.js:1554 in full — listens for the editor's `wurl:send-request`,
 * builds the native descriptor app.js would build, hands it to the mocked IPC
 * channel, and routes the outcome down the SAME two branches app.js uses: a
 * transport failure (`status === 0` with an `error`) re-emits as
 * `wurl:request-error`, while any HTTP response re-emits as
 * `wurl:response-received`. Reproducing both branches in one place keeps this a
 * faithful stand-in for the (un-importable) bootstrap handler rather than a
 * happy-path-only shim.
 *
 * @param {Window} window    the active jsdom window (fresh per test)
 * @param {object} settings  the subset of app settings the descriptor reads
 * @returns {{ executed: object[] }}  records every nativeDesc sent to the IPC mock
 */
function installBridge(window, settings = {}) {
  const executed = [];
  window.addEventListener("wurl:send-request", async (e) => {
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

    const result = await window.wurl.http.execute(nativeDesc);
    const request = {
      method: nativeDesc.method,
      url: nativeDesc.url,
      headers: nativeDesc.headers,
      body: nativeDesc.body,
    };

    if (result.error && result.status === 0) {
      // Transport-level failure — no HTTP response was received.
      window.dispatchEvent(
        new window.CustomEvent("wurl:request-error", {
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
        new window.CustomEvent("wurl:response-received", {
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
  window.wurl = {
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
  editor.setVariableContext({ envVariables: {}, folderChain: [] });

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
    "wurl:response-received",
    "wurl:request-error",
  ]);
  const sendBtn = editor.element.querySelector('[aria-label="Send request"]');
  assert.ok(sendBtn, "Send button is present in the editor DOM");
  sendBtn.click();
  const outcome = await settled;
  assert.equal(
    outcome.type,
    "wurl:response-received",
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

test("E2E: a network-style failure renders the error state, not a response", async () => {
  const window = resetDom();

  // The bridge re-emits the IPC result; here the mock resolves to a transport
  // failure shape (status 0 + error) which app.js routes to wurl:request-error.
  let executeArg = null;
  window.wurl = {
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
  // wurl:request-error, exercising the error fork of the one real handler.
  installBridge(window);

  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ envVariables: {}, folderChain: [] });
  editor.load({ id: "req-2", method: "GET", url: "https://down.example.com" });

  const settled = waitForEvent(window, [
    "wurl:response-received",
    "wurl:request-error",
  ]);
  editor.element.querySelector('[aria-label="Send request"]').click();
  const outcome = await settled;

  assert.equal(
    outcome.type,
    "wurl:request-error",
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
