"use strict";

/** @type {Record<string, { label: string, category: string, params: Array<{name: string, label: string, type: string, default: string, options?: string[], placeholder?: string}> }>} */
export const registry = {
  uuid: {
    label: "UUID v4",
    category: "built-in",
    params: [],
  },
  now: {
    label: "Current timestamp",
    category: "built-in",
    params: [
      {
        name: "format",
        label: "Format",
        type: "enum",
        default: "ISO",
        options: ["ISO", "Unix", "UnixMs", "RFC2822"],
      },
    ],
  },
  base64encode: {
    label: "Base64 encode",
    category: "built-in",
    params: [{ name: "value", label: "Value", type: "string", default: "" }],
  },
  base64decode: {
    label: "Base64 decode",
    category: "built-in",
    params: [{ name: "value", label: "Value", type: "string", default: "" }],
  },
  urlEncode: {
    label: "URL percent-encode",
    category: "built-in",
    params: [{ name: "value", label: "Value", type: "string", default: "" }],
  },
  urlDecode: {
    label: "URL percent-decode",
    category: "built-in",
    params: [{ name: "value", label: "Value", type: "string", default: "" }],
  },
  randomInt: {
    label: "Random integer",
    category: "built-in",
    params: [
      { name: "min", label: "Min", type: "string", default: "0" },
      { name: "max", label: "Max", type: "string", default: "100" },
    ],
  },

  folderName: {
    label: "Folder name",
    category: "context",
    params: [
      {
        name: "depth",
        label: "Depth",
        type: "string",
        default: "0",
        placeholder: "0 = immediate parent",
      },
    ],
  },
  collectionName: {
    label: "Collection name",
    category: "context",
    params: [],
  },
  environmentVariable: {
    label: "Environment variable",
    category: "backend",
    params: [{ name: "name", label: "Variable", type: "string", default: "" }],
  },

  hmac: {
    label: "HMAC",
    category: "backend",
    params: [
      {
        name: "algo",
        label: "Algorithm",
        type: "enum",
        default: "SHA256",
        options: ["SHA256", "SHA512"],
      },
      { name: "key", label: "Key", type: "string", default: "" },
      { name: "message", label: "Message", type: "string", default: "" },
    ],
  },
  hash: {
    label: "Hash",
    category: "backend",
    params: [
      {
        name: "algo",
        label: "Algorithm",
        type: "enum",
        default: "SHA256",
        options: ["SHA256", "SHA512"],
      },
      { name: "value", label: "Value", type: "string", default: "" },
    ],
  },
  requestName: {
    label: "Request name",
    category: "context",
    params: [],
  },
  environmentName: {
    label: "Environment name",
    category: "context",
    params: [],
  },

  response: {
    label: "Request response body",
    category: "request-output",
    params: [
      {
        name: "requestName",
        label: "Request",
        type: "request-picker",
        default: "",
      },
      {
        name: "query",
        label: "Query",
        type: "string",
        default: ".",
        placeholder: ".data.token",
      },
      {
        name: "executionMode",
        label: "Refresh mode",
        type: "enum",
        options: ["Use last result", "Run immediately before"],
        default: "Use last result",
      },
    ],
  },
  responseHeader: {
    label: "Response header",
    category: "request-output",
    params: [
      {
        name: "requestName",
        label: "Request",
        type: "request-picker",
        default: "",
      },
      { name: "headerName", label: "Header name", type: "string", default: "" },
      {
        name: "executionMode",
        label: "Refresh mode",
        type: "enum",
        options: ["Use last result", "Run immediately before"],
        default: "Use last result",
      },
    ],
  },
  responseStatus: {
    label: "Response HTTP status",
    category: "request-output",
    params: [
      {
        name: "requestName",
        label: "Request",
        type: "request-picker",
        default: "",
      },
      {
        name: "executionMode",
        label: "Refresh mode",
        type: "enum",
        options: ["Use last result", "Run immediately before"],
        default: "Use last result",
      },
    ],
  },
};
