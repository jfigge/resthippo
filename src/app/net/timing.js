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
 * timing.js — Response-timing waterfall phase calculator (Feature 45).
 *
 * The HTTP execution path in main.js timestamps the socket lifecycle of one
 * request leg into a flat `marks` object (absolute ms, from Date.now()):
 *
 *   start     — leg began (just before the request is created)
 *   socket    — a socket was assigned to the request
 *   lookup    — DNS resolution finished           (absent on a reused socket / IP host)
 *   connect   — TCP handshake finished            (absent on a reused socket)
 *   secure    — TLS handshake finished            (HTTPS only; absent on reuse)
 *   response  — first response byte / headers arrived (TTFB marker)
 *   end       — response body fully downloaded
 *
 * computeTiming() turns those marks into the contiguous phase durations the
 * renderer draws as a waterfall. Every phase is emitted only when both of its
 * boundary marks exist, so plain-HTTP (no `tls`) and reused keep-alive
 * connections (no `dns`/`tcp`/`tls`) degrade gracefully — the segment is simply
 * omitted rather than reported as zero.
 *
 * Phases (all optional except they sum to ≈ `total`):
 *   dns      socket  → lookup
 *   tcp      lookup  → connect      (falls back to socket → connect with no DNS)
 *   tls      connect → secure       (HTTPS only)
 *   ttfb     (secure|connect|socket) → response   (request sent + server wait)
 *   download response → end
 *
 * `total` is end − start, the authoritative per-leg wall time.
 */

/**
 * @param {{
 *   start?: number, socket?: number, lookup?: number, connect?: number,
 *   secure?: number, response?: number, end?: number,
 * }} marks
 * @param {{ isHttps?: boolean }} [opts]
 * @returns {{ total: number, dns?: number, tcp?: number, tls?: number,
 *             ttfb?: number, download?: number } | undefined}
 *   undefined when there is not enough information to report (no start/end).
 */
function computeTiming(marks = {}, opts = {}) {
  const { start, socket, lookup, connect, secure, response, end } = marks;
  if (start == null || end == null) return undefined;

  const out = { total: Math.max(0, end - start) };

  // Emit a phase only when both boundaries are known and non-decreasing.
  const add = (key, a, b) => {
    if (a != null && b != null && b >= a) out[key] = b - a;
  };

  add("dns", socket, lookup);
  add("tcp", lookup != null ? lookup : socket, connect);
  if (opts.isHttps) add("tls", connect, secure);

  // The request is on the wire once the connection is ready; on a reused socket
  // that is the socket-assignment mark, and as a last resort the leg start.
  const ready = secure != null ? secure : connect != null ? connect : socket;
  add("ttfb", ready != null ? ready : start, response);
  add("download", response, end);

  return out;
}

/** Human label for each phase key, in waterfall order. */
const PHASE_LABELS = [
  ["dns", "DNS lookup"],
  ["tcp", "TCP connect"],
  ["tls", "TLS handshake"],
  ["ttfb", "Waiting (TTFB)"],
  ["download", "Content download"],
];

/**
 * Render a timing object as curl-style Console lines (each `* ` prefixed, label
 * column left-aligned, millisecond column right-aligned). Absent phases are
 * skipped; a `total` row closes the block. Returns [] when there is nothing to
 * report, so the caller can spread it unconditionally.
 *
 * @param {ReturnType<typeof computeTiming>} timing
 * @returns {string[]}
 */
function formatTiming(timing) {
  if (!timing) return [];

  const rows = [];
  for (const [key, label] of PHASE_LABELS) {
    if (typeof timing[key] === "number") rows.push([label, timing[key]]);
  }
  if (typeof timing.total === "number") rows.push(["Total", timing.total]);
  if (!rows.length) return [];

  const labelW = Math.max(...rows.map(([label]) => label.length));
  const valW = Math.max(...rows.map(([, ms]) => String(ms).length));

  const lines = ["* Request timing:"];
  for (const [label, ms] of rows) {
    lines.push(`*   ${label.padEnd(labelW)}  ${String(ms).padStart(valW)} ms`);
  }
  return lines;
}

module.exports = { computeTiming, formatTiming };
