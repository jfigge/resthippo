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

// ── Local $ref resolution + example synthesis ─────────────────────────────────

/** Decode an RFC 6901 JSON Pointer token ("~1" → "/", "~0" → "~"). */
function decodePointerToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Coerce a synthesized example value into a string for a key/value field. */
function valueToField(v) {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** A representative sample value for a typed string schema, honoring `format`. */
function stringExample(schema) {
  switch (schema.format) {
    case "date-time":
      return "2020-01-01T00:00:00Z";
    case "date":
      return "2020-01-01";
    case "email":
      return "user@example.com";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "uri":
    case "url":
      return "https://example.com";
    default:
      return "string";
  }
}

/**
 * Resolves local ("#/...") $refs against a single spec document and synthesizes
 * example values from JSON Schema. Remote (URL / relative-file) refs cannot be
 * followed without network I/O, so they are recorded for the caller to report
 * rather than silently dropped.
 */
class RefResolver {
  constructor(spec) {
    this.spec = spec;
    this.remoteRefs = new Set();
  }

  /** Look up a local JSON pointer ("#/a/b") in the document; undefined if absent. */
  _lookup(ref) {
    const parts = ref.slice(2).split("/").map(decodePointerToken);
    let cur = this.spec;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    return cur;
  }

  /**
   * If `node` is a {$ref} object, follow the chain of local refs to the target
   * object. Remote refs are recorded and resolve to null; cycles resolve to
   * null. Plain (non-$ref) objects are returned unchanged.
   */
  deref(node) {
    const seen = new Set();
    while (node && typeof node === "object" && typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/")) {
        this.remoteRefs.add(ref);
        return null;
      }
      if (seen.has(ref)) return null; // ref cycle
      seen.add(ref);
      node = this._lookup(ref);
    }
    return node ?? null;
  }

  /**
   * Synthesize a minimal example value from a JSON Schema, honoring
   * example / default / enum, object properties (including `allOf` members),
   * arrays, and oneOf/anyOf (first variant). `path` carries the $refs already
   * followed on the current branch so recursive schemas terminate; a depth cap
   * is a final backstop. Returns `null` when nothing can be synthesized.
   */
  exampleFromSchema(schemaIn, seenRefs = new Set(), depth = 0) {
    if (depth > 12) return null;
    const path = new Set(seenRefs);
    const schema = this._derefSchema(schemaIn, path);
    if (!schema || typeof schema !== "object") return null;

    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length > 0)
      return schema.enum[0];

    // oneOf/anyOf with no own object shape → synthesize from the first variant.
    const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
    if (variant && !schema.properties && !schema.allOf) {
      return this.exampleFromSchema(variant, path, depth + 1);
    }

    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

    if (type === "array" || schema.items) {
      const item = schema.items
        ? this.exampleFromSchema(schema.items, path, depth + 1)
        : null;
      return item === null ? [] : [item];
    }

    if (type === "object" || schema.properties || schema.allOf) {
      const out = {};
      // `allOf` members contribute their object properties first.
      for (const sub of schema.allOf ?? []) {
        const merged = this.exampleFromSchema(sub, path, depth + 1);
        if (merged && typeof merged === "object" && !Array.isArray(merged))
          Object.assign(out, merged);
      }
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        out[key] = this.exampleFromSchema(propSchema, path, depth + 1);
      }
      return out;
    }

    if (type === "string") return stringExample(schema);
    if (type === "integer" || type === "number") return 0;
    if (type === "boolean") return false;
    return null;
  }

  /** Follow a chain of $refs on a schema node, recording the path for cycles. */
  _derefSchema(schema, path) {
    while (
      schema &&
      typeof schema === "object" &&
      typeof schema.$ref === "string"
    ) {
      const ref = schema.$ref;
      if (!ref.startsWith("#/")) {
        this.remoteRefs.add(ref);
        return null;
      }
      if (path.has(ref)) return null; // recursive schema — stop here
      path.add(ref);
      schema = this._lookup(ref);
    }
    return schema ?? null;
  }

  /**
   * Pick an example for a Media Type Object: an explicit `example`, the first
   * `examples` entry's value, or a value synthesized from `schema`. Returns
   * `undefined` when the media type carries nothing usable.
   */
  exampleFromMedia(media) {
    if (!media || typeof media !== "object") return undefined;
    if (media.example !== undefined) return media.example;
    if (media.examples && typeof media.examples === "object") {
      const first = this.deref(Object.values(media.examples)[0]);
      if (first && first.value !== undefined) return first.value;
      if (first && typeof first.externalValue === "string")
        this.remoteRefs.add(first.externalValue);
    }
    if (media.schema) {
      const ex = this.exampleFromSchema(media.schema);
      if (ex !== null) return ex;
    }
    return undefined;
  }

  /** Build form-field rows from an object schema's properties (for form bodies). */
  formRowsFromSchema(media) {
    const schema = this._derefSchema(media?.schema, new Set());
    const props = schema?.properties;
    if (!props || typeof props !== "object") return [];
    return Object.entries(props).map(([name, propSchema]) => {
      const ds = this._derefSchema(propSchema, new Set());
      // A binary-format string property is an upload field.
      if (ds?.format === "binary" || ds?.type === "file") {
        return {
          enabled: true,
          name,
          value: "",
          kind: "file",
          filePath: "",
          fileName: "",
          contentType: "",
        };
      }
      return {
        enabled: true,
        name,
        value: valueToField(this.exampleFromSchema(propSchema)),
      };
    });
  }
}

/** Pre-fill a query/header value from a parameter's example / default / enum. */
function paramValueHint(param, isV3, resolver) {
  // OpenAPI 3 carries type info under `schema`; Swagger 2.0 inlines it.
  const src = isV3 ? (resolver.deref(param.schema) ?? {}) : param;
  let v;
  if (param.example !== undefined) v = param.example;
  else if (src.example !== undefined) v = src.example;
  else if (src.default !== undefined) v = src.default;
  else if (Array.isArray(src.enum) && src.enum.length > 0) v = src.enum[0];
  else return "";
  return valueToField(v);
}

/** Attach an explicit Content-Type only when the spec mime is non-default. */
function contentTyped(mime, defaultMime, partial) {
  return mime === defaultMime ? partial : { ...partial, _contentType: mime };
}

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

/**
 * Build the body fields for an operation, synthesizing an example payload from
 * the request body's example / examples / schema. `resolvedParams` are the
 * already-$ref-resolved parameters (used for the Swagger 2.0 body/formData).
 */
function buildBody(spec, operation, isV3, resolver, resolvedParams) {
  if (isV3) {
    const requestBody = resolver.deref(operation.requestBody);
    const content = requestBody?.content;
    if (!content || typeof content !== "object") return {};
    const mimes = Object.keys(content);

    const jsonMime = mimes.find((m) => m.includes("json"));
    if (jsonMime) {
      const ex = resolver.exampleFromMedia(content[jsonMime]);
      const bodyText = ex == null ? "" : JSON.stringify(ex, null, 2);
      return contentTyped(jsonMime, "application/json", {
        bodyType: "json",
        bodyText,
      });
    }
    const xmlMime = mimes.find((m) => m.includes("xml"));
    if (xmlMime) {
      // No reliable schema→XML synthesis; carry the type with an empty body.
      return contentTyped(xmlMime, "application/xml", {
        bodyType: "xml",
        bodyText: "",
      });
    }
    if (mimes.includes("application/x-www-form-urlencoded")) {
      return {
        bodyType: "form-urlencoded",
        bodyFormRows: resolver.formRowsFromSchema(
          content["application/x-www-form-urlencoded"],
        ),
      };
    }
    if (mimes.includes("multipart/form-data")) {
      return {
        bodyType: "form-data",
        bodyFormRows: resolver.formRowsFromSchema(
          content["multipart/form-data"],
        ),
      };
    }
    return {};
  }

  // Swagger 2.0
  const params = resolvedParams ?? operation.parameters ?? [];
  const bodyParam = params.find((p) => p && p.in === "body");
  if (bodyParam) {
    const ex = bodyParam.schema
      ? resolver.exampleFromSchema(bodyParam.schema)
      : null;
    const bodyText = ex == null ? "" : JSON.stringify(ex, null, 2);
    return { bodyType: "json", bodyText };
  }
  const formParams = params.filter((p) => p && p.in === "formData");
  if (formParams.length > 0) {
    const consumes = operation.consumes ?? spec.consumes ?? [];
    const rows = formParams.map((p) =>
      p.type === "file"
        ? {
            enabled: true,
            name: p.name ?? "",
            value: "",
            kind: "file",
            filePath: "",
            fileName: "",
            contentType: "",
          }
        : { enabled: true, name: p.name ?? "", value: "" },
    );
    return consumes.includes("multipart/form-data")
      ? { bodyType: "form-data", bodyFormRows: rows }
      : { bodyType: "form-urlencoded", bodyFormRows: rows };
  }
  return {};
}

/** Human-readable warnings for remote $refs that could not be resolved. */
function refWarnings(resolver) {
  if (resolver.remoteRefs.size === 0) return [];
  const refs = [...resolver.remoteRefs];
  const shown = refs.slice(0, 5).join(", ");
  const more = refs.length > 5 ? ` (and ${refs.length - 5} more)` : "";
  return [
    `Skipped ${refs.length} remote $ref(s) that require network access and could not be resolved: ${shown}${more}.`,
  ];
}

/**
 * Parse an OpenAPI 3.x or Swagger 2.0 spec.
 *
 * @param {object} spec  Parsed JSON / YAML object
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}  Variables use the canonical array shape.
 */
export function parseOpenApi(spec) {
  const isV3 = Boolean(spec.openapi);
  const baseUrl = resolveBaseUrl(spec);
  const title = spec.info?.title ?? "Imported API";
  const globalSec = spec.security ?? [];
  const resolver = new RefResolver(spec);

  // Group requests by tag
  const tagBuckets = new Map(); // tag → request[]

  for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
    // Path Item Objects may themselves be a $ref.
    const pathItem = resolver.deref(rawPathItem);
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const tag = operation.tags?.[0] ?? "Default";
      if (!tagBuckets.has(tag)) tagBuckets.set(tag, []);

      // Merge path-level and operation-level parameters, resolving any $refs
      // into shared components (which carry the `.in` the filters below need).
      const allParams = [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? []),
      ]
        .map((p) => resolver.deref(p))
        .filter((p) => p && typeof p === "object");

      const queryParams = allParams
        .filter((p) => p.in === "query")
        .map((p) => ({
          enabled: true,
          name: p.name ?? "",
          value: paramValueHint(p, isV3, resolver),
        }));

      const headerParams = allParams
        .filter((p) => p.in === "header")
        .map((p) => ({
          enabled: true,
          name: p.name ?? "",
          value: paramValueHint(p, isV3, resolver),
        }));

      const security = operation.security ?? globalSec;
      const authResult = buildAuth(spec, security);

      // apiKey-as-header goes into headers; apiKey-as-query goes into params.
      const extraHeaders = authResult._extraHeaders ?? [];
      const extraParams = authResult._extraParams ?? [];
      delete authResult._extraHeaders;
      delete authResult._extraParams;

      const bodyResult = buildBody(spec, operation, isV3, resolver, allParams);
      // A non-default body mime (e.g. application/vnd.api+json) is surfaced as
      // an explicit Content-Type header; the default mime is left implicit.
      const contentTypeHeader = bodyResult._contentType
        ? [
            {
              enabled: true,
              name: "Content-Type",
              value: bodyResult._contentType,
            },
          ]
        : [];
      delete bodyResult._contentType;

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
        headers: [...headerParams, ...contentTypeHeader, ...extraHeaders],
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
      variables: [],
      children: requests,
    }));
  }

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: title,
      variables: [],
      children,
    },
    // Canonical array shape; the templated base URL becomes a `baseUrl` variable.
    variables: baseUrl
      ? [{ name: "baseUrl", value: baseUrl, secure: false }]
      : [],
    warnings: refWarnings(resolver),
  };
}
