/**
 * export/tests/resthippo.test.js
 *
 * Tests the native "Rest Hippo v1" archive builder: the referenced-variable
 * collection (with transitive closure and function-token skipping) and the
 * environment/global filtering rules (referenced-only; drop empty environments;
 * keep collection vars in full).
 *
 * Run with:   node --test export/tests/resthippo.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRestHippoArchive,
  collectReferencedVariables,
} from "../resthippo.js";

function fixtureItems() {
  return [
    {
      id: "f1",
      type: "collection",
      name: "API",
      variables: [{ name: "folderVar", value: "{{deep}}", secure: false }],
      children: [
        {
          id: "r1",
          type: "request",
          name: "Get user",
          method: "GET",
          url: "{{baseUrl}}/users",
          params: [],
          headers: [
            { enabled: true, name: "Authorization", value: "Bearer {{token}}" },
          ],
          // A function pill must NOT be collected as a variable reference.
          bodyType: "no-body",
          preRequestScript: "console.log('{{uuid()}}')",
          authEnabled: false,
          authType: "none",
        },
      ],
    },
  ];
}

function fixtureEnvironments() {
  return {
    activeEnvironmentId: "e1",
    globalVariables: [
      { name: "token", value: "abc", secure: true },
      { name: "unusedGlobal", value: "x", secure: false },
    ],
    environments: [
      {
        id: "e1",
        name: "Dev",
        variables: [
          { name: "baseUrl", value: "http://dev", secure: false },
          { name: "unused", value: "y", secure: false },
        ],
      },
      // No referenced variable → must be dropped from the archive entirely.
      {
        id: "e2",
        name: "Prod",
        variables: [{ name: "other", value: "z", secure: false }],
      },
      // Referenced transitively: folderVar → {{deep}}; deep → {{token}}.
      {
        id: "e3",
        name: "Deep",
        variables: [{ name: "deep", value: "{{token}}", secure: false }],
      },
    ],
  };
}

test("collectReferencedVariables: seeds from items and closes transitively", () => {
  const refs = collectReferencedVariables(fixtureItems(), [
    fixtureEnvironments().globalVariables,
    ...fixtureEnvironments().environments.map((e) => e.variables),
  ]);
  assert.ok(refs.has("baseUrl"));
  assert.ok(refs.has("token"));
  assert.ok(refs.has("deep")); // via folder variable value {{deep}}
  assert.ok(!refs.has("unused"));
  assert.ok(!refs.has("unusedGlobal"));
  assert.ok(!refs.has("other"));
  assert.ok(!refs.has("uuid()")); // function pill, not a variable
});

test("buildRestHippoArchive: envelope shape + format markers", () => {
  const archive = buildRestHippoArchive({
    items: fixtureItems(),
    collectionVariables: [{ name: "collVar", value: "1", secure: false }],
    environments: fixtureEnvironments(),
    exportedAt: "2026-06-18T00:00:00.000Z",
  });
  assert.equal(archive.format, "resthippo");
  assert.equal(archive.kind, "resthippo-collection");
  assert.equal(archive.formatVersion, 1);
  assert.equal(archive.secretsMode, "none");
  assert.equal(archive.exportedAt, "2026-06-18T00:00:00.000Z");
});

test("buildRestHippoArchive: environments filtered to referenced-only", () => {
  const archive = buildRestHippoArchive({
    items: fixtureItems(),
    collectionVariables: [],
    environments: fixtureEnvironments(),
    exportedAt: "x",
  });

  // Prod (e2) contributes nothing → dropped. Dev + Deep remain.
  const names = archive.environments.environments.map((e) => e.name).sort();
  assert.deepEqual(names, ["Deep", "Dev"]);

  const dev = archive.environments.environments.find((e) => e.name === "Dev");
  assert.deepEqual(
    dev.variables.map((v) => v.name),
    ["baseUrl"],
  );

  // Global filtered: only the referenced (token), not unusedGlobal.
  assert.deepEqual(
    archive.environments.globalVariables.map((v) => v.name),
    ["token"],
  );
});

test("buildRestHippoArchive: collection variables filtered to referenced-only; items cloned", () => {
  const items = fixtureItems();
  const archive = buildRestHippoArchive({
    items,
    collectionVariables: [
      { name: "token", value: "secret", secure: true }, // referenced (header) → kept
      { name: "unusedColl", value: "1", secure: false }, // not referenced → dropped
    ],
    environments: { globalVariables: [], environments: [] },
    exportedAt: "x",
  });
  assert.deepEqual(
    archive.collectionVariables.map((v) => v.name),
    ["token"],
  );
  // The archive must be a clone — mutating it cannot reach the live tree.
  archive.items[0].name = "MUTATED";
  assert.equal(items[0].name, "API");
});

test("buildRestHippoArchive: tolerates empty/missing input", () => {
  const archive = buildRestHippoArchive({});
  assert.deepEqual(archive.items, []);
  assert.deepEqual(archive.collectionVariables, []);
  assert.deepEqual(archive.environments.globalVariables, []);
  assert.deepEqual(archive.environments.environments, []);
});
