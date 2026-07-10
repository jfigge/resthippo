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

"use strict";

/**
 * about-dialog.js — the in-app "About Rest Hippo" modal.
 *
 * Replaces the old native About BrowserWindow with an in-app PopupManager modal,
 * consistent with the app's other dialogs. Opened from the top-left brand mark
 * (#btn-about) and the Help ▸ About menu (hippo:show-about). A branded card:
 * logo, name (with an (i) toggle revealing version / branch / commit), subtitle,
 * description, credit, an optional voluntary "Support" donation link, and Close.
 *
 * Build metadata + the donation URL come from the main process over
 * `window.hippo.app.info()`; the donation link opens in the OS browser via
 * `window.hippo.ui.openExternal()` and is hidden when the metadata omits it (the
 * Mac App Store build bars external purchase links — see main.js collectAppInfo).
 *
 * Open with `AboutDialog.open()` — guarded so a second trigger while it is already
 * showing is a no-op rather than stacking a duplicate.
 */

import { PopupManager } from "../popup-manager.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";

export class AboutDialog {
  /** @type {boolean} guards against opening a duplicate over the live one */
  static #isOpen = false;

  #el;
  #onKey;

  /** Open the About dialog (no-op if already open). */
  static open() {
    if (AboutDialog.#isOpen) return;
    const inst = new AboutDialog();
    AboutDialog.#isOpen = true;
    PopupManager.open(inst);

    // Any close path (button, mask click, Escape, resize) fires popup-closed;
    // clear the guard and detach the Escape listener there so nothing leaks.
    window.addEventListener(
      "hippo:popup-closed",
      () => {
        AboutDialog.#isOpen = false;
        document.removeEventListener("keydown", inst.#onKey, true);
      },
      { once: true },
    );
  }

  constructor() {
    this.#el = this.#build();

    this.#el
      .querySelector(".about-close")
      .addEventListener("click", () => PopupManager.close());

    // The (i) button toggles the version/build details.
    const infoBtn = this.#el.querySelector(".about-info-btn");
    const build = this.#el.querySelector(".about-build");
    infoBtn.addEventListener("click", () => {
      const show = build.hasAttribute("hidden");
      build.toggleAttribute("hidden", !show);
      infoBtn.setAttribute("aria-expanded", String(show));
    });

    // Escape closes; capture-phase so it wins over any focused control inside.
    this.#onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        PopupManager.close();
      }
    };
    document.addEventListener("keydown", this.#onKey, true);

    // Fill dynamic build metadata + the (optional) support link asynchronously.
    this.#loadInfo();
  }

  get element() {
    return this.#el;
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  /** Pull version/build metadata + the donation URL from the main process. */
  async #loadInfo() {
    let info = null;
    try {
      info = await window.hippo?.app?.info?.();
    } catch {
      /* leave the build details as the dev-build fallback */
    }

    const row = (label, value) =>
      `<div class="about-build-row"><span class="about-build-label">${escapeHtml(
        label,
      )}</span><span class="about-build-value">${escapeHtml(value)}</span></div>`;

    const build = this.#el.querySelector(".about-build");
    if (info?.version) {
      build.innerHTML =
        row(t("about.version"), info.version) +
        row(t("about.branch"), info.branch || "—") +
        row(t("about.commit"), info.commit || "—");
    } else {
      build.innerHTML = row(t("about.version"), t("about.devBuild"));
    }

    // Voluntary donation link — shown only when the metadata supplies a URL.
    const donate = info?.donate;
    if (donate) {
      const support = this.#el.querySelector(".about-support");
      support.hidden = false;
      support.addEventListener("click", () => {
        window.hippo?.ui?.openExternal?.(donate);
      });
    }
  }

  #build() {
    const el = document.createElement("div");
    el.className = "popup about-dialog";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("menu.about"));

    el.innerHTML = `
      <img class="about-logo" src="resthippo-logo.png" alt="" aria-hidden="true" draggable="false" />
      <div class="about-name-row">
        <h1 class="about-name">${escapeHtml(t("about.name"))}</h1>
        <button class="about-info-btn" type="button" aria-controls="about-build"
                aria-expanded="false" aria-label="${escapeHtml(t("about.versionInfo"))}"
                title="${escapeHtml(t("about.versionInfo"))}">${icon("info", { size: 13 })}</button>
        <div class="about-build" id="about-build" hidden></div>
      </div>
      <p class="about-subtitle">${escapeHtml(t("about.subtitle"))}</p>
      <p class="about-desc">${escapeHtml(t("about.description"))}</p>
      <p class="about-credit">${escapeHtml(t("about.credit"))}</p>
      <button class="about-support" type="button" hidden>
        <span class="about-heart" aria-hidden="true">♥</span>
        <span>${escapeHtml(t("menu.support"))}</span>
      </button>
      <button class="about-close" type="button">${escapeHtml(t("common.close"))}</button>
    `;
    return el;
  }
}
