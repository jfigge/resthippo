# Rest Hippo — Encryption / Export-Compliance Summary

**Product:** Rest Hippo (`com.resthippo.app`)
**Version:** 1.0.0
**Manufacturer / Author:** Jason Figge
**Item type:** Cross-platform desktop application (Electron) — REST/GraphQL API client
**Prepared:** 2026-07-07

> **What this document is.** A technical description of every cryptographic
> function Rest Hippo contains, written to support U.S. export-compliance
> classification (EAR Category 5, Part 2), the App Store Connect *App Encryption
> Documentation* upload, and the French (ANSSI) encryption declaration. It is a
> factual engineering description of the shipping code, **not legal advice**; the
> classification statements below are a good-faith self-assessment that you
> should confirm before filing (see *Disclaimer*).

---

## 1. Summary determination

- Rest Hippo's **primary function is a networking client** (composing and sending
  HTTP/GraphQL/WebSocket requests and displaying responses). Cryptography is
  **ancillary** to that function — it is used only to (a) secure network
  transport (HTTPS/TLS/WSS), (b) authenticate requests to third-party APIs, and
  (c) protect the user's saved credentials at rest on their own machine.
- **All algorithms are standard and published** (NIST / FIPS / IETF RFC / IEEE).
  **No proprietary or non-standard encryption is implemented.**
- The strongest data-confidentiality primitive is **AES-256-GCM**, used only for
  local at-rest protection of user-entered secrets; symmetric key length is
  256 bits.
- **Candidate U.S. classification:** **ECCN 5D992.c** — *mass-market encryption
  software* — eligible for self-classification and the annual self-classification
  report under License Exception ENC, §740.17(b)(1). An "ancillary cryptography"
  argument (Note 4 to Category 5, Part 2 → **EAR99**) is also plausible given the
  networking-client primary function; either way the item is **not** on the more
  tightly controlled 5A002/5D002 lines. Confirm before you file.

This maps to the App Store Connect questionnaire as:

| App Store Connect question | Answer |
|---|---|
| Does your app use encryption? | **Yes** |
| Proprietary / non-standard algorithms? | **No** |
| Standard algorithms beyond Apple's OS crypto? | **Yes** — the app bundles its own crypto runtime (see §4) |
| Qualifies for a Category 5 Part 2 exemption? | **Likely yes** (mass-market / ancillary) — this is the answer that removes the documentation-upload requirement |

---

## 2. Cryptographic inventory

Every cryptographic operation in the shipping product. "Where" cites the
first-party source; "Provider" names what actually computes it.

### 2.1 Data confidentiality (symmetric encryption)

| Function | Algorithm | Key length | Standard | Where | Provider |
|---|---|---|---|---|---|
| Encrypt saved secrets at rest — *app-key* mode (`enck:v1:`) | AES-256-GCM (96-bit IV, 128-bit tag) | 256-bit | NIST SP 800-38D, FIPS 197 | `src/app/store/crypto.js` | Node/OpenSSL (bundled) |
| Encrypt saved secrets at rest — *master-password* mode (`encm:v1:`) | AES-256-GCM | 256-bit | NIST SP 800-38D, FIPS 197 | `src/app/store/crypto.js` | Node/OpenSSL (bundled) |
| Encrypt portable backups / exports (`encp:v1:` / `encp:v2:`) | AES-256-GCM | 256-bit | NIST SP 800-38D, FIPS 197 | `src/app/store/crypto.js` | Node/OpenSSL (bundled) |
| Encrypt saved secrets at rest — *os-keychain* mode (`enc:v1:`) | OS-provided (AES via Keychain / DPAPI / libsecret) | OS-defined | — | `src/app/store/crypto.js` (`safeStorage`) | **macOS Keychain / Windows DPAPI / Linux libsecret (OS)** |

### 2.2 Key derivation

| Function | Algorithm | Params | Standard | Where |
|---|---|---|---|---|
| Derive 256-bit key from master password | PBKDF2-HMAC-SHA256 | 210,000 iterations, 16-byte salt, 32-byte output | NIST SP 800-132 / RFC 8018 | `src/app/store/crypto.js` (`deriveKey`) |

### 2.3 Authentication & integrity (HMAC / signing — not confidentiality)

| Function | Algorithm | Standard | Where |
|---|---|---|---|
| AWS Signature V4 request signing | HMAC-SHA256 / HMAC-SHA512 + SHA-256/512 | AWS SigV4 | `src/app/main.js` |
| OAuth 1.0a request signing | HMAC-SHA1 / HMAC-SHA256 | RFC 5849 | `src/app/auth/oauth1.js` |
| HTTP Digest authentication | MD5 / SHA-256 | RFC 7616 | `src/app/auth/digest.js` |
| NTLM authentication | MD4 (NT hash), HMAC-MD5 (NTOWFv2) | MS-NLMP / RFC 1320 | `src/app/auth/ntlm.js` |
| OAuth 2.0 PKCE code challenge | SHA-256 ("S256") | RFC 7636 | `src/web/scripts/auth/` |

> Note: MD4 is a *pure-JS* implementation (RFC 1320) because OpenSSL 3.x removed
> it; it is a hash used only inside the NTLM handshake, not a confidentiality
> cipher. MD5/MD4/SHA-1 here exist solely for interoperability with the named
> legacy authentication protocols.

### 2.4 Transport security (asymmetric + symmetric, negotiated)

| Function | Algorithm | Standard | Where | Provider |
|---|---|---|---|---|
| HTTPS to target APIs; secure WebSocket (WSS) | TLS 1.2 / 1.3 — RSA/ECDHE key exchange, AES-GCM / ChaCha20-Poly1305 record encryption | IETF RFC 8446 / 5246 | `src/app/net/http-engine.js`, `src/app/net/websocket.js` | Node/OpenSSL + Chromium/BoringSSL (bundled) |
| mTLS client certificates | User-supplied PEM (cert+key) or PKCS#12/PFX; RSA or ECDSA client keys | RFC 8446, PKCS#12 | `src/app/net/http-engine.js`, `src/app/net/tls.js` | Node/OpenSSL (bundled) |

### 2.5 Random number generation

| Function | Source | Where |
|---|---|---|
| IVs, salts, keys, nonces | CSPRNG (`crypto.randomBytes`, OpenSSL) | throughout `src/app` |

**No key-escrow, no custom/proprietary cipher, no cryptanalytic functionality is
present.** The app performs no encryption of user *content in transit on the
network beyond standard TLS*, and no encryption of data *for other parties* — the
at-rest AES protects only the local user's own stored credentials.

---

## 3. Cryptographic libraries (provenance)

| Library | Role | Origin |
|---|---|---|
| OpenSSL (via Node.js in Electron 42) | AES-GCM, PBKDF2, HMAC, SHA-2, TLS, randomness | Bundled in the app |
| BoringSSL (via Chromium in Electron 42) | TLS for any Chromium-originated network I/O | Bundled in the app |
| Electron `safeStorage` | OS-keystore at-rest mode | OS-provided (Keychain / DPAPI / libsecret) |
| First-party MD4 (RFC 1320) | NTLM NT hash only | `src/app/auth/ntlm.js` |

Because the app bundles OpenSSL/BoringSSL, even plain HTTPS calls do **not** rely
solely on Apple's operating-system encryption — which is why the correct App
Store Connect answer to "standard algorithms beyond Apple's OS" is *Yes*.

---

## 4. U.S. export classification — for the filing you choose

If you proceed with **self-classification (ECCN 5D992.c)** rather than claiming a
straight exemption, the annual **self-classification report** (Supplement No. 8
to Part 742 of the EAR, emailed to `crypt@bis.doc.gov` and `enc@nsa.gov`) needs
these fields. Values below are pre-filled from this app:

| Report column | Value |
|---|---|
| Product name / model | Rest Hippo 1.0.0 |
| Manufacturer | Jason Figge |
| ECCN | 5D992.c |
| Item type | Application software (desktop) |
| Primary purpose | REST/GraphQL API client (networking) |
| Symmetric algorithm & key length | AES, 256-bit |
| Asymmetric algorithm & key length | RSA / ECDHE (TLS-negotiated); RSA/ECDSA client certs (user-supplied) |
| Key-exchange & key length | ECDHE / RSA (TLS 1.2–1.3) |
| Hash | SHA-256, SHA-512 (plus MD5/MD4/SHA-1 for legacy auth interop) |
| Non-standard crypto? | No |
| Open cryptographic interface? | No |

A CCATS is **not** required for 5D992.c mass-market self-classification; an
Encryption Registration Number (ERN) is obtained once via BIS SNAP-R.

---

## 5. France (ANSSI) declaration

France requires a declaration for the supply/import of a means of cryptology
unless it qualifies for an exemption (means limited to authentication/integrity,
or a qualifying mass-market product). Rest Hippo's confidentiality use is limited
to **local at-rest protection of the user's own credentials** plus standard TLS
transport. The technical content required for the ANSSI dossier is exactly §2–§3
above (functions, algorithms, key lengths, and library provenance). Apple's
[export-compliance overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
routes this through the App Encryption Documentation upload once approved.

---

## 6. Action items (only you can do these)

1. **Decide exempt vs. self-classified.** Claiming a Category 5 Part 2 exemption
   in App Store Connect removes the upload requirement entirely; §1 explains why
   the app likely qualifies.
2. If self-classifying: register once via **BIS SNAP-R** to obtain an **ERN**, and
   file the **annual self-classification report** (§4) to BIS + NSA.
3. Upload this summary (as PDF) into **App Store Connect → App Encryption
   Documentation** when prompted; Apple returns a key value.
4. To stop being asked every version, set
   `ITSAppUsesNonExemptEncryption` in the MAS build's `Info.plist`
   (`mas.extendInfo` in `src/package.json`) — `false` if you conclude the
   encryption is exempt, `true` if non-exempt-and-documented.

---

## 7. Disclaimer

This document is a good-faith technical description of the shipping code and a
self-assessment of its likely classification. It is **not legal advice**. Export
classification (ECCN 5D992.c vs. an exemption vs. EAR99) and the France/ANSSI
determination are attestations for which the publisher is responsible; confirm
against the EAR, Apple's export-compliance documentation, or qualified counsel
before filing.
