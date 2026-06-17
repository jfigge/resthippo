/* secret-field.js — reusable mask/reveal control for encrypted text inputs.
 *
 * Any field whose value is stored encrypted at rest (auth secrets, proxy URL,
 * …) should be wrapped with this control so its content is masked by default
 * and only revealed when the user clicks the eye toggle.
 *
 * Masking is purely visual, via the Chromium-only `-webkit-text-security`
 * property (see `.secret-field--masked .secret-field-input` in
 * components.css). Because it is a CSS property rather than `input[type]`
 * swapping, the same control works for both plain `<input>` elements and the
 * contenteditable VariablePillEditor used by the auth fields. Variable pills
 * stay legible — only raw secret text is masked.
 *
 *   const field = wrapSecretField(inputEl);           // masked by default
 *   const field = wrapSecretField(editor.element, { masked: false });
 */

import { icon } from "../icons.js";
import { t } from "../i18n.js";

/**
 * Wrap an input-like element with a mask/reveal eye toggle.
 *
 * @param {HTMLElement} fieldEl  The input or contenteditable element to mask.
 * @param {{ masked?: boolean }} [opts]  `masked` sets the initial state
 *   (default true — hidden).
 * @returns {HTMLElement} A `.secret-field` wrapper containing the field and the
 *   toggle button. Insert this where the bare field would have gone.
 */
export function wrapSecretField(fieldEl, { masked = true } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "secret-field";

  fieldEl.classList.add("secret-field-input");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secret-field-toggle";
  // Suppress password-manager interest in any nested credential field.
  toggle.setAttribute("tabindex", "-1");

  let isMasked = masked;
  const render = () => {
    wrapper.classList.toggle("secret-field--masked", isMasked);
    // Masked → offer the "reveal" (open eye); revealed → offer the "hide".
    toggle.innerHTML = icon(isMasked ? "eye" : "eyeOff");
    const action = isMasked ? t("common.reveal") : t("common.hide");
    toggle.title = action;
    toggle.setAttribute("aria-label", action);
    toggle.setAttribute("aria-pressed", String(!isMasked));
  };
  render();

  toggle.addEventListener("click", () => {
    isMasked = !isMasked;
    render();
  });

  wrapper.appendChild(fieldEl);
  wrapper.appendChild(toggle);
  return wrapper;
}
