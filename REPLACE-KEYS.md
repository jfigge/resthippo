# Replacing lost Mac App Store signing keys

A runbook for re-issuing the **Mac App Store (MAS)** signing certificates when the
private key is lost (keychain reset, new machine, deleted key). It reproduces the
exact steps used on **2026-07-07** to recover after a login-keychain reset wiped
both MAS private keys.

> Companion docs: [`STORE-PUBLISHING.md`](STORE-PUBLISHING.md) (full store auth /
> submit walkthrough) and the `dist-mas` target in the [`Makefile`](Makefile).

---

## Why a lost key can't be "restored"

The private key is generated **locally** (in a CSR) and Apple never receives it — the
Developer portal only holds the public certificate. So a certificate without its
private key is a dead artifact: it won't form a signing *identity* and can't be
recovered. **The only fix is to re-issue new certificates from a new key.** Back the
new keys up (Step 8) so this never recurs.

Two certificates drive `make dist-mas`, and **both** must be valid identities:

| Certificate (portal name) | Keychain common name | Signs |
| --- | --- | --- |
| **Apple Distribution** | `Apple Distribution: Jason Figge (2C564TQ2FY)` | the `.app` bundle |
| **Mac Installer Distribution** | `3rd Party Mac Developer Installer: Jason Figge (2C564TQ2FY)` | the `.pkg` wrapper |

---

## Project reference values

| Thing | Value |
| --- | --- |
| Team / signing team ID | `2C564TQ2FY` (individual account "Jason Figge") |
| Bundle id | `com.resthippo.app` |
| App Store Connect app id | `6784875828` (macOS record) |
| `CSC_NAME` qualifier | `Jason Figge (2C564TQ2FY)` — one string that matches BOTH certs (`MAS_CSC_NAME` in the Makefile) |
| Provisioning profile (in tree) | `src/packaging/embedded.provisionprofile` (gitignored via `*.provisionprofile`) |
| Profile name in portal | `Rest Hippo MAS Distribution` |
| Build output | `build/src/dist/mas-universal/Rest-Hippo-<version>-universal.pkg` |
| Local key backups | `.keys/` (gitignored) |

---

## Step 1 — Confirm the keys are gone

```bash
# A valid "identity" = certificate + its private key. Zero identities = lost key(s).
security find-identity -v -p codesigning   # app-signing (Apple Distribution) lives here
security find-identity -v                   # ALL identities — installer cert shows here too
```

If the MAS lines are absent (or `0 valid identities found`), the private keys are gone
and you must re-issue. (An expired-but-present cert would still list — absence ⇒ lost
key, not expiry.)

## Step 2 — Generate a fresh key + CSR (Keychain Access)

Use **Keychain Access**, not `openssl` — the GUI flow guarantees the private key lands
in your login keychain (a common past failure was a CSR whose key never entered the
keychain, orphaning every cert made from it).

1. **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**
2. Enter your Apple ID email, any Common Name, select **"Saved to disk"**.
3. Save `CertificateSigningRequest.certSigningRequest`.

This creates the new private key in `login.keychain`. **One CSR can be reused for both
certificates below.**

## Step 3 — Revoke old, create the two new certificates

At **[developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates)**:

1. **Revoke** the dead **Apple Distribution** and **Mac Installer Distribution** certs
   (frees the per-account cert count; safe here since nothing has shipped to MAS yet).
2. **+ → Apple Distribution** → upload the CSR → download the `.cer`.
   ⚠️ Pick **Apple _Distribution_**, not **Apple _Development_** (Development is only for
   the `mas-dev` sandbox smoke-test build).
3. **+ → Mac Installer Distribution** → upload the same CSR → download the `.cer`.

## Step 4 — Install both certs

Double-click each downloaded `.cer`. They import into the login keychain and pair with
the private key from Step 2 → two identities appear.

## Step 5 — Fix the WWDR "not trusted" chain (the recurring gotcha)

A freshly-issued Apple Distribution cert is issued by the **WWDR G3** intermediate. If
your keychain only has a newer generation (G5/G6), the chain can't build and Keychain
Access shows **"…certificate is not trusted"** — and an untrusted cert is **excluded**
from `find-identity`, so electron-builder can't discover it.

Diagnose the exact broken link:

```bash
# Extract the leaf and see which intermediate issued it (look for OU=G3 / G5…)
security find-certificate -a -c "Apple Distribution: Jason Figge" -p > /tmp/leaf.pem
openssl x509 -in /tmp/leaf.pem -noout -issuer          # e.g. …OU=G3…
security verify-cert -p codesign -c /tmp/leaf.pem      # CSSMERR_TP_NOT_TRUSTED if broken
```

Fix — install the matching intermediate from Apple (public cert, safe, no sudo):

```bash
curl -fSL -o /tmp/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
openssl x509 -inform DER -in /tmp/AppleWWDRCAG3.cer -noout -subject   # sanity: OU=G3
security import /tmp/AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db
```

> All Apple intermediates live at <https://www.apple.com/certificateauthority/>. If the
> leaf's issuer `OU=` shows a different generation, grab that `.cer` instead. Also delete
> any **expired** WWDR (the old Feb-2023 one) if present — it can confuse evaluation.

Verify the fix:

```bash
security verify-cert -p codesign -c /tmp/leaf.pem     # → "…verification successful."
security find-identity -v -p codesigning              # → lists Apple Distribution as valid
security find-identity -v | grep -i installer         # → 3rd Party Mac Developer Installer
```

## Step 6 — Regenerate the provisioning profile

The profile embeds the distribution certificate, so the **old profile still authorizes
the dead cert** and must be regenerated — otherwise the build succeeds locally but App
Store validation rejects it (and, for `mas-dev`, AMFI SIGKILLs the app at launch,
errno 153).

1. **[developer.apple.com → Profiles](https://developer.apple.com/account/resources/profiles)** → `Rest Hippo MAS Distribution` → **Edit**.
2. Select the **new** Apple Distribution cert → **Generate** → download the `.provisionprofile`.

Install it into the source tree and confirm the embedded cert matches the new identity:

```bash
# Compare embedded cert sha1 to the identity from `find-identity -v -p codesigning`
security cms -D -i <downloaded>.provisionprofile | python3 -c '
import sys, plistlib, hashlib
p = plistlib.loads(sys.stdin.buffer.read())
for c in p.get("DeveloperCertificates", []):
    print("embedded cert sha1:", hashlib.sha1(c).hexdigest().upper())
'
# If it matches, install it (path is gitignored — local only; CI rebuilds from a secret):
cp <downloaded>.provisionprofile src/packaging/embedded.provisionprofile
```

## Step 7 — Rebuild and verify

```bash
make dist-mas   # universal (x64+arm64) + signed .pkg → build/src/dist/mas-universal/
```

The signing log should end with the **right** identity and profile:

```
signing … platform=mas type=distribution
  identityName=Apple Distribution: Jason Figge (2C564TQ2FY)
  identityHash=<new-sha1>
  provisioningProfile=packaging/embedded.provisionprofile
```

Verify the artifacts:

```bash
cd build/src/dist/mas-universal
APP="Rest Hippo.app"; PKG=Rest-Hippo-*-universal.pkg

codesign --verify --deep --strict --verbose=2 "$APP"     # "valid on disk" / "satisfies its Designated Requirement"
codesign -dvvv "$APP" 2>&1 | grep -iE "Authority|TeamIdentifier"  # Apple Distribution → WWDR → Apple Root CA
lipo -archs "$APP/Contents/MacOS/Rest Hippo"             # x86_64 arm64
pkgutil --check-signature $PKG                           # 3rd Party Mac Developer Installer
# and confirm the app-embedded profile matches (same python decode as Step 6 on
# "$APP/Contents/embedded.provisionprofile")
```

> `pkgutil` labels the installer cert *"issued by Apple (Development)"* — a cosmetic
> quirk of the Mac Installer Distribution cert type, **not** a real dev cert. The chain
> shows the correct cert and App Store Connect accepts it.

## Step 8 — Back up the new keys (do this so it can't recur)

The lost key was never backed up — it only ever lived in the login keychain. Export both
new identities so a future keychain reset can't strand you.

In **Keychain Access → My Certificates**, export **each identity separately** (right-click
→ *Export…* → format **Personal Information Exchange (.p12)** → set an export password):

- `Apple Distribution: Jason Figge (2C564TQ2FY)` → `.keys/MAS_Application.p12`
- `3rd Party Mac Developer Installer: Jason Figge (2C564TQ2FY)` → `.keys/MAS_Installer.p12`

`.keys/` is gitignored (sits beside `DeveloperID.p12`), so these never get committed.

## Step 9 — Refresh CI secrets

The CI `store-mas` job (`.github/workflows/release.yml`) rebuilds the certs and profile
from repo secrets. Update all five after a re-issue:

```bash
gh secret set MAS_CSC_LINK                    < <(base64 -i .keys/MAS_Application.p12)
gh secret set MAS_INSTALLER_CSC_LINK          < <(base64 -i .keys/MAS_Installer.p12)
gh secret set MAS_PROVISIONING_PROFILE_BASE64 < <(base64 -i src/packaging/embedded.provisionprofile)
gh secret set MAS_CSC_KEY_PASSWORD            # type the MAS_Application.p12 export password
gh secret set MAS_INSTALLER_CSC_KEY_PASSWORD  # type the MAS_Installer.p12 export password
```

---

## Troubleshooting quick reference

| Symptom | Cause | Fix |
| --- | --- | --- |
| `0 valid identities found` | private key lost | Steps 2–4 (re-issue) |
| Keychain shows "certificate is not trusted"; cert absent from `find-identity` | missing WWDR intermediate (leaf issued by G3, keychain lacks it) | Step 5 (`security import AppleWWDRCAG3.cer`) |
| Cert never forms an identity, not even invalid | CSR's private key never entered keychain (openssl-style) | regenerate CSR via **Keychain Access** (Step 2), reissue |
| Build signs with **Developer ID Application** / `provisioningProfile=none` | auto-discovery picked the wrong cert (Developer ID sorts first) | ensure `CSC_NAME="Jason Figge (2C564TQ2FY)"` (Makefile `MAS_CSC_NAME`) |
| "Cannot find valid 3rd Party Mac Developer Installer identity" | `mas.identity` qualifier also filters the installer search | don't set `mas.identity`; pin `CSC_NAME` to the team-qualified suffix common to both certs |
| `.pkg` is `-arm64.pkg` (single-arch) | `mas.target` arch ignored when target is on the CLI | pass `--universal` (already in the `dist-mas` recipe) |
| App SIGKILLs at launch, errno 153, no crash report | stale profile authorizes the old/revoked cert | Step 6 (regenerate profile; embedded cert sha1 must match `find-identity`) |
