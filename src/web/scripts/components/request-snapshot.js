/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * components/request-snapshot.js — the Timeline (run-history) snapshot format
 * of a request, both directions:
 *
 *   buildSnapshot(node)       request node → snapshot (bulk-edit strings, so the
 *                             stored record is human-readable)
 *   snapshotToNode(snapshot)  snapshot → request-node fields (the inverse, used
 *                             by RequestEditor.loadSnapshot on a Timeline restore)
 *
 * Extracted from app.js (`_buildSnapshot`) and RequestEditor.loadSnapshot so the
 * round-trip lives in one pure, tested module. Command requests (Feature 70)
 * keep their fields structured.
 */

"use strict";

import { textToKvRows, textToHeaderRows } from "./kv-editor-shared.js";

/**
 * Serialize a request node into the history snapshot format.
 * Params/headers/body-form rows are stored as bulk-edit strings so the data
 * is human-readable and round-trips cleanly through the bulk editors.
 * @param {object} node
 * @returns {object} snapshot
 */
export function buildSnapshot(node) {
  const params = Array.isArray(node.params) ? node.params : [];
  const headers = Array.isArray(node.headers) ? node.headers : [];

  const paramsBulk = params
    .map((p) => `${p.enabled ? "" : "# "}${p.name}=${p.value}`)
    .join("\n");
  const headersBulk = headers
    .map((h) => `${h.enabled ? "" : "# "}${h.name}: ${h.value}`)
    .join("\n");

  const authEnabled = node.authEnabled ?? true;
  // A disabled auth is never applied to the request, so don't track it in the
  // timeline snapshot — record it as "none", the same as an unselected auth.
  const authType = authEnabled ? (node.authType ?? "none") : "none";
  let authBulk = "";
  if (authType === "basic") {
    const b = node.authBasic ?? {};
    authBulk = `username: ${b.username ?? ""}\npassword: ${b.password ?? ""}`;
  } else if (authType === "bearer") {
    authBulk = `token: ${node.authBearer?.token ?? ""}`;
  } else if (authType === "oauth2") {
    const o = node.authOAuth2 ?? {};
    const lines = [];
    if (o.grantType) lines.push(`grantType: ${o.grantType}`);
    if (o.clientType) lines.push(`clientType: ${o.clientType}`);
    if (o.clientId) lines.push(`clientId: ${o.clientId}`);
    if (o.clientSecret) lines.push(`clientSecret: ${o.clientSecret}`);
    if (o.accessTokenUrl) lines.push(`accessTokenUrl: ${o.accessTokenUrl}`);
    if (o.authUrl) lines.push(`authUrl: ${o.authUrl}`);
    if (o.username) lines.push(`username: ${o.username}`);
    if (o.password) lines.push(`password: ${o.password}`);
    if (o.scope) lines.push(`scope: ${o.scope}`);
    if (o.responseType) lines.push(`responseType: ${o.responseType}`);
    if (o.redirectUri) lines.push(`redirectUri: ${o.redirectUri}`);
    if (o.credentials) lines.push(`credentials: ${o.credentials}`);
    if (o.audience) lines.push(`audience: ${o.audience}`);
    if (o.resource) lines.push(`resource: ${o.resource}`);
    if (o.origin) lines.push(`origin: ${o.origin}`);
    if (o.headerPrefix) lines.push(`headerPrefix: ${o.headerPrefix}`);
    authBulk = lines.join("\n");
  } else if (authType === "aws-iam") {
    const a = node.authAwsIam ?? {};
    const lines = [];
    if (a.accessKeyId) lines.push(`accessKeyId: ${a.accessKeyId}`);
    if (a.secretAccessKey) lines.push(`secretAccessKey: ${a.secretAccessKey}`);
    if (a.region) lines.push(`region: ${a.region}`);
    if (a.service) lines.push(`service: ${a.service}`);
    if (a.sessionToken) lines.push(`sessionToken: ${a.sessionToken}`);
    authBulk = lines.join("\n");
  } else if (authType === "oauth1") {
    const o = node.authOAuth1 ?? {};
    const lines = [];
    if (o.consumerKey) lines.push(`consumerKey: ${o.consumerKey}`);
    if (o.consumerSecret) lines.push(`consumerSecret: ${o.consumerSecret}`);
    if (o.token) lines.push(`token: ${o.token}`);
    if (o.tokenSecret) lines.push(`tokenSecret: ${o.tokenSecret}`);
    if (o.signatureMethod) lines.push(`signatureMethod: ${o.signatureMethod}`);
    if (o.realm) lines.push(`realm: ${o.realm}`);
    authBulk = lines.join("\n");
  }

  const bodyType = node.bodyType ?? "no-body";
  let bodyContent = "";
  // GraphQL keeps its query + variables structured (like pathParams below); the
  // bulk `body` string holds the query for readability.
  let bodyGraphql = null;
  if (bodyType === "form-data" || bodyType === "form-urlencoded") {
    const rows = Array.isArray(node.bodyFormRows) ? node.bodyFormRows : [];
    bodyContent = rows
      .map((r) => `${r.enabled ? "" : "# "}${r.name}=${r.value}`)
      .join("\n");
  } else if (bodyType === "file") {
    bodyContent = node.bodyFilePath ?? "";
  } else if (bodyType === "graphql") {
    bodyGraphql = {
      query: node.bodyGraphql?.query ?? "",
      variables: node.bodyGraphql?.variables ?? "",
    };
    bodyContent = bodyGraphql.query;
  } else {
    bodyContent = node.bodyText ?? "";
  }

  return {
    id: node.id,
    method: node.method ?? "GET",
    url: node.url ?? "",
    // Command requests (Feature 70): structured, so a Timeline restore
    // reinstates the exact command line / env / stdin that ran.
    ...(node.protocol === "command"
      ? {
          protocol: "command",
          commandLine: node.commandLine ?? "",
          commandEnv: Array.isArray(node.commandEnv) ? node.commandEnv : [],
          commandStdin: node.commandStdin ?? "",
          commandOutputType: node.commandOutputType ?? "auto",
          commandTimeoutMs: node.commandTimeoutMs ?? 0,
        }
      : {}),
    params: paramsBulk,
    // Path-param values are kept structured (they're URL-derived, not bulk text).
    pathParams: Array.isArray(node.pathParams) ? node.pathParams : [],
    headers: headersBulk,
    authType,
    authEnabled,
    auth: authBulk,
    bodyType,
    body: bodyContent,
    ...(bodyGraphql ? { bodyGraphql } : {}),
    notes: node.notes ?? "",
    // Post-response / test configuration — captured so a Timeline restore
    // reinstates the request's tests, scripts, and captures exactly as they
    // were for this run. Without these the snapshot would carry no test
    // definition, so restoring it blanks the editor's Tests/Scripts/Captures
    // tabs (the stored request keeps them, which is why re-selecting the
    // request brings them back). Stored structured — load() consumes them as-is.
    assertions: Array.isArray(node.assertions) ? node.assertions : [],
    captures: Array.isArray(node.captures) ? node.captures : [],
    preRequestScript: node.preRequestScript ?? "",
    afterResponseScript: node.afterResponseScript ?? "",
    preRequestScriptEnabled: node.preRequestScriptEnabled !== false,
    afterResponseScriptEnabled: node.afterResponseScriptEnabled !== false,
    ...(node.scriptSplit != null ? { scriptSplit: node.scriptSplit } : {}),
  };
}

/**
 * Convert a snapshot back into request-node fields. Test / script / capture
 * configuration is NOT handled here — the caller falls back to the request's
 * current config for snapshots that predate those fields.
 * @param {object} snapshot
 * @returns {object} node fields
 */
export function snapshotToNode(snapshot) {
  const node = {
    id: snapshot.id,
    method: snapshot.method ?? "GET",
    url: snapshot.url ?? "",
    params: textToKvRows(snapshot.params ?? ""),
    pathParams: Array.isArray(snapshot.pathParams) ? snapshot.pathParams : [],
    headers: textToHeaderRows(snapshot.headers ?? ""),
    authType: snapshot.authType ?? "none",
    authEnabled: snapshot.authEnabled ?? true,
    bodyType: snapshot.bodyType ?? "no-body",
    notes: snapshot.notes ?? "",
  };
  // Command requests (Feature 70) snapshot their fields structured.
  if (snapshot.protocol === "command") {
    Object.assign(node, {
      protocol: "command",
      commandLine: snapshot.commandLine ?? "",
      commandEnv: Array.isArray(snapshot.commandEnv) ? snapshot.commandEnv : [],
      commandStdin: snapshot.commandStdin ?? "",
      commandOutputType: snapshot.commandOutputType ?? "auto",
      commandTimeoutMs: snapshot.commandTimeoutMs ?? 0,
    });
  }

  const kv = parseBulkKVColon(snapshot.auth ?? "");
  if (node.authType === "basic") {
    node.authBasic = {
      username: kv.username ?? "",
      password: kv.password ?? "",
    };
  } else if (node.authType === "bearer") {
    node.authBearer = { token: kv.token ?? "" };
  } else if (node.authType === "apikey") {
    node.authApiKey = {
      name: kv.name ?? "",
      value: kv.value ?? "",
      addTo: kv.addTo === "query" ? "query" : "header",
    };
  } else if (node.authType === "digest") {
    node.authDigest = {
      username: kv.username ?? "",
      password: kv.password ?? "",
    };
  } else if (node.authType === "ntlm") {
    node.authNtlm = {
      username: kv.username ?? "",
      password: kv.password ?? "",
      domain: kv.domain ?? "",
      workstation: kv.workstation ?? "",
    };
  } else if (node.authType === "oauth2") {
    node.authOAuth2 = {
      grantType: kv.grantType ?? "client_credentials",
      clientType: kv.clientType ?? "confidential",
      clientId: kv.clientId ?? "",
      clientSecret: kv.clientSecret ?? "",
      accessTokenUrl: kv.accessTokenUrl ?? "",
      authUrl: kv.authUrl ?? "",
      username: kv.username ?? "",
      password: kv.password ?? "",
      scope: kv.scope ?? "",
      responseType: kv.responseType ?? "",
      redirectUri: kv.redirectUri ?? "",
      state: kv.state ?? "",
      credentials: kv.credentials ?? "",
      audience: kv.audience ?? "",
      resource: kv.resource ?? "",
      origin: kv.origin ?? "",
      headerPrefix: kv.headerPrefix ?? "",
    };
  } else if (node.authType === "aws-iam") {
    node.authAwsIam = {
      accessKeyId: kv.accessKeyId ?? "",
      secretAccessKey: kv.secretAccessKey ?? "",
      region: kv.region ?? "",
      service: kv.service ?? "",
      sessionToken: kv.sessionToken ?? "",
    };
  }

  if (node.bodyType === "form-data" || node.bodyType === "form-urlencoded") {
    node.bodyFormRows = textToKvRows(snapshot.body ?? "");
  } else if (node.bodyType === "file") {
    node.bodyFilePath = snapshot.body ?? "";
  } else if (node.bodyType === "graphql") {
    // GraphQL keeps query + variables structured in the snapshot; fall back to
    // the readable `body` (the query) for older snapshots.
    node.bodyGraphql = snapshot.bodyGraphql ?? {
      query: snapshot.body ?? "",
      variables: "",
    };
  } else {
    node.bodyText = snapshot.body ?? "";
  }
  return node;
}

/** Parse  key: value  lines into a plain object (snapshot auth block). */
function parseBulkKVColon(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
