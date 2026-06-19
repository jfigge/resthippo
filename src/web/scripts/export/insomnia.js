"use strict";

import { redactVariables, redactedAuth } from "./redact.js";

/**
 * Insomnia v4 exporter.
 *
 * Insomnia represents an export as a flat `resources` graph linked by
 * `parentId`: a single `workspace` at the root, `request_group` folders, and
 * `request` leaves, plus a base `environment` carrying collection variables.
 * This is the inverse of `import/insomnia.js` (`parseInsomnia`), so the two
 * round-trip: names, nesting, method/url/headers/params, body shape and auth
 * scheme survive the trip.
 *
 * Secrets are redacted through the shared `redact.js` policy — auth secrets and
 * `secure` variables are blanked but their fields/keys are preserved.
 *
 * To export a whole workspace, callers wrap every collection as a folder under
 * one synthetic root collection and pass that here; each becomes a
 * `request_group` under the single workspace.
 */

const EXPORT_FORMAT = 4;
const EXPORT_SOURCE = "resthippo.com:v0.6.1";

/** Insomnia ids are prefixed, hyphen-free tokens (e.g. "req_ab12…"). */
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Map a Rest Hippo request body to an Insomnia body object (inverse of parseBody). */
function exportBody(node) {
  const type = node.bodyType ?? "no-body";
  if (type === "no-body") return {};

  if (type === "json")
    return { mimeType: "application/json", text: node.bodyText ?? "" };
  if (type === "xml")
    return { mimeType: "application/xml", text: node.bodyText ?? "" };
  if (type === "yaml")
    return { mimeType: "application/yaml", text: node.bodyText ?? "" };
  if (type === "text")
    return { mimeType: "text/plain", text: node.bodyText ?? "" };

  if (type === "graphql") {
    // Insomnia stores GraphQL as application/graphql with a JSON body string
    // { query, variables } where variables is an object.
    let variables = {};
    const vt = (node.bodyGraphql?.variables ?? "").trim();
    if (vt) {
      try {
        variables = JSON.parse(vt);
      } catch {
        variables = {};
      }
    }
    return {
      mimeType: "application/graphql",
      text: JSON.stringify({
        query: node.bodyGraphql?.query ?? "",
        variables,
      }),
    };
  }

  if (type === "form-urlencoded" || type === "form-data") {
    const mimeType =
      type === "form-data"
        ? "multipart/form-data"
        : "application/x-www-form-urlencoded";
    return {
      mimeType,
      params: (node.bodyFormRows ?? []).map((r) =>
        r.kind === "file"
          ? {
              name: r.name ?? "",
              value: "",
              type: "file",
              fileName: r.filePath ?? "",
              disabled: !r.enabled,
            }
          : {
              name: r.name ?? "",
              value: r.value ?? "",
              disabled: !r.enabled,
            },
      ),
    };
  }

  if (type === "file") {
    return {
      mimeType: "application/octet-stream",
      fileName: node.bodyFilePath ?? "",
    };
  }
  return {};
}

/**
 * Map a Rest Hippo request's auth to an Insomnia `authentication` object. The shared
 * `redactedAuth` helper strips the secret; Insomnia's importer-facing field
 * names are restored here (e.g. `authorizationUrl`).
 */
function exportAuth(node) {
  const auth = redactedAuth(node);
  if (!auth) return { type: "none" };
  if (auth.type === "basic") {
    return {
      type: "basic",
      disabled: false,
      username: auth.username,
      password: "",
    };
  }
  if (auth.type === "bearer") {
    return { type: "bearer", disabled: false, token: "", prefix: "" };
  }
  if (auth.type === "apikey") {
    return {
      type: "apikey",
      disabled: false,
      key: auth.name,
      value: "",
      addTo: auth.addTo === "query" ? "queryParams" : "header",
    };
  }
  if (auth.type === "digest") {
    return {
      type: "digest",
      disabled: false,
      username: auth.username,
      password: "",
    };
  }
  if (auth.type === "ntlm") {
    return {
      type: "ntlm",
      disabled: false,
      username: auth.username,
      password: "",
      domain: auth.domain,
      workstation: auth.workstation,
    };
  }
  if (auth.type === "aws-iam") {
    return {
      type: "iam",
      disabled: false,
      accessKeyId: auth.accessKeyId,
      secretAccessKey: "",
      sessionToken: "",
      region: auth.region,
      service: auth.service,
    };
  }
  if (auth.type === "oauth1") {
    return {
      type: "oauth1",
      disabled: false,
      consumerKey: auth.consumerKey,
      consumerSecret: "",
      tokenKey: "",
      tokenSecret: "",
      signatureMethod: auth.signatureMethod,
      realm: auth.realm,
    };
  }
  if (auth.type === "oauth2") {
    return {
      type: "oauth2",
      disabled: false,
      grantType: auth.grantType,
      clientId: auth.clientId,
      clientSecret: "",
      accessTokenUrl: auth.accessTokenUrl,
      authorizationUrl: auth.authUrl,
      scope: auth.scope,
    };
  }
  return { type: "none" };
}

/**
 * Serialize a Rest Hippo collection to an Insomnia v4 JSON string.
 *
 * @param {object} collection  Rest Hippo collection node (type: "collection")
 * @param {Array}  [variables] Collection-level variables in canonical array
 *                             shape ({ name, value, secure }); secure entries
 *                             are redacted into the base environment.
 * @returns {string} Formatted JSON
 */
export function exportToInsomnia(collection, variables = []) {
  const resources = [];
  let sortKey = 0;

  const workspaceId = newId("wrk");
  resources.push({
    _id: workspaceId,
    _type: "workspace",
    parentId: null,
    name: collection?.name ?? "Exported Collection",
    description: "",
    scope: "collection",
  });

  // Collection variables become the Base Environment (secure values blanked).
  const data = {};
  for (const v of redactVariables(variables)) data[v.name] = v.value;
  resources.push({
    _id: newId("env"),
    _type: "environment",
    parentId: workspaceId,
    name: "Base Environment",
    data,
    dataPropertyOrder: null,
    metaSortKey: sortKey++,
  });

  // Walk the tree, assigning parentIds. metaSortKey increases in visit order so
  // Insomnia preserves sibling ordering (it sorts each parent's children by it).
  const walk = (node, parentId) => {
    for (const child of node.children ?? []) {
      if (child.type === "collection") {
        const groupId = newId("fld");
        const environment = {};
        // Folder variables are best-effort: only canonical-array form is read
        // (matching the Postman exporter); our own importer ignores group envs.
        for (const v of redactVariables(child.variables)) {
          environment[v.name] = v.value;
        }
        resources.push({
          _id: groupId,
          _type: "request_group",
          parentId,
          name: child.name ?? "Folder",
          description: "",
          environment,
          environmentPropertyOrder: null,
          metaSortKey: sortKey++,
        });
        walk(child, groupId);
      } else if (child.type === "request") {
        resources.push({
          _id: newId("req"),
          _type: "request",
          parentId,
          name: child.name ?? "Request",
          method: (child.method ?? "GET").toUpperCase(),
          url: child.url ?? "",
          description: child.notes ?? "",
          headers: (child.headers ?? []).map((h) => ({
            name: h.name ?? "",
            value: h.value ?? "",
            disabled: !h.enabled,
          })),
          parameters: (child.params ?? []).map((p) => ({
            name: p.name ?? "",
            value: p.value ?? "",
            disabled: !p.enabled,
          })),
          body: exportBody(child),
          authentication: exportAuth(child),
          metaSortKey: sortKey++,
        });
      }
    }
  };
  walk(collection ?? {}, workspaceId);

  return JSON.stringify(
    {
      _type: "export",
      __export_format: EXPORT_FORMAT,
      __export_date: new Date().toISOString(),
      __export_source: EXPORT_SOURCE,
      resources,
    },
    null,
    2,
  );
}
