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

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, snapshotToNode } from "../request-snapshot.js";

test("an HTTP request round-trips through the snapshot format", () => {
  const node = {
    id: "r1",
    method: "POST",
    url: "https://x/{id}",
    params: [{ name: "q", value: "1", enabled: true }],
    pathParams: [{ id: "p", name: "id", value: "7" }],
    headers: [{ name: "Accept", value: "application/json", enabled: true }],
    authType: "bearer",
    authBearer: { token: "t0k" },
    bodyType: "json",
    bodyText: '{"a":1}',
    notes: "n",
  };
  const snap = buildSnapshot(node);
  assert.equal(snap.params, "q=1");
  assert.equal(snap.auth, "token: t0k");
  const back = snapshotToNode(snap);
  assert.equal(back.method, "POST");
  assert.equal(back.url, node.url);
  assert.deepEqual(
    back.params.map((p) => [p.name, p.value, p.enabled]),
    [["q", "1", true]],
  );
  assert.equal(back.headers[0].name, "Accept");
  assert.deepEqual(back.authBearer, { token: "t0k" });
  assert.equal(back.bodyText, '{"a":1}');
  assert.deepEqual(back.pathParams, node.pathParams);
});

test("a command request keeps its fields structured (Feature 70)", () => {
  const node = {
    id: "c1",
    protocol: "command",
    commandLine: "gns token --name {{who}}",
    commandEnv: [{ id: "e", name: "A", value: "1", enabled: true }],
    commandStdin: "in",
    commandOutputType: "json",
    commandTimeoutMs: 5000,
  };
  const back = snapshotToNode(buildSnapshot(node));
  for (const k of [
    "protocol",
    "commandLine",
    "commandEnv",
    "commandStdin",
    "commandOutputType",
    "commandTimeoutMs",
  ])
    assert.deepEqual(back[k], node[k], k);
});

test("an HTTP snapshot carries no command fields", () => {
  const snap = buildSnapshot({ id: "r", method: "GET", url: "u" });
  assert.equal(snap.protocol, undefined);
  assert.equal(snapshotToNode(snap).protocol, undefined);
});
