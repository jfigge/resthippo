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

import {
  buildAuth,
  noBody,
  rawBody,
  graphqlBody,
  formBody,
  splitUrlQuery,
} from "./shape.js";

// Insomnia keeps the query string both on the URL and in `parameters`. Strip the
// query off the URL (buildRequestPayload re-appends params at send time) and
// prefer the explicit `parameters` list, falling back to the URL-parsed query
// when it's absent — otherwise the query would be sent twice.
function parseUrlAndParams(rawUrl, parameters) {
  const { base, params: urlParams } = splitUrlQuery(rawUrl ?? "");
  const explicit = (parameters ?? []).map((p) => ({
    enabled: !p.disabled,
    name: p.name ?? "",
    value: p.value ?? "",
  }));
  return { url: base, params: explicit.length ? explicit : urlParams };
}

// Map Insomnia's auth representation onto the neutral descriptor consumed by the
// shared `buildAuth`. Insomnia stores each scheme's fields as direct properties
// (and names its OAuth2 redirect field `authorizationUrl`, not `authUrl`).
function parseAuth(auth) {
  // Insomnia stores a disabled auth as `{ type, disabled: true, … }` rather
  // than changing `type` — treat it as no-auth so the imported request behaves
  // the way the user saw it in Insomnia.
  if (!auth || !auth.type || auth.type === "none" || auth.disabled === true) {
    return buildAuth(null);
  }

  const { type } = auth;
  if (type === "basic") {
    return buildAuth({
      type: "basic",
      username: auth.username,
      password: auth.password,
    });
  }
  if (type === "bearer") {
    return buildAuth({ type: "bearer", token: auth.token });
  }
  if (type === "apikey") {
    return buildAuth({
      type: "apikey",
      name: auth.key,
      value: auth.value,
      addTo: auth.addTo === "queryParams" ? "query" : "header",
    });
  }
  if (type === "digest") {
    return buildAuth({
      type: "digest",
      username: auth.username,
      password: auth.password,
    });
  }
  if (type === "ntlm") {
    return buildAuth({
      type: "ntlm",
      username: auth.username,
      password: auth.password,
      domain: auth.domain,
      workstation: auth.workstation,
    });
  }
  // Insomnia names AWS SigV4 "iam".
  if (type === "iam") {
    return buildAuth({
      type: "aws-iam",
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
      sessionToken: auth.sessionToken,
      region: auth.region,
      service: auth.service,
    });
  }
  if (type === "oauth1") {
    return buildAuth({
      type: "oauth1",
      consumerKey: auth.consumerKey,
      consumerSecret: auth.consumerSecret,
      // Insomnia names the token "tokenKey"; accept "token" too for safety.
      token: auth.tokenKey ?? auth.token,
      tokenSecret: auth.tokenSecret,
      signatureMethod: auth.signatureMethod,
      realm: auth.realm,
    });
  }
  if (type === "oauth2") {
    return buildAuth({
      type: "oauth2",
      grantType: auth.grantType,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      accessTokenUrl: auth.accessTokenUrl,
      authUrl: auth.authorizationUrl,
      scope: auth.scope,
    });
  }
  return buildAuth(null);
}

// Map Insomnia's `mimeType`-tagged body onto the shared canonical body builders.
function parseBody(body) {
  if (!body || !body.mimeType) return noBody();

  const mime = body.mimeType;
  if (mime.includes("graphql")) {
    // Insomnia's text is a JSON string { query, variables }. Some exporters put
    // the raw query directly in text — fall back to that if it isn't JSON.
    try {
      const parsed = JSON.parse(body.text ?? "");
      return graphqlBody(parsed.query, parsed.variables);
    } catch {
      return graphqlBody(body.text, "");
    }
  }
  if (mime.includes("json")) return rawBody("json", body.text);
  if (mime.includes("xml")) return rawBody("xml", body.text);
  if (mime.includes("yaml")) return rawBody("yaml", body.text);
  if (mime.includes("x-www-form-urlencoded")) {
    return formBody(
      "form-urlencoded",
      (body.params ?? []).map((p) => ({
        enabled: !p.disabled,
        name: p.name,
        value: p.value,
      })),
    );
  }
  if (mime.includes("multipart/form-data")) {
    return formBody(
      "form-data",
      (body.params ?? []).map((p) =>
        p.type === "file"
          ? { enabled: !p.disabled, name: p.name, file: { path: p.fileName } }
          : { enabled: !p.disabled, name: p.name, value: p.value },
      ),
    );
  }
  if (body.text) return rawBody("text", body.text);
  return noBody();
}

/**
 * Parse an Insomnia v5 export (YAML, type: "collection.insomnia.rest/5.0").
 *
 * V5 replaced the flat `resources[]` graph of v3/v4 with a hierarchical nested
 * tree: the workspace is the root document itself, HTTP requests and folders are
 * in `collection[]` (children are inline), and environments live in an
 * `environments` object rather than as separate resources.
 *
 * The auth and body representations are wire-compatible with v4, so the shared
 * `parseAuth` and `parseBody` helpers work without modification.
 *
 * @param {object} data  Parsed YAML (or JSON)
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}
 */
export function parseInsomniaV5(data) {
  const warnings = [];

  // Extract base environment variables. V5 carries no per-variable secret flag.
  const variables = [];
  const env = data.environments;
  if (env?.data && typeof env.data === "object") {
    for (const [k, v] of Object.entries(env.data)) {
      variables.push({
        name: k,
        value: typeof v === "string" ? v : JSON.stringify(v),
        secure: false,
      });
    }
  }

  // Sub-environments are dropped; warn if any exist.
  const subEnvs = env?.subEnvironments ?? [];
  if (subEnvs.length > 0) {
    warnings.push(
      `Skipped ${subEnvs.length} additional Insomnia environment` +
        `${subEnvs.length !== 1 ? "s" : ""}; only the base environment's ` +
        `variables were imported.`,
    );
  }

  // V5 discriminates folders from requests by the presence of a `children`
  // array. Non-HTTP items (WebSocket, gRPC, Socket.IO) lack both `children`
  // and `method` and are skipped.
  function buildNode(item) {
    if (Array.isArray(item.children)) {
      return {
        id: crypto.randomUUID(),
        type: "collection",
        name: item.name ?? "Folder",
        variables: [],
        children: item.children.map(buildNode).filter(Boolean),
      };
    }

    if (item.method) {
      const { url, params } = parseUrlAndParams(item.url, item.parameters);
      return {
        id: crypto.randomUUID(),
        type: "request",
        name: item.name ?? "Request",
        method: (item.method ?? "GET").toUpperCase(),
        url,
        headers: (item.headers ?? []).map((h) => ({
          enabled: !h.disabled,
          name: h.name ?? "",
          value: h.value ?? "",
        })),
        params,
        notes: item.meta?.description ?? "",
        ...parseBody(item.body),
        ...parseAuth(item.authentication),
      };
    }

    return null; // WebSocket / gRPC / Socket.IO — not importable as HTTP requests
  }

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: data.name ?? "Imported Collection",
      variables: [],
      children: (data.collection ?? []).map(buildNode).filter(Boolean),
    },
    variables,
    warnings,
  };
}

/**
 * Parse an Insomnia v3 / v4 export.
 *
 * @param {object} data  Parsed JSON
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}
 *   Variables use the canonical array shape. `warnings` reports non-fatal lossy
 *   conversions (e.g. dropped sub-environments); see `parseImport`.
 */
export function parseInsomnia(data) {
  const resources = data.resources ?? [];
  const warnings = [];

  const workspace = resources.find((r) => r._type === "workspace") ?? {};
  const wsId = workspace._id ?? "";

  // Build parentId → children lookup
  const childrenOf = new Map();
  for (const r of resources) {
    if (!r.parentId) continue;
    if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
    childrenOf.get(r.parentId).push(r);
  }

  // Extract base environment variables (skip sub-environments). Canonical array
  // shape: [{ name, value, secure }]. Insomnia's base environment carries no
  // per-variable secret flag, so secure defaults to false.
  const variables = [];
  const envs = (childrenOf.get(wsId) ?? []).filter(
    (r) => r._type === "environment",
  );
  const baseEnv = envs.find((e) => e.name === "Base Environment") ?? envs[0];
  if (baseEnv?.data && typeof baseEnv.data === "object") {
    for (const [k, v] of Object.entries(baseEnv.data)) {
      // String() on an object yields "[object Object]"; JSON.stringify keeps
      // the structure recoverable when the user references the variable.
      variables.push({
        name: k,
        value: typeof v === "string" ? v : JSON.stringify(v),
        secure: false,
      });
    }
  }

  // Rest Hippo imports a single flat variable set, so any sub-environments (Insomnia's
  // per-environment overrides, e.g. "Production"/"Staging") are dropped. Count
  // every environment resource in the export beyond the one we imported and warn
  // — silently keeping only the base would hide that the others were lost.
  const skippedEnvs =
    resources.filter((r) => r._type === "environment").length -
    (baseEnv ? 1 : 0);
  if (skippedEnvs > 0) {
    warnings.push(
      `Skipped ${skippedEnvs} additional Insomnia environment` +
        `${skippedEnvs !== 1 ? "s" : ""}; only the base environment's ` +
        `variables were imported.`,
    );
  }

  function buildNode(resource) {
    if (resource._type === "request") {
      const { url, params } = parseUrlAndParams(
        resource.url,
        resource.parameters,
      );
      return {
        id: crypto.randomUUID(),
        type: "request",
        name: resource.name ?? "Request",
        method: (resource.method ?? "GET").toUpperCase(),
        url,
        headers: (resource.headers ?? []).map((h) => ({
          enabled: !h.disabled,
          name: h.name ?? "",
          value: h.value ?? "",
        })),
        params,
        notes: resource.description ?? "",
        ...parseBody(resource.body),
        ...parseAuth(resource.authentication),
      };
    }

    if (resource._type === "request_group") {
      return {
        id: crypto.randomUUID(),
        type: "collection",
        name: resource.name ?? "Folder",
        variables: [],
        children: (childrenOf.get(resource._id) ?? [])
          .filter((r) => r._type === "request" || r._type === "request_group")
          .map(buildNode)
          .filter(Boolean),
      };
    }

    return null;
  }

  const children = (childrenOf.get(wsId) ?? [])
    .filter((r) => r._type === "request" || r._type === "request_group")
    .map(buildNode)
    .filter(Boolean);

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: workspace.name ?? "Imported Collection",
      variables: [],
      children,
    },
    variables,
    warnings,
  };
}
