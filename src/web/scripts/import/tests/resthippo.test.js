/**
 * import/tests/resthippo.test.js
 *
 * Tests the native "Rest Hippo v1" import merge: detection, the identity-aware
 * tree merge (folders reused + recursed by id→name, requests replaced by id→name,
 * misses created), and the environment/variable merge (matched by id→name; vars
 * added only when missing, existing values never overwritten).
 *
 * Run with:   node --test import/tests/resthippo.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectRestHippo,
  mergeArchiveIntoTree,
  mergeEnvironments,
  mergeVariableList,
} from "../resthippo.js";

test("detectRestHippo: only matches the native envelope", () => {
  assert.equal(
    detectRestHippo({ format: "resthippo", kind: "resthippo-collection" }),
    true,
  );
  assert.equal(detectRestHippo({ format: "resthippo" }), false);
  assert.equal(detectRestHippo({ info: { schema: "getpostman.com" } }), false);
  assert.equal(detectRestHippo(null), false);
});

test("mergeArchiveIntoTree: reuse folder by id, replace request, create new", () => {
  const target = [
    {
      id: "f1",
      type: "collection",
      name: "API",
      variables: [{ name: "keep", value: "me", secure: false }],
      children: [{ id: "r1", type: "request", name: "Get", url: "OLD" }],
    },
  ];
  const archive = [
    {
      id: "f1",
      type: "collection",
      name: "API (renamed in archive)",
      variables: [{ name: "ignored", value: "x", secure: false }],
      children: [
        { id: "r1", type: "request", name: "Get", url: "NEW" }, // replace
        { id: "r2", type: "request", name: "Post", url: "P" }, // create
      ],
    },
  ];

  const { items, created, replaced } = mergeArchiveIntoTree(target, archive);
  assert.equal(created, 1);
  assert.equal(replaced, 1);

  const folder = items[0];
  // Folder reused as-is: original name + variables untouched.
  assert.equal(folder.name, "API");
  assert.deepEqual(folder.variables, [
    { name: "keep", value: "me", secure: false },
  ]);
  // Contents restored into it: r1 replaced, r2 added.
  assert.equal(folder.children.length, 2);
  assert.equal(folder.children.find((n) => n.id === "r1").url, "NEW");
  assert.ok(folder.children.find((n) => n.id === "r2"));

  // Inputs not mutated.
  assert.equal(target[0].children[0].url, "OLD");
});

test("mergeArchiveIntoTree: folder matched by name when id differs", () => {
  const target = [{ id: "f1", type: "collection", name: "API", children: [] }];
  const archive = [
    {
      id: "DIFFERENT",
      type: "collection",
      name: "API",
      children: [{ id: "r9", type: "request", name: "New", url: "u" }],
    },
  ];
  const { items, created } = mergeArchiveIntoTree(target, archive);
  assert.equal(items.length, 1); // reused, not duplicated
  assert.equal(items[0].id, "f1"); // kept existing folder identity
  assert.equal(created, 1); // the request inside it
  assert.equal(items[0].children[0].id, "r9");
});

test("mergeArchiveIntoTree: request matched by name replaces (different id)", () => {
  const target = [{ id: "rA", type: "request", name: "Login", url: "OLD" }];
  const archive = [{ id: "rB", type: "request", name: "Login", url: "NEW" }];
  const { items, created, replaced } = mergeArchiveIntoTree(target, archive);
  assert.equal(items.length, 1);
  assert.equal(replaced, 1);
  assert.equal(created, 0);
  assert.equal(items[0].url, "NEW");
});

test("mergeArchiveIntoTree: brand-new folder subtree is created and counted", () => {
  const target = [];
  const archive = [
    {
      id: "f2",
      type: "collection",
      name: "New",
      children: [
        { id: "r1", type: "request", name: "a", url: "u" },
        {
          id: "f3",
          type: "collection",
          name: "Sub",
          children: [{ id: "r2", type: "request", name: "b", url: "u" }],
        },
      ],
    },
  ];
  const { items, created } = mergeArchiveIntoTree(target, archive);
  assert.equal(items.length, 1);
  assert.equal(created, 4); // f2 + r1 + f3 + r2
});

test("mergeVariableList: adds missing by name, never overwrites existing", () => {
  const { list, added } = mergeVariableList(
    [{ name: "a", value: "keep", secure: false }],
    [
      { name: "a", value: "OVERWRITE?", secure: true },
      { name: "b", value: "new", secure: false },
    ],
  );
  assert.equal(added, 1);
  assert.equal(list.find((v) => v.name === "a").value, "keep");
  assert.ok(list.find((v) => v.name === "b"));
});

test("mergeEnvironments: match by id/name, create missing, add-only vars", () => {
  const current = {
    activeEnvironmentId: "e1",
    globalVariables: [{ name: "g1", value: "a", secure: false }],
    environments: [
      {
        id: "e1",
        name: "Dev",
        variables: [{ name: "v1", value: "x", secure: false }],
      },
    ],
  };
  const archive = {
    globalVariables: [
      { name: "g1", value: "NEW", secure: false }, // exists → kept
      { name: "g2", value: "b", secure: false }, // added
    ],
    environments: [
      {
        id: "e1",
        name: "Dev",
        variables: [
          { name: "v1", value: "NEW", secure: false }, // exists → kept
          { name: "v2", value: "y", secure: false }, // added
        ],
      },
      {
        id: "e2",
        name: "Prod",
        variables: [{ name: "p", value: "z", secure: false }],
      },
    ],
  };

  const { environments, createdEnvs, addedVars } = mergeEnvironments(
    current,
    archive,
  );
  assert.equal(createdEnvs, 1); // Prod
  assert.equal(addedVars, 3); // g2 + v2 + p

  // Global: g1 kept, g2 added.
  assert.equal(
    environments.globalVariables.find((v) => v.name === "g1").value,
    "a",
  );
  assert.ok(environments.globalVariables.find((v) => v.name === "g2"));

  // Dev reused: v1 kept, v2 added.
  const dev = environments.environments.find((e) => e.id === "e1");
  assert.equal(dev.variables.find((v) => v.name === "v1").value, "x");
  assert.ok(dev.variables.find((v) => v.name === "v2"));

  // Prod created with the exported id.
  const prod = environments.environments.find((e) => e.name === "Prod");
  assert.equal(prod.id, "e2");

  // activeEnvironmentId preserved.
  assert.equal(environments.activeEnvironmentId, "e1");
});

test("mergeEnvironments: environment matched by name when id differs", () => {
  const current = {
    globalVariables: [],
    environments: [{ id: "e1", name: "Dev", variables: [] }],
  };
  const archive = {
    globalVariables: [],
    environments: [
      {
        id: "ZZZ",
        name: "Dev",
        variables: [{ name: "k", value: "v", secure: false }],
      },
    ],
  };
  const { environments, createdEnvs } = mergeEnvironments(current, archive);
  assert.equal(createdEnvs, 0); // matched Dev by name, not created
  assert.equal(environments.environments.length, 1);
  assert.equal(environments.environments[0].id, "e1");
  assert.ok(environments.environments[0].variables.find((v) => v.name === "k"));
});
