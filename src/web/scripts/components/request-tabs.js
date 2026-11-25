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
 * components/request-tabs.js — static request-editor specs: the HTTP method
 * list and the tab sets per protocol (HTTP, WebSocket). The Command tab set
 * (Feature 70) lives with its editor in command/command-editor.js.
 */

"use strict";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

// Tab labels resolve from the i18n catalog at render time (see #renderTabStrip);
// labelKey, not a literal, because these arrays are built at module load — before
// the catalog is ready.
export const TABS = [
  { id: "params", labelKey: "request.tab.params" },
  { id: "headers", labelKey: "request.tab.headers" },
  { id: "body", labelKey: "request.tab.body" },
  { id: "auth", labelKey: "request.tab.auth" },
  { id: "captures", labelKey: "request.tab.captures" },
  { id: "tests", labelKey: "request.tab.tests" },
  { id: "scripts", labelKey: "request.tab.scripts" },
  { id: "notes", labelKey: "request.tab.notes" },
];

// Tabs for a WebSocket request (Feature 32): the Body tab is replaced by the
// Message composer. Params/Headers/Auth apply to the handshake; Notes are shared.
export const WS_TABS = [
  { id: "params", labelKey: "request.tab.params" },
  { id: "headers", labelKey: "request.tab.headers" },
  { id: "message", labelKey: "request.tab.message" },
  { id: "auth", labelKey: "request.tab.auth" },
  { id: "captures", labelKey: "request.tab.captures" },
  { id: "tests", labelKey: "request.tab.tests" },
  { id: "scripts", labelKey: "request.tab.scripts" },
  { id: "notes", labelKey: "request.tab.notes" },
];
