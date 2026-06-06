"use strict";

function parseAuth(auth) {
  // Insomnia stores a disabled auth as `{ type, disabled: true, … }` rather
  // than changing `type` — treat it as no-auth so the imported request behaves
  // the way the user saw it in Insomnia.
  if (!auth || !auth.type || auth.type === "none" || auth.disabled === true) {
    return { authEnabled: false, authType: "none" };
  }

  const { type } = auth;
  if (type === "basic") {
    return {
      authEnabled: true,
      authType: "basic",
      authBasic: {
        username: auth.username ?? "",
        password: auth.password ?? "",
      },
    };
  }
  if (type === "bearer") {
    return {
      authEnabled: true,
      authType: "bearer",
      authBearer: { token: auth.token ?? "" },
    };
  }
  if (type === "oauth2") {
    return {
      authEnabled: true,
      authType: "oauth2",
      authOAuth2: {
        grantType: auth.grantType ?? "authorization_code",
        clientId: auth.clientId ?? "",
        clientSecret: auth.clientSecret ?? "",
        accessTokenUrl: auth.accessTokenUrl ?? "",
        authUrl: auth.authorizationUrl ?? "",
        scope: auth.scope ?? "",
      },
    };
  }
  return { authEnabled: false, authType: "none" };
}

function parseBody(body) {
  if (!body || !body.mimeType) return { bodyType: "no-body" };

  const mime = body.mimeType;
  if (mime.includes("graphql")) {
    // Insomnia's text is a JSON string { query, variables }. Some exporters put
    // the raw query directly in text — fall back to that if it isn't JSON.
    let query = "";
    let variables = "";
    try {
      const parsed = JSON.parse(body.text ?? "");
      query = parsed.query ?? "";
      variables =
        parsed.variables == null
          ? ""
          : typeof parsed.variables === "string"
            ? parsed.variables
            : JSON.stringify(parsed.variables, null, 2);
    } catch {
      query = body.text ?? "";
    }
    return { bodyType: "graphql", bodyGraphql: { query, variables } };
  }
  if (mime.includes("json"))
    return { bodyType: "json", bodyText: body.text ?? "" };
  if (mime.includes("xml"))
    return { bodyType: "xml", bodyText: body.text ?? "" };
  if (mime.includes("yaml"))
    return { bodyType: "yaml", bodyText: body.text ?? "" };
  if (mime === "application/x-www-form-urlencoded") {
    return {
      bodyType: "form-urlencoded",
      bodyFormRows: (body.params ?? []).map((p) => ({
        enabled: !p.disabled,
        name: p.name ?? "",
        value: p.value ?? "",
      })),
    };
  }
  if (mime === "multipart/form-data") {
    return {
      bodyType: "form-data",
      bodyFormRows: (body.params ?? []).map((p) =>
        p.type === "file"
          ? {
              enabled: !p.disabled,
              name: p.name ?? "",
              value: "",
              kind: "file",
              filePath: p.fileName ?? "",
              fileName: (p.fileName ?? "").split(/[\\/]/).pop() ?? "",
              contentType: "",
            }
          : {
              enabled: !p.disabled,
              name: p.name ?? "",
              value: p.value ?? "",
            },
      ),
    };
  }
  if (body.text) return { bodyType: "text", bodyText: body.text };
  return { bodyType: "no-body" };
}

/**
 * Parse an Insomnia v3 / v4 export.
 *
 * @param {object} data  Parsed JSON
 * @returns {{ collection: object, variables: object }}
 */
export function parseInsomnia(data) {
  const resources = data.resources ?? [];

  const workspace = resources.find((r) => r._type === "workspace") ?? {};
  const wsId = workspace._id ?? "";

  // Build parentId → children lookup
  const childrenOf = new Map();
  for (const r of resources) {
    if (!r.parentId) continue;
    if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
    childrenOf.get(r.parentId).push(r);
  }

  // Extract base environment variables (skip sub-environments)
  const variables = {};
  const envs = (childrenOf.get(wsId) ?? []).filter(
    (r) => r._type === "environment",
  );
  const baseEnv = envs.find((e) => e.name === "Base Environment") ?? envs[0];
  if (baseEnv?.data && typeof baseEnv.data === "object") {
    for (const [k, v] of Object.entries(baseEnv.data)) {
      // String() on an object yields "[object Object]"; JSON.stringify keeps
      // the structure recoverable when the user references the variable.
      variables[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }

  function buildNode(resource) {
    if (resource._type === "request") {
      return {
        id: crypto.randomUUID(),
        type: "request",
        name: resource.name ?? "Request",
        method: (resource.method ?? "GET").toUpperCase(),
        url: resource.url ?? "",
        headers: (resource.headers ?? []).map((h) => ({
          enabled: !h.disabled,
          name: h.name ?? "",
          value: h.value ?? "",
        })),
        params: (resource.parameters ?? []).map((p) => ({
          enabled: !p.disabled,
          name: p.name ?? "",
          value: p.value ?? "",
        })),
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
        variables: {},
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
      variables: {},
      children,
    },
    variables,
  };
}
