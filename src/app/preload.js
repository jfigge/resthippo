// preload.js — Runs in the renderer process before page content loads.
// Exposes a narrow, safe API surface to the renderer via contextBridge.
"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("wurl", {
  /** Platform string: 'darwin' | 'win32' | 'linux' */
  platform: process.platform,

  /** App version from package.json */
  version: require("../package.json").version,
});
