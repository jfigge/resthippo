"use strict";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];

function resolveBaseUrl(spec) {
  if (spec.servers?.length > 0) {
    const server = spec.servers[0];
    let url = server.url ?? "";
    const vars = server.variables ?? {};
    // OpenAPI 3 server URLs may contain {name} placeholders bound to
    // server.variables[name].default. Substitute them so the imported request
    // does not carry literal "{var}" segments that look like wurl template
    // refs but never resolve.
    url = url.replace(/\{([^}]+)\}/g, (m, name) => vars[name]?.default ?? m);
    return url.endsWith("/") ? url.slice(0, -1) : url;
  }
  if (spec.host) {
    const scheme = (spec.schemes ?? ["https"])[0];
    const basePath = (spec.basePath ?? "").replace(/\/$/, "");
    return `${scheme}://${spec.host}${basePath}`;
  }
  return "";
}

function toWurlUrl(baseUrl, path) {
  // Replace OpenAPI {param} placeholders with wurl {{param}} template syntax
  const wurlPath = path.replace(/\{([^}]+)\}/g, "{{$1}}");
  return baseUrl ? `${baseUrl}${wurlPath}` : `{{baseUrl}}${wurlPath}`;
}

function resolveSecurityScheme(spec, name) {
  return (
    spec.components?.securitySchemes?.[name] ??
    spec.securityDefinitions?.[name] ??
    null
  );
}

function buildAuth(spec, security) {
  if (!Array.isArray(security) || security.length === 0) return {};
  const entry = security[0];
  const name = Object.keys(entry ?? {})[0];
  if (!name) return {};

  const scheme = resolveSecurityScheme(spec, name);
  if (!scheme) return {};

  if (scheme.type === "http") {
    if (scheme.scheme === "bearer") {
      return {
        authEnabled: true,
        authType: "bearer",
        authBearer: { token: "" },
      };
    }
    if (scheme.scheme === "basic") {
      return {
        authEnabled: true,
        authType: "basic",
        authBasic: { username: "", password: "" },
      };
    }
  }
  if (scheme.type === "oauth2") {
    const flows = scheme.flows ?? {};
    // OpenAPI 3 declares one entry per supported flow under `flows`:
    // clientCredentials, authorizationCode, password, implicit. Previously this
    // hard-coded grantType=client_credentials even when only e.g. an
    // authorization-code flow was declared, silently breaking the resulting
    // request. Pair grantType with whichever flow object we actually read.
    let flow, grantType;
    if (flows.clientCredentials) {
      flow = flows.clientCredentials;
      grantType = "client_credentials";
    } else if (flows.authorizationCode) {
      flow = flows.authorizationCode;
      grantType = "authorization_code";
    } else if (flows.password) {
      flow = flows.password;
      grantType = "password";
    } else if (flows.implicit) {
      flow = flows.implicit;
      grantType = "implicit";
    } else {
      flow = {};
      grantType = "client_credentials";
    }
    return {
      authEnabled: true,
      authType: "oauth2",
      authOAuth2: {
        grantType,
        clientId: "",
        clientSecret: "",
        accessTokenUrl: flow.tokenUrl ?? "",
        authUrl: flow.authorizationUrl ?? "",
        scope: "",
      },
    };
  }
  if (scheme.type === "apiKey") {
    const name = scheme.name ?? "X-API-Key";
    if (scheme.in === "header") {
      return { _extraHeaders: [{ enabled: true, name, value: "" }] };
    }
    if (scheme.in === "query") {
      return { _extraParams: [{ enabled: true, name, value: "" }] };
    }
    if (scheme.in === "cookie") {
      // wurl has no first-class cookie auth field, so surface the value as a
      // Cookie header the user can edit. Spec expects e.g. "Cookie: foo=bar".
      return {
        _extraHeaders: [{ enabled: true, name: "Cookie", value: `${name}=` }],
      };
    }
  }
  return {};
}

function buildBody(spec, operation, isV3) {
  if (isV3) {
    const content = operation.requestBody?.content;
    if (!content) return {};
    const mimes = Object.keys(content);
    if (mimes.some((m) => m.includes("json")))
      return { bodyType: "json", bodyText: "" };
    if (mimes.some((m) => m.includes("xml")))
      return { bodyType: "xml", bodyText: "" };
    if (mimes.includes("application/x-www-form-urlencoded"))
      return { bodyType: "form-urlencoded", bodyFormRows: [] };
    if (mimes.includes("multipart/form-data"))
      return { bodyType: "form-data", bodyFormRows: [] };
    return {};
  }
  // Swagger 2.0
  const params = operation.parameters ?? [];
  if (params.some((p) => p.in === "body"))
    return { bodyType: "json", bodyText: "" };
  const formParams = params.filter((p) => p.in === "formData");
  if (formParams.length > 0) {
    const consumes = operation.consumes ?? spec.consumes ?? [];
    const rows = formParams.map((p) => ({
      enabled: true,
      name: p.name ?? "",
      value: "",
    }));
    return consumes.includes("multipart/form-data")
      ? { bodyType: "form-data", bodyFormRows: rows }
      : { bodyType: "form-urlencoded", bodyFormRows: rows };
  }
  return {};
}

/**
 * Parse an OpenAPI 3.x or Swagger 2.0 spec.
 *
 * @param {object} spec  Parsed JSON / YAML object
 * @returns {{ collection: object, variables: object }}
 */
export function parseOpenApi(spec) {
  const isV3 = Boolean(spec.openapi);
  const baseUrl = resolveBaseUrl(spec);
  const title = spec.info?.title ?? "Imported API";
  const globalSec = spec.security ?? [];

  // Group requests by tag
  const tagBuckets = new Map(); // tag → request[]

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const tag = operation.tags?.[0] ?? "Default";
      if (!tagBuckets.has(tag)) tagBuckets.set(tag, []);

      // Merge path-level and operation-level parameters
      const allParams = [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? []),
      ];

      const queryParams = allParams
        .filter((p) => p.in === "query")
        .map((p) => ({ enabled: true, name: p.name ?? "", value: "" }));

      const headerParams = allParams
        .filter((p) => p.in === "header")
        .map((p) => ({ enabled: true, name: p.name ?? "", value: "" }));

      const security = operation.security ?? globalSec;
      const authResult = buildAuth(spec, security);

      // apiKey-as-header goes into headers; apiKey-as-query goes into params.
      const extraHeaders = authResult._extraHeaders ?? [];
      const extraParams = authResult._extraParams ?? [];
      delete authResult._extraHeaders;
      delete authResult._extraParams;

      const bodyResult = buildBody(spec, operation, isV3);

      tagBuckets.get(tag).push({
        id: crypto.randomUUID(),
        type: "request",
        name:
          operation.operationId ??
          operation.summary ??
          `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: toWurlUrl(baseUrl, path),
        params: [...queryParams, ...extraParams],
        headers: [...headerParams, ...extraHeaders],
        notes: operation.description ?? operation.summary ?? "",
        bodyType: "no-body",
        ...bodyResult,
        ...authResult,
      });
    }
  }

  let children;
  if (tagBuckets.size === 1 && tagBuckets.has("Default")) {
    // Single un-tagged group — flatten directly into the collection
    children = tagBuckets.get("Default");
  } else {
    children = [...tagBuckets.entries()].map(([tag, requests]) => ({
      id: crypto.randomUUID(),
      type: "collection",
      name: tag,
      variables: {},
      children: requests,
    }));
  }

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: title,
      variables: {},
      children,
    },
    variables: baseUrl ? { baseUrl } : {},
  };
}
