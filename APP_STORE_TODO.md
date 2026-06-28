# App Store submission — running checklist

Live TODO for shipping Rest Hippo to the **Mac App Store** (and later the Microsoft
Store). The full how-to is in [`STORE-PUBLISHING.md`](./STORE-PUBLISHING.md); this file
tracks *what's left and in what order*.

Key facts:

| Thing | Value |
| --- | --- |
| Apple Team ID | `2C564TQ2FY` |
| App Store Connect app id | `6784875828` (macOS) |
| Current version | `1.18.4` |
| App Store Connect API key id | `G9W84MCW73` (`.keys/AuthKey_G9W84MCW73.p8`) |
| Built package | `build/src/dist/mas-universal/Rest-Hippo-1.18.4-universal.pkg` (universal, signed) |
| CI kill-switch | `vars.STORE_SUBMIT_ENABLED` (off = build only, on = push to store) |

---

## ✅ Done

- [x] Store-build feature flag + sandbox gating (`src/app/store-build.js`; updater/CLI/mTLS/import).
- [x] `build.mas` config + MAS entitlements (`src/packaging/entitlements.mas*.plist`).
- [x] Apple **Distribution** + **Mac Installer Distribution** certs valid in the login keychain.
- [x] App Sandbox–capable App ID `com.resthippo.app`; MAS **distribution** provisioning
      profile at `src/packaging/embedded.provisionprofile` (bound to the current cert).
- [x] App Store Connect record created (app id `6784875828`).
- [x] `make dist-mas` produces a working **universal, signed** `.pkg`
      (fixes: `CSC_NAME`, `--universal`, `-c.mac.notarize=false`).
- [x] First build uploaded to App Store Connect (in review).
- [x] CI auto-submit wired into `release.yml` (gated, kill-switch off by default).

---

## ⏳ Apple — first release in review

Expect a possible rejection on the first pass. The loop:

- [ ] Wait for App Store review on app id `6784875828`.
- [ ] **If rejected:** address the feedback (metadata, screenshots, binary), then re-upload:
  - [ ] Rebuild: `make dist-mas`
  - [ ] A re-upload of the **same** version needs a **unique build number** — bump it:
        `make dist-mas` after adding `-c.mac.bundleVersion=1.18.4.1` (or bump `version`).
  - [ ] Re-upload via Transporter (or `xcrun altool --upload-app -t macos -f <pkg> \
        -u jason.figge@gmail.com -p @env:APPLE_APP_SPECIFIC_PASSWORD`).
  - [ ] Resubmit for review in App Store Connect.
- [ ] **If approved:** move to "CI Phase B" below to turn on automated submission.

Notes worth keeping in mind for review:

- [ ] **Export compliance** — Rest Hippo uses only standard TLS; answer "uses exempt
      encryption". Optionally set `ITSAppUsesNonExemptEncryption=false` in the build to
      skip the per-submission prompt.
- [ ] Confirm the sandboxed build's disabled features read sensibly to the reviewer
      (no in-app updater, no `hippo` CLI install, mTLS off) — these are intentional.

---

## 🔧 CI/CD rollout

`release.yml` runs only on `v*` **tag** pushes (never branch pushes / never on a manual
`workflow_dispatch` for the submit step). The store jobs always **build**; they only
**push** to the store on a tag release **and** when `STORE_SUBMIT_ENABLED == 'true'`.

### Phase A — wire it up now (build in CI, do NOT submit)

Goal: prove CI produces the same valid package, with submission still disabled.

- [ ] Add repo **variable** `MAS_ENABLED = true`.
- [ ] Add repo **secrets** (base64 the cert/profile files: `base64 -i <file> | pbcopy`):
  - [ ] `MAS_CSC_LINK` — base64 of the Apple Distribution `.p12`
  - [ ] `MAS_CSC_KEY_PASSWORD`
  - [ ] `MAS_INSTALLER_CSC_LINK` — base64 of the Mac Installer Distribution `.p12`
  - [ ] `MAS_INSTALLER_CSC_KEY_PASSWORD`
  - [ ] `MAS_PROVISIONING_PROFILE_BASE64` — base64 of `embedded.provisionprofile`
- [ ] **Leave `STORE_SUBMIT_ENABLED` unset.**
- [ ] Cut a test tag release and confirm the `store-mas` job builds the `.pkg` and
      uploads it as the `store-mas` run artifact (download + sanity-check it).

### Phase B — enable auto-submit (after first approval)

- [ ] Add repo secrets for the App Store Connect API key:
  - [ ] `APPLE_API_KEY_ID` = `G9W84MCW73`
  - [ ] `APPLE_API_ISSUER` = Issuer ID (App Store Connect → Users and Access →
        Integrations → App Store Connect API)
  - [ ] `APPLE_API_KEY_BASE64` = `base64 -i .keys/AuthKey_G9W84MCW73.p8`
- [ ] Set repo **variable** `STORE_SUBMIT_ENABLED = true`.
- [ ] Tag a release → CI uploads the build to App Store Connect automatically.
- [ ] Click **Submit for Review** in App Store Connect (CI uploads only; it never
      ships to users on its own).
- [ ] To pause submissions at any time, set `STORE_SUBMIT_ENABLED` back to `false`.

---

## 🪟 Microsoft Store (future — dormant)

The `store-appx` job and its submit step exist but stay a no-op until Partner Center is
set up (`vars.APPX_IDENTITY_NAME` is unset).

- [ ] Register at Partner Center (~$19) and reserve the app name.
- [ ] Fill `build.appx` identity (or set `vars.APPX_IDENTITY_NAME` / `APPX_PUBLISHER` /
      `APPX_PUBLISHER_DISPLAY_NAME`).
- [ ] For auto-submit, create a Partner Center Azure-AD app and add secrets
      `MS_STORE_TENANT_ID` / `MS_STORE_CLIENT_ID` / `MS_STORE_CLIENT_SECRET` and
      `vars.MS_STORE_PRODUCT_ID`; test the `msstore publish` step.

---

## 🧹 Housekeeping — commit the uncommitted work

`git commit -a` drops untracked files, so **stage the new files explicitly**:

- [ ] `git add` the new files:
  - `src/app/store-build.js`
  - `src/app/tests/store-build.test.js`
  - `src/packaging/entitlements.mas.plist`
  - `src/packaging/entitlements.mas.inherit.plist`
  - `STORE-PUBLISHING.md`
  - `APP_STORE_TODO.md`
- [ ] Commit the modified files (picked up by `git commit -a`): `Makefile`,
      `src/package.json`, `.github/workflows/release.yml`, `.gitignore`,
      `release.env.example`, `src/app/*` gates, locale JSONs.
- [ ] Do **not** commit `src/packaging/*.provisionprofile` (gitignored — per-developer).
