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
 * ntlm.js — NTLM (NT LAN Manager) authentication, vendored & dependency-free.
 *
 * Implements the three NTLM messages used for HTTP authentication
 * (MS-NLMP, [MS-NLMP].pdf):
 *
 *   Type 1 (NEGOTIATE)     — client → server, advertises capabilities
 *   Type 2 (CHALLENGE)     — server → client, carries an 8-byte challenge
 *   Type 3 (AUTHENTICATE)  — client → server, carries the NTLMv2 response
 *
 * NTLM is **connection-bound**: the Type 2 challenge and the Type 3 response
 * must travel on the SAME keep-alive socket. This module only builds/parses the
 * message bytes; the socket-pinned handshake itself lives in the main process
 * (main.js) where the request executes — see the `_ntlmNegotiate` /
 * `_ntlmAuthorized` path there.
 *
 * Why vendored rather than an npm dependency:
 *   - The NT hash requires MD4, which OpenSSL 3.x (shipped with Electron 42)
 *     removed — `crypto.createHash("md4")` throws ERR_OSSL_EVP_UNSUPPORTED — so
 *     a pure-JS MD4 (RFC 1320, below) is unavoidable regardless of dependency.
 *   - No mainstream NTLM library fits our raw-http model: they bundle their own
 *     HTTP stack and cannot pin the single socket the handshake demands.
 *   - The remaining surface is small and fully specified, so a self-contained
 *     module is auditable and avoids a heavy/unmaintained dependency.
 *
 * Crypto provenance: MD4 is implemented here (RFC 1320). HMAC-MD5, the random
 * client challenge, and all byte plumbing use Node's `crypto`. The
 * `clientChallenge` and `time` inputs are injectable so output is deterministic
 * under test; in production they default to 8 random bytes and the current
 * Windows FILETIME.
 */
"use strict";

const crypto = require("crypto");

const NTLMSSP_SIGNATURE = Buffer.from("NTLMSSP\0", "latin1"); // 8 bytes

// ── NTLM negotiate flags (MS-NLMP 2.2.2.5) ───────────────────────────────────
const FLAGS = {
  NEGOTIATE_UNICODE: 0x00000001,
  NEGOTIATE_OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  NEGOTIATE_SIGN: 0x00000010,
  NEGOTIATE_SEAL: 0x00000020,
  NEGOTIATE_NTLM: 0x00000200,
  NEGOTIATE_ALWAYS_SIGN: 0x00008000,
  NEGOTIATE_EXTENDED_SESSIONSECURITY: 0x00080000,
  NEGOTIATE_TARGET_INFO: 0x00800000,
  NEGOTIATE_VERSION: 0x02000000,
  NEGOTIATE_128: 0x20000000,
  NEGOTIATE_56: 0x80000000,
};

// AV-pair ids inside a Type 2 TargetInfo block (MS-NLMP 2.2.2.1).
const AV_EOL = 0x0000;
const AV_TIMESTAMP = 0x0007;

// 100-ns ticks between 1601-01-01 (FILETIME epoch) and 1970-01-01 (Unix epoch).
const FILETIME_EPOCH_OFFSET = 11644473600000n;

// ── MD4 (RFC 1320) ───────────────────────────────────────────────────────────
// Pure-JS because OpenSSL 3.x no longer provides md4. Operates on a Buffer and
// returns a 16-byte Buffer.

function _rotl(x, s) {
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

function md4(buf) {
  const len = buf.length;
  // Padding: 0x80, then zeros, then the 64-bit LE bit-length.
  const bitLen = BigInt(len) * 8n;
  const padded = Buffer.alloc((((len + 8) >> 6) + 1) << 6);
  buf.copy(padded);
  padded[len] = 0x80;
  padded.writeUInt32LE(Number(bitLen & 0xffffffffn), padded.length - 8);
  padded.writeUInt32LE(
    Number((bitLen >> 32n) & 0xffffffffn),
    padded.length - 4,
  );

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const x = new Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4);

    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    // Round 1: F(x,y,z) = (x & y) | (~x & z)
    const ff = (a, b, c, d, k, s) =>
      _rotl((a + (((b & c) | (~b & d)) >>> 0) + x[k]) >>> 0, s);
    for (let i = 0; i < 16; i += 4) {
      a = ff(a, b, c, d, i + 0, 3);
      d = ff(d, a, b, c, i + 1, 7);
      c = ff(c, d, a, b, i + 2, 11);
      b = ff(b, c, d, a, i + 3, 19);
    }

    // Round 2: G(x,y,z) = (x & y) | (x & z) | (y & z), const 0x5A827999
    const gg = (a, b, c, d, k, s) =>
      _rotl(
        (a + (((b & c) | (b & d) | (c & d)) >>> 0) + x[k] + 0x5a827999) >>> 0,
        s,
      );
    for (let i = 0; i < 4; i++) {
      a = gg(a, b, c, d, i + 0, 3);
      d = gg(d, a, b, c, i + 4, 5);
      c = gg(c, d, a, b, i + 8, 9);
      b = gg(b, c, d, a, i + 12, 13);
    }

    // Round 3: H(x,y,z) = x ^ y ^ z, const 0x6ED9EBA1, k in bit-reversed order
    const hh = (a, b, c, d, k, s) =>
      _rotl((a + ((b ^ c ^ d) >>> 0) + x[k] + 0x6ed9eba1) >>> 0, s);
    const order3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i += 4) {
      a = hh(a, b, c, d, order3[i + 0], 3);
      d = hh(d, a, b, c, order3[i + 1], 9);
      c = hh(c, d, a, b, order3[i + 2], 11);
      b = hh(b, c, d, a, order3[i + 3], 15);
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

// ── Key derivation (MS-NLMP 3.3.2, NTLMv2) ───────────────────────────────────

/** NTLM NT hash: MD4 of the UTF-16LE password. */
function _ntHash(password) {
  return md4(Buffer.from(String(password), "utf16le"));
}

/**
 * NTOWFv2 = HMAC_MD5(NTHash, UNICODE(UPPERCASE(user) + domain)).
 * `domain` is the *user's* domain (may be empty); the user is uppercased, the
 * domain is taken verbatim, per spec.
 */
function _ntowfv2(password, user, domain) {
  const ntHash = _ntHash(password);
  const id = Buffer.from(
    String(user).toUpperCase() + String(domain || ""),
    "utf16le",
  );
  return crypto.createHmac("md5", ntHash).update(id).digest();
}

function _hmacMd5(key, data) {
  return crypto.createHmac("md5", key).update(data).digest();
}

// ── Type 1 (NEGOTIATE) ────────────────────────────────────────────────────────

/**
 * Build the Type 1 negotiate message. Domain/workstation payloads are omitted
 * (length 0) — modern servers don't require them in Type 1, and the values that
 * matter are carried in Type 3.
 *
 * @returns {string} `NTLM <base64>` for use as the Authorization header value.
 */
function createType1Message() {
  const flags =
    FLAGS.NEGOTIATE_UNICODE |
    FLAGS.NEGOTIATE_OEM |
    FLAGS.REQUEST_TARGET |
    FLAGS.NEGOTIATE_NTLM |
    FLAGS.NEGOTIATE_ALWAYS_SIGN |
    FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY;

  const buf = Buffer.alloc(32);
  NTLMSSP_SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(1, 8); // MessageType = 1
  buf.writeUInt32LE(flags >>> 0, 12); // NegotiateFlags
  // DomainNameFields (16) and WorkstationFields (24): all zero (len/maxlen 0,
  // offset 0) — no payload follows.
  return "NTLM " + buf.toString("base64");
}

// ── Type 2 (CHALLENGE) ─────────────────────────────────────────────────────────

/**
 * From the raw (un-joined) WWW-Authenticate header values of a 401 response,
 * return the base64 blob of the first `NTLM <base64>` challenge, or null.
 *
 * The bare `NTLM` token (the initial offer, no blob) is skipped — only a
 * challenge that actually carries Type 2 bytes is returned.
 *
 * @param {string[]} rawValues
 * @returns {string|null}
 */
function selectNtlmChallenge(rawValues) {
  if (!Array.isArray(rawValues)) return null;
  for (const v of rawValues) {
    const m = /^\s*NTLM\s+([A-Za-z0-9+/=]+)\s*$/.exec(v || "");
    if (m) return m[1];
  }
  return null;
}

/**
 * Parse a base64 Type 2 message into its salient fields.
 *
 * @param {string} base64
 * @returns {{challenge: Buffer, flags: number, targetInfo: Buffer,
 *            targetName: Buffer, timestamp: bigint|null} | null}
 */
function decodeType2Message(base64) {
  let buf;
  try {
    buf = Buffer.from(String(base64), "base64");
  } catch {
    return null;
  }
  if (buf.length < 32) return null;
  if (!buf.subarray(0, 8).equals(NTLMSSP_SIGNATURE)) return null;
  if (buf.readUInt32LE(8) !== 2) return null; // MessageType must be 2

  const targetNameLen = buf.readUInt16LE(12);
  const targetNameOff = buf.readUInt32LE(16);
  const flags = buf.readUInt32LE(20);
  const challenge = Buffer.from(buf.subarray(24, 32)); // 8-byte server challenge

  let targetName = Buffer.alloc(0);
  if (targetNameLen > 0 && targetNameOff + targetNameLen <= buf.length) {
    targetName = Buffer.from(
      buf.subarray(targetNameOff, targetNameOff + targetNameLen),
    );
  }

  // TargetInfoFields live at offset 40 (8 bytes after the 8-byte Reserved at 32)
  // and are only present when the message is long enough to contain them.
  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const tiLen = buf.readUInt16LE(40);
    const tiOff = buf.readUInt32LE(44);
    if (tiLen > 0 && tiOff + tiLen <= buf.length) {
      targetInfo = Buffer.from(buf.subarray(tiOff, tiOff + tiLen));
    }
  }

  return {
    challenge,
    flags,
    targetInfo,
    targetName,
    timestamp: _findAvTimestamp(targetInfo),
  };
}

/** Scan a TargetInfo AV-pair block for the MsvAvTimestamp (id 0x07). */
function _findAvTimestamp(targetInfo) {
  let off = 0;
  while (off + 4 <= targetInfo.length) {
    const id = targetInfo.readUInt16LE(off);
    const len = targetInfo.readUInt16LE(off + 2);
    if (id === AV_EOL) break;
    if (id === AV_TIMESTAMP && off + 4 + 8 <= targetInfo.length) {
      return targetInfo.readBigUInt64LE(off + 4);
    }
    off += 4 + len;
  }
  return null;
}

// ── Type 3 (AUTHENTICATE) ──────────────────────────────────────────────────────

/**
 * Compute the NTLMv2 LM and NT challenge responses (MS-NLMP 3.3.2).
 *
 * @returns {{ntChallengeResponse: Buffer, lmChallengeResponse: Buffer,
 *            ntProofStr: Buffer}}
 */
function _computeResponses({
  password,
  user,
  domain,
  serverChallenge,
  targetInfo,
  clientChallenge,
  time,
}) {
  const ntowfv2 = _ntowfv2(password, user, domain);

  // temp = Responserversion(1) || HiResponserversion(1) || Z(6) ||
  //        Time(8) || ClientChallenge(8) || Z(4) || TargetInfo || Z(4)
  const temp = Buffer.concat([
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    _filetimeBuf(time),
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);

  const ntProofStr = _hmacMd5(ntowfv2, Buffer.concat([serverChallenge, temp]));
  const ntChallengeResponse = Buffer.concat([ntProofStr, temp]);

  const lmProof = _hmacMd5(
    ntowfv2,
    Buffer.concat([serverChallenge, clientChallenge]),
  );
  const lmChallengeResponse = Buffer.concat([lmProof, clientChallenge]);

  return { ntChallengeResponse, lmChallengeResponse, ntProofStr };
}

/** 8-byte little-endian Windows FILETIME for a bigint tick count. */
function _filetimeBuf(time) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(time), 0);
  return out;
}

/**
 * Build the Type 3 authenticate message answering a decoded Type 2.
 *
 * Username may be supplied bare, or as `DOMAIN\\user` (the domain is split out
 * when no explicit `domain` is given). Strings are encoded UTF-16LE since we
 * negotiate Unicode.
 *
 * @param {object}  opts
 * @param {object}  opts.type2             result of decodeType2Message()
 * @param {string}  opts.username
 * @param {string}  opts.password
 * @param {string} [opts.domain]
 * @param {string} [opts.workstation]
 * @param {Buffer} [opts.clientChallenge]  8 bytes; random in production
 * @param {bigint} [opts.time]             FILETIME ticks; injectable for tests
 * @returns {string} `NTLM <base64>`
 */
function createType3Message({
  type2,
  username,
  password,
  domain = "",
  workstation = "",
  clientChallenge,
  time,
}) {
  // Split DOMAIN\user when no explicit domain was provided.
  let user = String(username || "");
  let dom = String(domain || "");
  if (!dom) {
    const slash = user.indexOf("\\");
    if (slash >= 0) {
      dom = user.slice(0, slash);
      user = user.slice(slash + 1);
    }
  }

  const cc =
    clientChallenge && clientChallenge.length === 8
      ? clientChallenge
      : crypto.randomBytes(8);

  // Prefer the server-supplied timestamp (AV pair) so the response isn't
  // rejected for clock skew; fall back to the injected/current time.
  let ticks;
  if (time !== undefined && time !== null) {
    ticks = BigInt(time);
  } else if (type2.timestamp !== null && type2.timestamp !== undefined) {
    ticks = type2.timestamp;
  } else {
    ticks = (BigInt(Date.now()) + FILETIME_EPOCH_OFFSET) * 10000n;
  }

  const { ntChallengeResponse, lmChallengeResponse } = _computeResponses({
    password,
    user,
    domain: dom,
    serverChallenge: type2.challenge,
    targetInfo: type2.targetInfo,
    clientChallenge: cc,
    time: ticks,
  });

  const domBuf = Buffer.from(dom, "utf16le");
  const userBuf = Buffer.from(user, "utf16le");
  const wsBuf = Buffer.from(String(workstation || ""), "utf16le");

  const flags =
    FLAGS.NEGOTIATE_UNICODE |
    FLAGS.REQUEST_TARGET |
    FLAGS.NEGOTIATE_NTLM |
    FLAGS.NEGOTIATE_ALWAYS_SIGN |
    FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY;

  // Fixed header is 64 bytes (no Version, no MIC); payload follows in the order
  // LM, NT, Domain, User, Workstation, (empty) SessionKey.
  const HEADER = 64;
  const payloads = [
    lmChallengeResponse,
    ntChallengeResponse,
    domBuf,
    userBuf,
    wsBuf,
    Buffer.alloc(0), // EncryptedRandomSessionKey
  ];
  const totalPayload = payloads.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.alloc(HEADER + totalPayload);

  NTLMSSP_SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(3, 8); // MessageType = 3

  let off = HEADER;
  // Each security buffer: Len(2), MaxLen(2), Offset(4).
  const writeField = (fieldOff, payload) => {
    buf.writeUInt16LE(payload.length, fieldOff);
    buf.writeUInt16LE(payload.length, fieldOff + 2);
    buf.writeUInt32LE(payload.length ? off : 0, fieldOff + 4);
    payload.copy(buf, off);
    off += payload.length;
  };

  writeField(12, lmChallengeResponse); // LmChallengeResponseFields
  writeField(20, ntChallengeResponse); // NtChallengeResponseFields
  writeField(28, domBuf); // DomainNameFields
  writeField(36, userBuf); // UserNameFields
  writeField(44, wsBuf); // WorkstationFields
  writeField(52, Buffer.alloc(0)); // EncryptedRandomSessionKeyFields
  buf.writeUInt32LE(flags >>> 0, 60); // NegotiateFlags

  return "NTLM " + buf.toString("base64");
}

module.exports = {
  createType1Message,
  selectNtlmChallenge,
  decodeType2Message,
  createType3Message,
  // Exposed for unit tests against the MS-NLMP §4.2 reference vectors.
  md4,
  _ntHash,
  _ntowfv2,
  _computeResponses,
  FLAGS,
};
