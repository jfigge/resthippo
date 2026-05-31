/**
 * migrations.test.js — Unit tests for the schema versioning / migration runner.
 */
"use strict";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersionOf,
  migrate,
} = require("../migrations");

describe("schema version constants", () => {
  test("CURRENT_SCHEMA_VERSION equals BASE + the number of migrations", () => {
    assert.equal(
      CURRENT_SCHEMA_VERSION,
      BASE_SCHEMA_VERSION + MIGRATIONS.length,
    );
  });

  test("BASE_SCHEMA_VERSION is 1", () => {
    assert.equal(BASE_SCHEMA_VERSION, 1);
  });
});

describe("schemaVersionOf", () => {
  test("defaults a doc with no schemaVersion to BASE_SCHEMA_VERSION", () => {
    assert.equal(schemaVersionOf({ foo: 1 }), BASE_SCHEMA_VERSION);
  });

  test("ignores non-integer / out-of-range versions, falling back to BASE", () => {
    assert.equal(schemaVersionOf({ schemaVersion: "2" }), BASE_SCHEMA_VERSION);
    assert.equal(schemaVersionOf({ schemaVersion: 1.5 }), BASE_SCHEMA_VERSION);
    assert.equal(schemaVersionOf({ schemaVersion: 0 }), BASE_SCHEMA_VERSION);
    assert.equal(schemaVersionOf(null), BASE_SCHEMA_VERSION);
  });

  test("reads a valid version", () => {
    assert.equal(schemaVersionOf({ schemaVersion: 3 }), 3);
  });
});

describe("migrate — non-document inputs pass through", () => {
  test("null is returned unchanged", () => {
    assert.equal(migrate(null), null);
  });

  test("arrays are returned unchanged (no schemaVersion stamped)", () => {
    const arr = [{ a: 1 }];
    assert.equal(migrate(arr), arr);
  });

  test("primitives are returned unchanged", () => {
    assert.equal(migrate(42), 42);
    assert.equal(migrate("x"), "x");
  });
});

describe("migrate — versioning", () => {
  test("a versionless doc loads cleanly and is stamped to current", () => {
    const doc = { name: "legacy", value: 7 };
    const out = migrate(doc);
    assert.equal(out.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(out.name, "legacy");
    assert.equal(out.value, 7);
  });

  test("an already-current doc is returned untouched (same reference)", () => {
    const doc = { schemaVersion: CURRENT_SCHEMA_VERSION, name: "x" };
    assert.equal(migrate(doc), doc);
  });

  test("a doc carrying an unexpectedly newer version is left as-is", () => {
    const doc = { schemaVersion: CURRENT_SCHEMA_VERSION + 5, name: "future" };
    assert.equal(migrate(doc), doc);
  });

  test("does not mutate the input document", () => {
    const doc = { name: "legacy" };
    migrate(doc);
    assert.equal("schemaVersion" in doc, false);
  });
});

describe("migrate — forward chain order", () => {
  // These tests temporarily append migrations to the shared MIGRATIONS array to
  // exercise the runner; each restores the array so no other test is affected.
  afterEach(() => {
    MIGRATIONS.length = 0;
  });

  test("runs every migration newer than the doc's version, in order", () => {
    const calls = [];
    MIGRATIONS.push(
      (d) => {
        calls.push(1);
        return { ...d, step1: true };
      },
      (d) => {
        calls.push(2);
        return { ...d, step2: true };
      },
    );

    const out = migrate({ name: "old" }); // version 1 → 3
    assert.deepEqual(calls, [1, 2]);
    assert.equal(out.step1, true);
    assert.equal(out.step2, true);
    assert.equal(out.schemaVersion, BASE_SCHEMA_VERSION + MIGRATIONS.length);
  });

  test("only runs migrations newer than the doc's current version", () => {
    const calls = [];
    MIGRATIONS.push(
      (d) => {
        calls.push(1);
        return d;
      },
      (d) => {
        calls.push(2);
        return d;
      },
    );

    // A doc already at version 2 should skip migration[0] (1→2) and run only [1].
    const out = migrate({ schemaVersion: 2, name: "partial" });
    assert.deepEqual(calls, [2]);
    assert.equal(out.schemaVersion, 3);
  });

  test("a no-op migration bumps the version without corrupting data", () => {
    MIGRATIONS.push((d) => d);
    const out = migrate({ name: "keep", nested: { a: 1 } });
    assert.equal(out.schemaVersion, 2);
    assert.equal(out.name, "keep");
    assert.deepEqual(out.nested, { a: 1 });
  });
});
