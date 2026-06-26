// run.mjs — Orchestrator for the Rest Hippo UI end-to-end suite.
//
// Drives the REAL app, end to end:
//   1. seed an isolated, secret-free data dir (reuses .docs-build/seed.mjs)
//   2. ensure the Go mock API is up on :8888 (reuse a running one, else launch)
//   3. launch the packaged renderer via Electron with --remote-debugging-port
//   4. connect over CDP and run every spec in specs.mjs against the live UI
//   5. tear everything we started back down and exit non-zero on any failure
//
// This is intentionally NOT part of `make test` — it needs a display server, a
// real Electron process and the mock API, none of which belong in the hermetic
// unit-test gate. Run it on demand:  node e2e/run.mjs  (or `make test-e2e`).
//
//   node e2e/run.mjs                  # run the whole suite
//   node e2e/run.mjs send response    # run only specs whose name matches a term
//   KEEP_OPEN=1 node e2e/run.mjs ...  # leave the app running after the suite
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, makeHelpers } from "./harness.mjs";
import { specs } from "./specs.mjs";
import { geometrySpecs } from "./geometry.mjs";

// Behaviour specs + the real-layout geometry specs (selected by name, e.g.
// `node e2e/run.mjs geometry`). Both share the same launch / seed / teardown.
const allSpecs = [...specs, ...geometrySpecs];

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, "e2e", ".data"); // gitignored; clobbered each run
const ELECTRON = join(ROOT, "src", "node_modules", ".bin", "electron");
const SEED = join(ROOT, ".docs-build", "seed.mjs");
const MOCK_BIN = join(ROOT, "mock", "mock-server");
const LOG = join(DATA, "electron.log");
const CDP_PORT = 9222;
const MOCK_URL = "http://localhost:8888";

const only = process.argv.slice(2);
const started = []; // teardown stack of { name, fn }

// ── small process / http utilities ────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}
async function reachable(url, ms = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    await fetch(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
async function waitReachable(
  url,
  { timeout = 20000, interval = 250, label } = {},
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await reachable(url)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label || url}`);
}

// ── stages ────────────────────────────────────────────────────────────────────
async function seed() {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  await run(process.execPath, [SEED, DATA]);
}

async function ensureMock() {
  if (await reachable(`${MOCK_URL}/status/200`)) {
    console.log("• mock API already running on :8888 — reusing");
    return;
  }
  console.log("• launching mock API on :8888");
  const fd = openSync(join(DATA, "mock.log"), "a");
  const mock = spawn(MOCK_BIN, [], {
    cwd: join(ROOT, "mock"),
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  mock.unref();
  started.push({ name: "mock", fn: () => process.kill(-mock.pid, "SIGKILL") });
  await waitReachable(`${MOCK_URL}/status/200`, { label: "mock API" });
}

async function launchApp() {
  if (await reachable(`http://localhost:${CDP_PORT}/json/version`)) {
    throw new Error(
      `Something is already listening on the CDP port ${CDP_PORT} ` +
        `(a 'make debug' / docs-capture session?). Close it and retry.`,
    );
  }
  console.log("• launching Electron with CDP port", CDP_PORT);
  const fd = openSync(LOG, "a");
  const app = spawn(
    ELECTRON,
    [
      "app/main.js",
      `--user-data-dir=${DATA}`,
      `--remote-debugging-port=${CDP_PORT}`,
    ],
    { cwd: join(ROOT, "src"), stdio: ["ignore", fd, fd], detached: true },
  );
  app.unref();
  started.push({
    name: "electron",
    fn: () => {
      try {
        process.kill(-app.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
    },
  });
  await waitReachable(`http://localhost:${CDP_PORT}/json`, {
    label: "CDP endpoint",
  });
}

// ── runner ────────────────────────────────────────────────────────────────────
async function main() {
  await seed();
  await ensureMock();
  await launchApp();

  // Connect (the page target may briefly 404 right after the endpoint opens).
  let cdp;
  for (let i = 0; ; i++) {
    try {
      cdp = await connect();
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  started.push({ name: "cdp", fn: () => cdp.close() });

  const h = makeHelpers(cdp);
  // App is ready once the seeded collection tree has rendered request rows.
  await h.waitFor(`document.querySelectorAll('.tree-node-row').length > 0`, {
    timeout: 20000,
    label: "renderer ready (tree rows)",
  });
  console.log("• app ready — running specs\n");

  const selected = allSpecs.filter(
    (s) => only.length === 0 || only.some((o) => s.name.includes(o)),
  );

  let pass = 0;
  const failures = [];
  for (const s of selected) {
    try {
      await h.closePopups(); // each spec starts from a clean slate
      await s.fn(h);
      console.log(`  ✓ ${s.name}`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${s.name}\n      ${e.message}`);
      failures.push({ name: s.name, error: e.message });
    }
  }

  console.log(
    `\n${pass}/${selected.length} passed` +
      (failures.length ? `, ${failures.length} failed` : ""),
  );
  return failures.length === 0;
}

// ── teardown ──────────────────────────────────────────────────────────────────
function teardown() {
  if (process.env.KEEP_OPEN) {
    console.log("\nKEEP_OPEN set — leaving the app + mock running.");
    return;
  }
  for (const { name, fn } of started.reverse()) {
    try {
      fn();
    } catch (e) {
      console.log(`  (teardown: ${name}: ${e.message})`);
    }
  }
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error("\nE2E run aborted:", e.message);
  try {
    console.error("\n--- tail of electron.log ---");
    console.error(readFileSync(LOG, "utf8").split("\n").slice(-25).join("\n"));
  } catch {
    /* no log yet */
  }
} finally {
  teardown();
}
process.exit(ok ? 0 : 1);
