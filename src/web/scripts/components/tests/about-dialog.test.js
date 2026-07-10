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
 * tests/about-dialog.test.js
 *
 * Unit tests for the in-app AboutDialog. Pins that it renders the branded card,
 * fills version/branch/commit from window.hippo.app.info(), toggles the build
 * panel, shows the voluntary support link only when a donate URL is supplied
 * (opening it via ui.openExternal), and falls back to a dev-build line off-Electron.
 */

"use strict";

// MUST come first — installs the jsdom globals the dialog needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { AboutDialog } from "../about-dialog.js";
import { t } from "../../i18n.js";

/** Flush the constructor's async #loadInfo(). */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Build a dialog instance with a stubbed window.hippo (app info + external open). */
function mount({ info } = {}) {
  const window = resetDom();
  const opened = [];
  window.hippo = {
    app: { info: async () => info },
    ui: {
      openExternal: async (url) => {
        opened.push(url);
        return true;
      },
    },
  };
  const inst = new AboutDialog();
  document.body.appendChild(inst.element);
  return { window, inst, opened };
}

test("renders the branded card (name / subtitle / description / credit)", () => {
  const { inst } = mount({ info: { version: "1.2.3" } });
  const el = inst.element;
  assert.equal(el.querySelector(".about-name").textContent, t("about.name"));
  assert.equal(
    el.querySelector(".about-subtitle").textContent,
    t("about.subtitle"),
  );
  assert.equal(
    el.querySelector(".about-desc").textContent,
    t("about.description"),
  );
  assert.equal(
    el.querySelector(".about-credit").textContent,
    t("about.credit"),
  );
  assert.ok(el.querySelector("img.about-logo"), "logo present");
});

test("fills version / branch / commit from app.info()", async () => {
  const { inst } = mount({
    info: { version: "1.2.3", branch: "main", commit: "abc1234", donate: null },
  });
  await flush();
  const build = inst.element.querySelector(".about-build").textContent;
  assert.match(build, /1\.2\.3/);
  assert.match(build, /main/);
  assert.match(build, /abc1234/);
});

test("the (i) button toggles the build-info panel", async () => {
  const { inst } = mount({ info: { version: "1.0.0" } });
  await flush();
  const infoBtn = inst.element.querySelector(".about-info-btn");
  const build = inst.element.querySelector(".about-build");
  assert.equal(build.hasAttribute("hidden"), true);
  infoBtn.click();
  assert.equal(build.hasAttribute("hidden"), false);
  assert.equal(infoBtn.getAttribute("aria-expanded"), "true");
  infoBtn.click();
  assert.equal(build.hasAttribute("hidden"), true);
  assert.equal(infoBtn.getAttribute("aria-expanded"), "false");
});

test("shows the support link for a donate URL and opens it via ui.openExternal", async () => {
  const url = "https://github.com/sponsors/jfigge";
  const { inst, opened } = mount({ info: { version: "1.0.0", donate: url } });
  await flush();
  const support = inst.element.querySelector(".about-support");
  assert.equal(support.hidden, false);
  support.click();
  assert.deepEqual(opened, [url]);
});

test("hides the support link when no donate URL (e.g. Mac App Store build)", async () => {
  const { inst } = mount({ info: { version: "1.0.0", donate: null } });
  await flush();
  assert.equal(inst.element.querySelector(".about-support").hidden, true);
});

test("falls back to a dev-build line when app.info() is unavailable (non-Electron)", async () => {
  const window = resetDom();
  window.hippo = undefined;
  const inst = new AboutDialog();
  document.body.appendChild(inst.element);
  await flush();
  assert.match(
    inst.element.querySelector(".about-build").textContent,
    new RegExp(t("about.devBuild")),
  );
});

test("open() mounts a single dialog; a second open() while showing is a no-op", () => {
  const window = resetDom();
  window.hippo = { app: { info: async () => ({ version: "1.0.0" }) } };
  AboutDialog.open();
  assert.equal(document.querySelectorAll(".about-dialog").length, 1);
  AboutDialog.open(); // guarded — no duplicate
  assert.equal(document.querySelectorAll(".about-dialog").length, 1);
  // Reset the static guard for later tests (the once-listener clears it).
  window.dispatchEvent(new window.CustomEvent("hippo:popup-closed"));
});
