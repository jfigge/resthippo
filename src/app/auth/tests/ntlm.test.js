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
 * ntlm.test.js — Unit tests for the vendored NTLM module.
 *
 * The NTLMv2 chain is validated against the Microsoft [MS-NLMP] §4.2.4
 * reference vectors ("NTLMv2 Authentication"), which fix every input
 * (user/domain/password, server & client challenges, timestamp, target info)
 * and publish the expected NTOWFv2, NTProofStr and LMv2 outputs. Matching them
 * byte-for-byte proves MD4, HMAC-MD5 keying, the temp/blob layout, and the
 * UTF-16LE identity encoding are all correct.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ntlm = require("../ntlm");

const hex = (buf) => Buffer.from(buf).toString("hex");

// ── MD4 known-answer tests (RFC 1320 Appendix A.5) ───────────────────────────
test("md4 — RFC 1320 test suite", () => {
  const md4hex = (s) => hex(ntlm.md4(Buffer.from(s, "latin1")));
  assert.equal(md4hex(""), "31d6cfe0d16ae931b73c59d7e0c089c0");
  assert.equal(md4hex("a"), "bde52cb31de33e46245e05fbdbd6fb24");
  assert.equal(md4hex("abc"), "a448017aaf21d8525fc10ae87aa6729d");
  assert.equal(md4hex("message digest"), "d9130a8164549fe818874806e1c7014b");
  assert.equal(
    md4hex("abcdefghijklmnopqrstuvwxyz"),
    "d79e1c308aa5bbcdeea8ed63df412da9",
  );
  assert.equal(
    md4hex(
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    ),
    "e33b4ddc9c38f2199c3e7b164fcc0536",
  );
});

test("NT hash — MD4 of UTF-16LE password", () => {
  // The textbook NT hash of "password" (lowercase).
  assert.equal(
    hex(ntlm._ntHash("password")),
    "8846f7eaee8fb117ad06bdd830b7586c",
  );
  // MS-NLMP §4.2.4 uses "Password" (capital P); this hash feeds NTOWFv2 below.
  assert.equal(
    hex(ntlm._ntHash("Password")),
    "a4f49c406510bdcab6824ee7c30fd852",
  );
});

// ── MS-NLMP §4.2.4 reference vectors ─────────────────────────────────────────
// Fixed inputs from §4.2.1 / §4.2.4.
const SERVER_CHALLENGE = Buffer.from("0123456789abcdef", "hex");
const CLIENT_CHALLENGE = Buffer.alloc(8, 0xaa);
const TIME = 0n;

// §4.2.4.1.3 TargetInfo: NbDomainName="Domain", NbComputerName="Server", EOL.
const TARGET_INFO = Buffer.from(
  "02000c0044006f006d00610069006e00" +
    "01000c0053006500720076006500720000000000",
  "hex",
);

test("MS-NLMP §4.2.4.1.1 — NTOWFv2('Password','User','Domain')", () => {
  assert.equal(
    hex(ntlm._ntowfv2("Password", "User", "Domain")),
    "0c868a403bfd7a93a3001ef22ef02e3f",
  );
});

test("MS-NLMP §4.2.4.2 — NTProofStr and LMv2 response", () => {
  const { ntProofStr, ntChallengeResponse, lmChallengeResponse } =
    ntlm._computeResponses({
      password: "Password",
      user: "User",
      domain: "Domain",
      serverChallenge: SERVER_CHALLENGE,
      targetInfo: TARGET_INFO,
      clientChallenge: CLIENT_CHALLENGE,
      time: TIME,
    });

  // §4.2.4.2.2 NTProofStr
  assert.equal(hex(ntProofStr), "68cd0ab851e51c96aabc927bebef6a1c");
  // NtChallengeResponse begins with NTProofStr, then the temp blob.
  assert.equal(hex(ntChallengeResponse.subarray(0, 16)), hex(ntProofStr));
  // §4.2.4.2.1 LMv2 response (HMAC || client challenge)
  assert.equal(
    hex(lmChallengeResponse),
    "86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa",
  );
});

// ── Type 1 ───────────────────────────────────────────────────────────────────
test("createType1Message — valid NTLMSSP negotiate", () => {
  const header = ntlm.createType1Message();
  assert.match(header, /^NTLM [A-Za-z0-9+/=]+$/);
  const buf = Buffer.from(header.slice(5), "base64");
  assert.equal(buf.subarray(0, 8).toString("latin1"), "NTLMSSP\0");
  assert.equal(buf.readUInt32LE(8), 1); // MessageType = 1
  // Flags must advertise Unicode + NTLM + extended session security.
  const flags = buf.readUInt32LE(12);
  assert.ok(flags & ntlm.FLAGS.NEGOTIATE_UNICODE);
  assert.ok(flags & ntlm.FLAGS.NEGOTIATE_NTLM);
  assert.ok(flags & ntlm.FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY);
});

// ── Type 2 selection + decode ────────────────────────────────────────────────
test("selectNtlmChallenge — picks the blob, skips the bare offer", () => {
  assert.equal(ntlm.selectNtlmChallenge(["NTLM dGVzdA=="]), "dGVzdA==");
  assert.equal(ntlm.selectNtlmChallenge(["NTLM"]), null);
  assert.equal(
    ntlm.selectNtlmChallenge(["Basic realm=x", "NTLM YWJj"]),
    "YWJj",
  );
  assert.equal(ntlm.selectNtlmChallenge(["Negotiate", "Basic"]), null);
  assert.equal(ntlm.selectNtlmChallenge(null), null);
});

/** Build a minimal but well-formed Type 2 CHALLENGE message for round-trips. */
function buildType2({ challenge, targetInfo, targetName }) {
  const HEADER = 48; // no Version field
  const tnOff = HEADER;
  const tiOff = HEADER + targetName.length;
  const buf = Buffer.alloc(tiOff + targetInfo.length);
  Buffer.from("NTLMSSP\0", "latin1").copy(buf, 0);
  buf.writeUInt32LE(2, 8); // MessageType = 2
  buf.writeUInt16LE(targetName.length, 12);
  buf.writeUInt16LE(targetName.length, 14);
  buf.writeUInt32LE(targetName.length ? tnOff : 0, 16);
  buf.writeUInt32LE(
    ntlm.FLAGS.NEGOTIATE_UNICODE |
      ntlm.FLAGS.NEGOTIATE_NTLM |
      ntlm.FLAGS.NEGOTIATE_TARGET_INFO |
      ntlm.FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY,
    20,
  );
  challenge.copy(buf, 24); // ServerChallenge
  buf.writeUInt16LE(targetInfo.length, 40);
  buf.writeUInt16LE(targetInfo.length, 42);
  buf.writeUInt32LE(targetInfo.length ? tiOff : 0, 44);
  targetName.copy(buf, tnOff);
  targetInfo.copy(buf, tiOff);
  return buf.toString("base64");
}

test("decodeType2Message — extracts challenge, flags, target info", () => {
  const b64 = buildType2({
    challenge: SERVER_CHALLENGE,
    targetInfo: TARGET_INFO,
    targetName: Buffer.from("Domain", "utf16le"),
  });
  const t2 = ntlm.decodeType2Message(b64);
  assert.ok(t2);
  assert.equal(hex(t2.challenge), "0123456789abcdef");
  assert.equal(hex(t2.targetInfo), hex(TARGET_INFO));
  assert.ok(t2.flags & ntlm.FLAGS.NEGOTIATE_TARGET_INFO);
  assert.equal(t2.timestamp, null); // §4.2.4 target info has no AV_TIMESTAMP
});

test("decodeType2Message — rejects malformed input", () => {
  assert.equal(ntlm.decodeType2Message("not base64 @@@"), null);
  assert.equal(ntlm.decodeType2Message(""), null);
  assert.equal(
    ntlm.decodeType2Message(
      Buffer.from("NTLMSSP\0", "latin1").toString("base64"),
    ),
    null, // too short / wrong type
  );
});

test("decodeType2Message — reads AV_TIMESTAMP when present", () => {
  const ts = 0x01d71b1b6b3aee00n;
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64LE(ts);
  const ti = Buffer.concat([
    Buffer.from("07000800", "hex"), // AV id 7 (timestamp), len 8
    tsBuf, // FILETIME
    Buffer.from("00000000", "hex"), // EOL
  ]);
  const b64 = buildType2({
    challenge: SERVER_CHALLENGE,
    targetInfo: ti,
    targetName: Buffer.alloc(0),
  });
  const t2 = ntlm.decodeType2Message(b64);
  assert.equal(t2.timestamp, ts);
});

// ── Type 3 end-to-end ────────────────────────────────────────────────────────
test("createType3Message — embeds the §4.2.4 NTProofStr", () => {
  const b64 = buildType2({
    challenge: SERVER_CHALLENGE,
    targetInfo: TARGET_INFO,
    targetName: Buffer.from("Domain", "utf16le"),
  });
  const t2 = ntlm.decodeType2Message(b64);
  const header = ntlm.createType3Message({
    type2: t2,
    username: "User",
    password: "Password",
    domain: "Domain",
    clientChallenge: CLIENT_CHALLENGE,
    time: TIME,
  });
  assert.match(header, /^NTLM [A-Za-z0-9+/=]+$/);

  const buf = Buffer.from(header.slice(5), "base64");
  assert.equal(buf.subarray(0, 8).toString("latin1"), "NTLMSSP\0");
  assert.equal(buf.readUInt32LE(8), 3); // MessageType = 3

  // Read the NtChallengeResponse security buffer (fields at offset 20).
  const ntLen = buf.readUInt16LE(20);
  const ntOff = buf.readUInt32LE(24);
  const ntResp = buf.subarray(ntOff, ntOff + ntLen);
  assert.equal(hex(ntResp.subarray(0, 16)), "68cd0ab851e51c96aabc927bebef6a1c");

  // Read DomainName / UserName fields and confirm UTF-16LE round-trips.
  const domLen = buf.readUInt16LE(28);
  const domOff = buf.readUInt32LE(32);
  assert.equal(
    buf.subarray(domOff, domOff + domLen).toString("utf16le"),
    "Domain",
  );
  const userLen = buf.readUInt16LE(36);
  const userOff = buf.readUInt32LE(40);
  assert.equal(
    buf.subarray(userOff, userOff + userLen).toString("utf16le"),
    "User",
  );
});

test("createType3Message — splits DOMAIN\\user when no domain given", () => {
  const b64 = buildType2({
    challenge: SERVER_CHALLENGE,
    targetInfo: TARGET_INFO,
    targetName: Buffer.alloc(0),
  });
  const t2 = ntlm.decodeType2Message(b64);
  const fromSplit = ntlm.createType3Message({
    type2: t2,
    username: "Domain\\User",
    password: "Password",
    clientChallenge: CLIENT_CHALLENGE,
    time: TIME,
  });
  const fromExplicit = ntlm.createType3Message({
    type2: t2,
    username: "User",
    domain: "Domain",
    password: "Password",
    clientChallenge: CLIENT_CHALLENGE,
    time: TIME,
  });
  // Same identity + inputs → byte-identical Type 3.
  assert.equal(fromSplit, fromExplicit);
});

test("createType3Message — prefers the server AV timestamp over current time", () => {
  const ts = 0x01d71b1b6b3aee00n;
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64LE(ts);
  const ti = Buffer.concat([
    Buffer.from("07000800", "hex"), // AV id 7 (timestamp), len 8
    tsBuf, // FILETIME
    Buffer.from("00000000", "hex"), // EOL
  ]);
  const t2 = ntlm.decodeType2Message(
    buildType2({
      challenge: SERVER_CHALLENGE,
      targetInfo: ti,
      targetName: Buffer.alloc(0),
    }),
  );
  // No explicit time → uses the AV timestamp; deterministic given fixed cc.
  const a = ntlm.createType3Message({
    type2: t2,
    username: "User",
    domain: "Domain",
    password: "Password",
    clientChallenge: CLIENT_CHALLENGE,
  });
  const b = ntlm.createType3Message({
    type2: t2,
    username: "User",
    domain: "Domain",
    password: "Password",
    clientChallenge: CLIENT_CHALLENGE,
    time: ts,
  });
  assert.equal(a, b);
});
