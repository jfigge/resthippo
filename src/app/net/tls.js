// tls.js — per-host client-certificate selection and custom-CA / client-cert
// material loading for the main-process HTTPS execution path (mTLS support).
//
// The selection helpers are pure and dependency-light (host matching is shared
// with the proxy bypass list via proxy.js, so the glob/suffix/port semantics are
// identical everywhere). File reads are injected so the loaders can be unit
// tested without touching disk; main.js passes the real `fs.readFileSync` and
// `tls.rootCertificates`.
"use strict";

const { hostBypassesProxy } = require("./proxy");

/**
 * Pick the configured client certificate for a request host, if any.
 *
 * Each entry's `host` is a single NO_PROXY-style pattern (exact, suffix,
 * `*.glob`, optional `:port`) — the same syntax used by the proxy bypass list,
 * reused here so there is one host-matching dialect across the app. The first
 * entry that matches wins (top-to-bottom precedence), so a specific host can be
 * listed above a broader wildcard.
 *
 * @param {string} host                 request hostname (no brackets/port)
 * @param {number|string} port          request port
 * @param {Array<object>} clientCerts   settings.clientCerts
 * @returns {object|null} the matching entry, or null when none match
 */
function selectClientCert(host, port, clientCerts) {
  if (!Array.isArray(clientCerts)) return null;
  for (const entry of clientCerts) {
    if (!entry || typeof entry !== "object" || !entry.host) continue;
    if (hostBypassesProxy(host, port, [entry.host])) return entry;
  }
  return null;
}

/**
 * Whether TLS verification should be skipped for `host:port` given a
 * NO_PROXY-style "insecure hosts" list. A thin, intention-revealing wrapper over
 * the shared matcher so the per-host SSL-verify override reads clearly at the
 * call site (and so one self-signed host can be trusted without flipping the
 * global `verifySsl`).
 *
 * @param {string} host
 * @param {number|string} port
 * @param {string|string[]} insecureHosts  raw list (textarea value)
 * @returns {boolean}
 */
function hostSkipsTlsVerify(host, port, insecureHosts) {
  if (!insecureHosts) return false;
  return hostBypassesProxy(host, port, insecureHosts);
}

/**
 * Read the certificate/key material for one client-cert entry into Buffers
 * suitable for Node's TLS options. PEM entries (`format: "pem"`) read `certPath`
 * + `keyPath`; PFX/P12 entries (`format: "pfx"`) read `pfxPath`. The decrypted
 * passphrase (already plaintext by this point — see crypto.js) is passed through
 * verbatim for whichever format needs it.
 *
 * A missing/unreadable path throws — a configured-but-broken certificate is a
 * hard error the caller surfaces in the Console rather than silently sending the
 * request with no client identity.
 *
 * @param {object} entry                    a settings.clientCerts entry
 * @param {(p: string) => Buffer} readFile  injected reader (fs.readFileSync)
 * @returns {{ cert?: Buffer, key?: Buffer, pfx?: Buffer, passphrase?: string }}
 */
function loadClientCertMaterial(entry, readFile) {
  const out = {};
  if (entry.format === "pfx") {
    if (!entry.pfxPath)
      throw new Error("client certificate is missing a PFX file");
    out.pfx = readFile(entry.pfxPath);
  } else {
    if (!entry.certPath)
      throw new Error("client certificate is missing a cert file");
    out.cert = readFile(entry.certPath);
    if (entry.keyPath) out.key = readFile(entry.keyPath);
  }
  if (entry.passphrase) out.passphrase = entry.passphrase;
  return out;
}

/**
 * Read every configured custom CA file and merge it with the system root store,
 * so a privately-signed host validates WITH verification still on while public
 * CAs keep working. Unreadable CA files are skipped (best-effort) and reported
 * via the optional `onError` callback rather than aborting the request.
 *
 * Returns null when there is nothing to add (no custom CAs), so the caller can
 * leave Node's default trust store untouched in the common case.
 *
 * @param {string[]} caPaths               settings.caCerts (file paths)
 * @param {(p: string) => Buffer} readFile injected reader (fs.readFileSync)
 * @param {string[]} systemRoots           tls.rootCertificates
 * @param {(path: string, err: Error) => void} [onError]
 * @returns {Buffer[]|null} merged CA list, or null when no custom CA configured
 */
function loadCaBundle(caPaths, readFile, systemRoots, onError) {
  if (!Array.isArray(caPaths) || caPaths.length === 0) return null;
  const custom = [];
  for (const p of caPaths) {
    if (!p) continue;
    try {
      custom.push(readFile(p));
    } catch (err) {
      onError?.(p, err);
    }
  }
  if (custom.length === 0) return null;
  return [...(Array.isArray(systemRoots) ? systemRoots : []), ...custom];
}

module.exports = {
  selectClientCert,
  hostSkipsTlsVerify,
  loadClientCertMaterial,
  loadCaBundle,
};
