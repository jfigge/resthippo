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

// Display strings are stored as i18n keys (`labelKey`), never resolved here:
// this is a module-level constant, and t()'s catalog isn't loaded at module-eval
// time. Consumers (pill picker / editor) resolve `t(labelKey)` at render time.
// `options`/`default` are stored *values* (matched at execution), not display
// text, so they stay literal.
/** @type {Record<string, { labelKey: string, category: string, params: Array<{name: string, labelKey: string, type: string, default: string, options?: string[], placeholder?: string}> }>} */
export const registry = {
  uuid: {
    labelKey: "func.uuid",
    category: "built-in",
    params: [],
  },
  now: {
    labelKey: "func.now",
    category: "built-in",
    params: [
      {
        name: "format",
        labelKey: "func.param.format",
        type: "enum",
        default: "ISO",
        options: ["ISO", "Unix", "UnixMs", "RFC2822"],
      },
    ],
  },
  base64encode: {
    labelKey: "func.base64encode",
    category: "built-in",
    params: [
      {
        name: "value",
        labelKey: "func.param.value",
        type: "string",
        default: "",
      },
    ],
  },
  base64decode: {
    labelKey: "func.base64decode",
    category: "built-in",
    params: [
      {
        name: "value",
        labelKey: "func.param.value",
        type: "string",
        default: "",
      },
    ],
  },
  urlEncode: {
    labelKey: "func.urlEncode",
    category: "built-in",
    params: [
      {
        name: "value",
        labelKey: "func.param.value",
        type: "string",
        default: "",
      },
    ],
  },
  urlDecode: {
    labelKey: "func.urlDecode",
    category: "built-in",
    params: [
      {
        name: "value",
        labelKey: "func.param.value",
        type: "string",
        default: "",
      },
    ],
  },
  randomInt: {
    labelKey: "func.randomInt",
    category: "built-in",
    params: [
      { name: "min", labelKey: "func.param.min", type: "string", default: "0" },
      {
        name: "max",
        labelKey: "func.param.max",
        type: "string",
        default: "100",
      },
    ],
  },

  folderName: {
    labelKey: "func.folderName",
    category: "context",
    params: [
      {
        name: "depth",
        labelKey: "func.param.depth",
        type: "string",
        default: "0",
        placeholder: "0 = immediate parent",
      },
    ],
  },
  collectionName: {
    labelKey: "func.collectionName",
    category: "context",
    params: [],
  },
  environmentVariable: {
    labelKey: "func.environmentVariable",
    category: "backend",
    params: [
      {
        name: "name",
        labelKey: "func.param.variable",
        type: "string",
        default: "",
      },
    ],
  },

  hmac: {
    labelKey: "func.hmac",
    category: "backend",
    params: [
      {
        name: "algo",
        labelKey: "func.param.algorithm",
        type: "enum",
        default: "SHA256",
        options: ["SHA256", "SHA512"],
      },
      { name: "key", labelKey: "func.param.key", type: "string", default: "" },
      {
        name: "message",
        labelKey: "func.param.message",
        type: "string",
        default: "",
      },
    ],
  },
  hash: {
    labelKey: "func.hash",
    category: "backend",
    params: [
      {
        name: "algo",
        labelKey: "func.param.algorithm",
        type: "enum",
        default: "SHA256",
        options: ["SHA256", "SHA512"],
      },
      {
        name: "value",
        labelKey: "func.param.value",
        type: "string",
        default: "",
      },
    ],
  },
  requestName: {
    labelKey: "func.requestName",
    category: "context",
    params: [],
  },
  environmentName: {
    labelKey: "func.environmentName",
    category: "context",
    params: [],
  },

  response: {
    labelKey: "func.response",
    category: "request-output",
    params: [
      {
        name: "requestName",
        labelKey: "func.param.request",
        type: "request-picker",
        default: "",
      },
      {
        name: "query",
        labelKey: "func.param.query",
        type: "string",
        default: ".",
        placeholder: ".data.token",
      },
      {
        name: "executionMode",
        labelKey: "func.param.refreshMode",
        type: "enum",
        options: ["Use last result", "Run immediately before"],
        default: "Use last result",
      },
    ],
  },
  responseHeader: {
    labelKey: "func.responseHeader",
    category: "request-output",
    params: [
      {
        name: "requestName",
        labelKey: "func.param.request",
        type: "request-picker",
        default: "",
      },
      {
        name: "headerName",
        labelKey: "func.param.headerName",
        type: "string",
        default: "",
      },
      {
        name: "executionMode",
        labelKey: "func.param.refreshMode",
        type: "enum",
        options: ["Use last result", "Run immediately before"],
        default: "Use last result",
      },
    ],
  },
  responseStatus: {
    labelKey: "func.responseStatus",
    category: "request-output",
    params: [
      {
        name: "requestName",
        labelKey: "func.param.request",
        type: "request-picker",
        default: "",
      },
      {
        name: "executionMode",
        labelKey: "func.param.refreshMode",
        type: "enum",
        options: ["Use last result", "Run immediately before"],
        default: "Use last result",
      },
    ],
  },
};
