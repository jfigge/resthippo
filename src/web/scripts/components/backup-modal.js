"use strict";

import { PopupManager } from "../popup-manager.js";
import { Notifications } from "../notifications.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";

/**
 * BackupModal — theme-styled modal for creating and restoring whole-workspace
 * backups. The renderer only ever collects the secret mode and (for password
 * mode) the plaintext password; the main process owns the file dialogs, all
 * filesystem I/O and every encryption step. Secrets never reach the renderer.
 *
 * Open via the static factories:
 *   BackupModal.openExport();
 *   BackupModal.openImport();
 */
export class BackupModal {
  #el;
  #variant; // "export" | "import"
  #secretsMode = "none"; // import: secret mode of the chosen file
  #filePath = null; // import: path returned by prepare
  #errorEl = null;
  #pwFieldsEl = null; // export/import: password field container
  #busy = false;

  constructor({ variant, secretsMode = "none", filePath = null } = {}) {
    this.#variant = variant;
    this.#secretsMode = secretsMode;
    this.#filePath = filePath;
    this.#el = variant === "export" ? this.#buildExport() : this.#buildImport();
    this.#errorEl = this.#el.querySelector(".backup-error");
    this.#pwFieldsEl = this.#el.querySelector(".backup-pw-fields");
    this.#bindEvents();
    this.#syncPasswordVisibility();
  }

  get element() {
    return this.#el;
  }

  /** Open the "Create Backup" modal. */
  static openExport() {
    const modal = new BackupModal({ variant: "export" });
    PopupManager.open(modal);
  }

  /**
   * Open the "Restore Backup" modal. First asks main to pick and validate the
   * file (so the modal can offer a password field only when the backup is
   * password-protected). Aborts silently if the user cancels the file picker.
   */
  static async openImport() {
    const prep = await window.wurl.backup.prepare();
    if (!prep || prep.canceled) return;
    if (!prep.ok) {
      Notifications.error(prep.error || "Could not read the backup file.", {
        title: "Restore backup failed",
      });
      return;
    }
    const modal = new BackupModal({
      variant: "import",
      secretsMode: prep.secretsMode,
      filePath: prep.filePath,
    });
    PopupManager.open(modal);
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    if (!this.#busy) PopupManager.close();
  }

  // ── Build: export ───────────────────────────────────────────────────────────

  #buildExport() {
    const el = document.createElement("div");
    el.className = "popup backup-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Create backup");
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Create Backup</span>
        <button class="popup-close" aria-label="Close" title="Close">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">Back up all collections, environments and settings to a single file. Choose how to handle secrets (passwords, tokens and keys).</p>
        <div class="backup-mode-group" role="radiogroup" aria-label="Secret handling">
          ${this.#modeOption("none", "Redacted", "Remove all secrets. Safe to share or move between machines.", true)}
          ${this.#modeOption("machine", "This machine only", "Keep secrets encrypted with this machine's keystore. Restores only on this machine.", false)}
          ${this.#modeOption(
            "password",
            "Password-protected",
            "Keep secrets encrypted with a password. Restores anywhere using that password.",
            false,
            `
          <div class="backup-pw-fields" hidden>
            <label class="backup-field">
              <span class="backup-field-label">Password</span>
              <input class="settings-input backup-input js-pw" type="password" autocomplete="new-password" spellcheck="false" />
            </label>
            <label class="backup-field">
              <span class="backup-field-label">Confirm password</span>
              <input class="settings-input backup-input js-pw-confirm" type="password" autocomplete="new-password" spellcheck="false" />
            </label>
          </div>`,
          )}
        </div>
        <div class="backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">Cancel</button>
        <button class="btn popup-btn btn--primary js-submit">Create Backup</button>
      </div>
    `;
    return el;
  }

  // ── Build: import ─────────────────────────────────────────────────────────────

  #buildImport() {
    const needsPw = this.#secretsMode === "password";
    const el = document.createElement("div");
    el.className = "popup backup-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Restore backup");
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Restore Backup</span>
        <button class="popup-close" aria-label="Close" title="Close">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">Choose how to apply this backup to your workspace.</p>
        <div class="backup-mode-group" role="radiogroup" aria-label="Restore mode">
          ${this.#modeOption("merge", "Merge", "Add the backup's items to your workspace. Items with the same id are overwritten.", true)}
          ${this.#modeOption("replace", "Replace", "Delete all current collections and environments first, then restore only the backup.", false)}
        </div>
        <div class="backup-pw-fields"${needsPw ? "" : " hidden"}>
          <p class="backup-hint">This backup is password-protected. Enter the password to recover its secrets. Leave it blank to restore without secrets — secured variables are kept but their values are cleared.</p>
          <label class="backup-field">
            <span class="backup-field-label">Password</span>
            <input class="settings-input backup-input js-pw" type="password" autocomplete="off" spellcheck="false" />
          </label>
        </div>
        <div class="backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">Cancel</button>
        <button class="btn popup-btn btn--primary js-submit">Restore Backup</button>
      </div>
    `;
    return el;
  }

  #modeOption(value, label, desc, checked, extra = "") {
    const group =
      this.#variant === "export" ? "backup-secret-mode" : "backup-restore-mode";
    const head = `
      <label class="backup-mode-head">
        <input type="radio" name="${group}" value="${value}"${checked ? " checked" : ""} />
        <span class="backup-mode-text">
          <span class="backup-mode-label">${escapeHtml(label)}</span>
          <span class="backup-mode-desc">${escapeHtml(desc)}</span>
        </span>
      </label>
    `;
    // A bare option is a single clickable label; an option carrying extra
    // content (e.g. the password fields) becomes a column container so the
    // fields nest inside the card without sitting inside the label itself.
    if (!extra) {
      return `<label class="backup-mode-option">${head}</label>`;
    }
    return `
      <div class="backup-mode-option backup-mode-option--expandable">
        ${head}
        ${extra}
      </div>
    `;
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  #bindEvents() {
    this.#el
      .querySelector(".popup-close")
      .addEventListener("click", () => this.onMaskClick());
    this.#el
      .querySelector(".js-cancel")
      .addEventListener("click", () => this.onMaskClick());
    this.#el
      .querySelector(".js-submit")
      .addEventListener("click", () => this.#submit());

    for (const radio of this.#el.querySelectorAll('input[type="radio"]')) {
      radio.addEventListener("change", () => {
        this.#clearError();
        this.#syncPasswordVisibility();
      });
    }

    for (const input of this.#el.querySelectorAll(".backup-input")) {
      input.addEventListener("input", () => this.#clearError());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.onMaskClick();
        }
      });
    }
  }

  #selectedMode() {
    const checked = this.#el.querySelector('input[type="radio"]:checked');
    return checked ? checked.value : null;
  }

  /** Export: password fields appear only for password mode. */
  #syncPasswordVisibility() {
    if (this.#variant !== "export" || !this.#pwFieldsEl) return;
    const show = this.#selectedMode() === "password";
    this.#pwFieldsEl.hidden = !show;
    if (show) {
      requestAnimationFrame(() => this.#el.querySelector(".js-pw")?.focus());
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  async #submit() {
    if (this.#busy) return;
    const mode = this.#selectedMode();
    if (!mode) return;

    if (this.#variant === "export") {
      await this.#submitExport(mode);
    } else {
      await this.#submitImport(mode);
    }
  }

  async #submitExport(mode) {
    let password;
    if (mode === "password") {
      const pw = this.#el.querySelector(".js-pw").value;
      const confirm = this.#el.querySelector(".js-pw-confirm").value;
      if (!pw) {
        this.#showError("Enter a password to protect this backup.");
        return;
      }
      if (pw !== confirm) {
        this.#showError("Passwords do not match.");
        return;
      }
      password = pw;
    }

    this.#setBusy(true);
    try {
      const res = await window.wurl.backup.export({ mode, password });
      // On cancel (no file chosen) or error (main showed a native box) just
      // close; success likewise closes the modal.
      if (res && res.ok === false && res.error) {
        // Native error box already shown by main; nothing more to do here.
      }
    } finally {
      this.#setBusy(false);
      PopupManager.close();
    }
  }

  async #submitImport(mode) {
    const pwInput = this.#el.querySelector(".js-pw");
    const password = pwInput ? pwInput.value : undefined;

    this.#setBusy(true);
    try {
      const res = await window.wurl.backup.import({
        filePath: this.#filePath,
        mode,
        password,
      });
      if (res && res.reason === "bad-password") {
        this.#showError("Incorrect password. Please try again.");
        if (pwInput) {
          pwInput.value = "";
          pwInput.focus();
        }
        return; // stay open for retry
      }
      // Success reloads the window (tearing down this modal); error already
      // surfaced via a native box. Either way, close.
      PopupManager.close();
    } finally {
      this.#setBusy(false);
    }
  }

  #setBusy(busy) {
    this.#busy = busy;
    const submit = this.#el.querySelector(".js-submit");
    const cancel = this.#el.querySelector(".js-cancel");
    if (submit) submit.disabled = busy;
    if (cancel) cancel.disabled = busy;
  }

  // ── Error ─────────────────────────────────────────────────────────────────────

  #showError(msg) {
    if (this.#errorEl) this.#errorEl.textContent = msg;
  }

  #clearError() {
    if (this.#errorEl) this.#errorEl.textContent = "";
  }

  // ── Utils ───────────────────────────────────────────────────────────────────
}
