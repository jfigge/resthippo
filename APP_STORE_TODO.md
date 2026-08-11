# App Store submission — running checklist

Live TODO for shipping Rest Hippo to the **Mac App Store** and the **Microsoft
Store** — both are live; this tracks the update cadence. The full how-to is in [`STORE-PUBLISHING.md`](./STORE-PUBLISHING.md); this file
tracks _what's left and in what order_.

Key facts:

| Thing                        | Value                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Apple Team ID                | `2C564TQ2FY`                                                                                   |
| App Store Connect app id     | `6784875828` (macOS)                                                                           |
| Current version              | `1.19.0`                                                                                       |
| App Store Connect API key id | `G9W84MCW73` (`.keys/AuthKey_G9W84MCW73.p8`)                                                   |
| Built package                | `build/src/dist/mas-universal/Rest-Hippo-1.19.0-universal.pkg` (universal, signed)             |
| MS Store ID                  | `9NPC93LNBT9Q` (identity `16486jkfigge.RestHippo`, PFN `16486jkfigge.RestHippo_m3yv9kg2rttw8`) |
| CI kill-switch               | `vars.STORE_SUBMIT_ENABLED` (off = build only, on = push to store)                             |

> **⚠️ Why the version jumped 1.1.5 → 1.19.0.** The first Microsoft Store submission
> (2026-06-27, published 2026-06-30) was built while `src/package.json` said
> `"version": "1.18.4"` — a typo, corrected to `0.18.5` two days later and then reset
> to `1.0.0`. But the Store had already published package **`1.18.4.0`**, and the Store
> refuses any package whose version is not strictly greater than the published one.
> `1.1.5.0 < 1.18.4.0` (minor 1 vs 18), so the whole 1.1.x line was permanently unable
> to update the Store listing. Release **1.19.0** clears it and puts GitHub, the Mac App
> Store and the Microsoft Store back on one ascending line. There is no per-target
> version override in electron-builder — the AppX identity version comes straight from
> `package.json` (`appInfo.getVersionInWeirdWindowsForm()` → `major.minor.patch.0`), so
> the only lever is the real version.

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
- [x] First build uploaded to App Store Connect; **1.0.0 / 1.1.3 / 1.1.5 all
      `READY_FOR_SALE`** (1.1.5 approved 2026-08).
- [x] CI auto-submit wired into `release.yml` and **live** — `MAS_ENABLED=true` +
      `STORE_SUBMIT_ENABLED=true`; first automated upload succeeded on `v1.1.3`.
- [x] Microsoft Store published (`1.18.4.0`, 2026-06-30) — see below.

---

## 🍎 Apple — shipping on autopilot

Versions `1.0.0`, `1.1.3` and `1.1.5` are `READY_FOR_SALE`. Each tagged release now
uploads its MAS build to App Store Connect automatically; only the final **Submit for
Review** click stays manual.

Per-release loop:

- [ ] Tag → CI `store-mas` job builds the universal signed `.pkg` and uploads it.
- [ ] App Store Connect → **+ Version**, attach the new build, **Submit for Review**.
- [ ] **If rejected:** fix, then re-upload — a re-upload of the _same_ version needs a
      unique build number (`-c.mac.bundleVersion=<version>.1`), since there is no
      `buildVersion` in `src/package.json` and `CFBundleVersion` == `version`.

Check state without the web UI — mint an ES256 JWT from `.keys/AuthKey_79JFDZB54V.p8`
(issuer in `.keys/issuer_Id`) and GET `/v1/builds?filter[app]=6784875828` /
`/v1/apps/6784875828/appStoreVersions`. Do this **before** rebuilding: Apple rejects a
duplicate `CFBundleVersion`.

Notes worth keeping in mind for review:

- [ ] **Export compliance** — Rest Hippo uses only standard TLS; answer "uses exempt
      encryption". Optionally set `ITSAppUsesNonExemptEncryption=false` in the build to
      skip the per-submission prompt.
- [ ] Confirm the sandboxed build's disabled features read sensibly to the reviewer
      (no in-app updater, no `hippo` CLI install, mTLS off) — these are intentional.
- [ ] **Back up the MAS installer key** — `.keys/` has `MAS_Application.p12` but **no
      `MAS_Installer.p12`**. A login-keychain reset already stranded these keys once
      (2026-07-07); export the 3rd Party Mac Developer Installer identity too.

---

## ✅ CI/CD rollout — complete

`release.yml` runs only on `v*` **tag** pushes. The store jobs always **build**; they
**push** to the store only on a tag release **and** while `STORE_SUBMIT_ENABLED == 'true'`.

- [x] `vars.MAS_ENABLED = true`.
- [x] Secrets `MAS_CSC_LINK` / `MAS_CSC_KEY_PASSWORD` / `MAS_INSTALLER_CSC_LINK` /
      `MAS_INSTALLER_CSC_KEY_PASSWORD` / `MAS_PROVISIONING_PROFILE_BASE64`.
      ⚠️ The three base64 ones were once set **empty** — GitHub's step `env:` echo prints
      an empty secret as blank vs `***`, which is the tell.
- [x] Secrets `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` / `APPLE_API_KEY_BASE64`.
- [x] `vars.STORE_SUBMIT_ENABLED = true` (shared Apple + Microsoft switch).
- To pause submissions: `gh variable set STORE_SUBMIT_ENABLED --body false`.
- ⚠️ `gh run rerun` replays a run against the workflow **at that run's original commit**,
  so a workflow fix only takes effect on a _new_ tag.

---

## 🪟 Microsoft Store — LIVE, update in flight

The app is **published**: released **2026-06-30** at package version **`1.18.4.0`**
(x64 + arm64), Store ID `9NPC93LNBT9Q`. Partner Center identity, the `store-appx` CI
job and the `APPX_*` repo variables are all set up and working — CI builds both
architectures on every tag.

- [x] Partner Center registered; app name reserved.
- [x] `vars.APPX_IDENTITY_NAME` / `APPX_PUBLISHER` / `APPX_PUBLISHER_DISPLAY_NAME` set
      (the committed `build.appx` keeps its `FILL-LATER-*` placeholders on purpose —
      `make dist-appx` overrides them from the env).
- [x] First submission certified and published (`1.18.4.0`, 2026-06-30).

### Shipping the 1.19.0 update

- [ ] Download the `store-appx` artifact from the `v1.19.0` release run
      (`gh run download <run-id> -n store-appx`) — **run artifacts expire**, so grab it
      promptly or re-run the job.
- [ ] Partner Center → Rest Hippo → **Submissions** → **Packages** → upload both
      `Rest-Hippo-1.19.0-x64.appx` and `Rest-Hippo-1.19.0-arm64.appx`.
- [ ] Refresh the listing notes if the release warrants it, then **Submit for
      certification**.
- [ ] The `runFullTrust` restricted-capability flag is **expected** — it is intrinsic to
      Electron/Desktop Bridge (`EntryPoint=Windows.FullTrustApplication`) and cannot be
      removed, only justified. Reuse the June justification.

### Later — CI auto-submit (still dormant)

The `msstore publish --noCommit` step exists in `release.yml` but self-skips while
`vars.MS_STORE_PRODUCT_ID` is unset. To turn it on:

- [ ] Partner Center → **Account settings → User management → Azure AD applications**:
      create an app, then add secrets `MS_STORE_TENANT_ID` / `MS_STORE_CLIENT_ID` /
      `MS_STORE_CLIENT_SECRET` and variable `vars.MS_STORE_PRODUCT_ID`.
- [ ] `vars.STORE_SUBMIT_ENABLED` is already `true` (shared with Apple), so the step
      goes live the moment the product-id variable is set — expect to debug it on the
      first tag, since it has never run.

---

## 🧹 Housekeeping

- [x] All store files committed and tracked (`store-build.js`, its test, both MAS
      entitlements plists, `STORE-PUBLISHING.md`, `APP_STORE_TODO.md`).
- Reminder: `git commit -a` silently drops **untracked** files — stage new files
  explicitly, or they never reach the branch.
- `src/packaging/*.provisionprofile` stays gitignored (per-developer; CI rebuilds it
  from `MAS_PROVISIONING_PROFILE_BASE64`).
