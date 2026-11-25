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
 * net/command-runner.js — spawns Command requests (Feature 70).
 *
 * A command runs DIRECTLY (`child_process.spawn`, `shell: false`, executable +
 * argument array) with an environment built only from Rest Hippo's settings and
 * the request's Environment rows (see command-env.js). The executable is
 * resolved against that environment's PATH by the app itself
 * (command-resolve.js); Windows `.cmd`/`.bat` files go through cmd.exe
 * explicitly with escaped arguments.
 *
 * The result is shaped like an HTTP result so the response viewer, captures,
 * tests and chaining work unchanged:
 *   status ← exit code · body ← stdout · stderr ← stderr (own panel) ·
 *   headers["content-type"] ← the request's chosen output type.
 *
 * Cancellation: SIGTERM to the whole process group, then SIGKILL after a grace
 * period (POSIX); on Windows `taskkill /T` (tree) then `taskkill /T /F`.
 * Large stdout/stderr spill to disk via body-spill.js, exactly like HTTP bodies.
 */
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const nodePath = require("path");
const { SpillCollector, SpillRegistry } = require("./body-spill");
const { decodeText, looksBinary } = require("../http-content-type");
const {
  resolveExecutable,
  isBatchFile,
  buildBatchInvocation,
} = require("./command-resolve");
const { envGet } = require("./command-env");

/** Grace period between the polite and the forceful kill. */
const KILL_GRACE_MS = 2000;
/** After the process exits, how long to wait for its stdio to close (a
 *  backgrounded grandchild can hold the pipes open indefinitely). */
const STDIO_CLOSE_GRACE_MS = 500;

/** Output type → the synthetic Content-Type the viewer/filters key off. */
const OUTPUT_CONTENT_TYPES = {
  json: "application/json",
  yaml: "application/yaml",
  xml: "application/xml",
  text: "text/plain; charset=utf-8",
};

/**
 * Content type for stdout. An explicit output type wins; `auto` sniffs the
 * (possibly preview-only) bytes: JSON-looking → json, `<` → xml, binary →
 * octet-stream, else plain text.
 * @param {string} outputType
 * @param {Buffer} sample
 * @param {boolean} complete  sample is the whole output (JSON.parse is meaningful)
 */
function contentTypeFor(outputType, sample, complete) {
  if (OUTPUT_CONTENT_TYPES[outputType]) return OUTPUT_CONTENT_TYPES[outputType];
  if (looksBinary(sample)) return "application/octet-stream";
  const text = sample.toString("utf8").trim();
  if (/^[[{]/.test(text)) {
    if (!complete) return OUTPUT_CONTENT_TYPES.json;
    try {
      JSON.parse(text);
      return OUTPUT_CONTENT_TYPES.json;
    } catch {
      // not JSON after all — fall through
    }
  }
  if (text.startsWith("<")) return OUTPUT_CONTENT_TYPES.xml;
  return OUTPUT_CONTENT_TYPES.text;
}

/** Signal number for a name (POSIX convention: exit status = 128 + signo). */
function signalExitStatus(signal) {
  const n = os.constants.signals?.[signal];
  return typeof n === "number" ? 128 + n : 1;
}

/** Working directory: the env's home when it's a real directory, else the OS home. */
function workingDir(env, platform) {
  const home = envGet(
    env,
    platform === "win32" ? "USERPROFILE" : "HOME",
    platform,
  );
  try {
    if (home && fs.statSync(home).isDirectory()) return home;
  } catch {
    // fall through
  }
  return os.homedir();
}

class CommandRunner {
  /** id → { child, senderId, killTimer, cancelled, timedOut, settled } */
  #active = new Map();
  #spill;
  #cacheDir;
  #platform;
  #spawn;

  /**
   * @param {object} [opts]
   * @param {SpillRegistry} [opts.spillRegistry]
   * @param {() => string} [opts.cacheDir]  temp dir for spilled output
   * @param {string} [opts.platform]
   * @param {typeof childProcess.spawn} [opts.spawn]
   */
  constructor({
    spillRegistry = new SpillRegistry(),
    cacheDir = () => os.tmpdir(),
    platform = process.platform,
    spawn = childProcess.spawn,
  } = {}) {
    this.#spill = spillRegistry;
    this.#cacheDir = cacheDir;
    this.#platform = platform;
    this.#spawn = spawn;
  }

  /** True while `id` is running. */
  isRunning(id) {
    return this.#active.has(id);
  }

  /**
   * Resolve an executable against an env's PATH (the editor's red-highlight
   * probe). @returns {string|null}
   */
  resolve(executable, env) {
    const p = this.#platform;
    return resolveExecutable(executable, {
      pathValue: envGet(env, "PATH", p) ?? "",
      pathext: envGet(env, "PATHEXT", p),
      platform: p,
      cwd: workingDir(env, p),
    });
  }

  /**
   * Run a command to completion.
   * @param {string} id  caller-minted id (also the cancel handle)
   * @param {object} desc
   * @param {string}   desc.executable
   * @param {string[]} [desc.args]
   * @param {Record<string,string>} desc.env   the COMPLETE process env
   * @param {string}   [desc.stdin]
   * @param {number}   [desc.timeoutMs]  0/absent = no timeout
   * @param {string}   [desc.outputType] auto|json|yaml|xml|text
   * @param {number}   [desc.senderId]   owning renderer (lifecycle cleanup)
   * @returns {Promise<object>} HTTP-shaped result (see module doc)
   */
  run(id, desc) {
    const startTime = Date.now();
    const platform = this.#platform;
    const args = (desc.args || []).map((a) => String(a));
    const env = { ...(desc.env || {}) };
    const consoleLog = [];
    const fail = (name, message, code) => ({
      status: 0,
      statusText: "",
      headers: {},
      body: "",
      stderr: "",
      elapsed: Date.now() - startTime,
      consoleLog,
      kind: "command",
      error: { name, message, ...(code ? { code } : {}) },
    });

    const exe = String(desc.executable || "").trim();
    if (!exe) return Promise.resolve(fail("CommandError", "No command given."));
    const resolved = this.resolve(exe, env);
    if (!resolved) {
      return Promise.resolve(
        fail(
          "CommandNotFound",
          `"${exe}" was not found on the command PATH.`,
          "ENOENT",
        ),
      );
    }

    consoleLog.push(`* Executable: ${resolved}`);
    args.forEach((a, i) => consoleLog.push(`* argv[${i + 1}]: ${a}`));
    consoleLog.push(
      `* Environment: ${Object.keys(env).join(", ") || "(empty)"}`,
    );

    let command = resolved;
    let spawnArgs = args;
    const options = {
      env,
      cwd: workingDir(env, platform),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (platform === "win32" && isBatchFile(resolved)) {
      const inv = buildBatchInvocation(
        resolved,
        args,
        envGet(env, "SystemRoot", platform) || process.env.SystemRoot,
      );
      command = inv.command;
      spawnArgs = inv.args;
      options.windowsVerbatimArguments = true;
      consoleLog.push(`* Batch file — running via ${command}`);
    } else if (platform !== "win32") {
      // Own process group, so cancel can signal the whole tree.
      options.detached = true;
    }

    return new Promise((resolve) => {
      let child;
      try {
        child = this.#spawn(command, spawnArgs, options);
      } catch (err) {
        resolve(fail("SpawnError", err.message, err.code));
        return;
      }

      const out = new SpillCollector({ dir: this.#cacheDir });
      const errOut = new SpillCollector({ dir: this.#cacheDir });
      const entry = {
        child,
        senderId: desc.senderId,
        killTimer: null,
        timeoutTimer: null,
        cancelled: false,
        timedOut: false,
        settled: false,
      };
      this.#active.set(id, entry);

      const pipe = (stream, collector) => {
        stream?.on("data", (chunk) => {
          if (!collector.write(chunk)) {
            stream.pause();
            collector.onceDrain(() => stream.resume());
          }
        });
        stream?.on("error", () => {});
      };
      pipe(child.stdout, out);
      pipe(child.stderr, errOut);

      // stdin: write once and close (an unread pipe → EPIPE, harmless).
      child.stdin?.on("error", () => {});
      if (desc.stdin) child.stdin?.end(String(desc.stdin));
      else child.stdin?.end();

      if (desc.timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          entry.timedOut = true;
          this.#terminate(entry);
        }, desc.timeoutMs);
      }

      let exitInfo = null;
      let stdioTimer = null;

      const settle = async () => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timeoutTimer);
        clearTimeout(entry.killTimer);
        clearTimeout(stdioTimer);
        this.#active.delete(id);
        const elapsed = Date.now() - startTime;

        if (entry.cancelled) {
          out.discard();
          errOut.discard();
          resolve(fail("AbortError", "Command cancelled."));
          return;
        }
        const [o, e] = await Promise.all([out.finish(), errOut.finish()]);
        if (entry.timedOut) {
          if (o.path) fs.promises.rm(o.path, { force: true }).catch(() => {});
          if (e.path) fs.promises.rm(e.path, { force: true }).catch(() => {});
          const r = fail(
            "TimeoutError",
            `Command timed out after ${desc.timeoutMs / 1000} s.`,
            "ETIMEDOUT",
          );
          r.stderr = (e.buffer ?? e.preview).toString("utf8");
          resolve(r);
          return;
        }

        const { code, signal } = exitInfo || {};
        const status =
          typeof code === "number"
            ? code
            : signal
              ? signalExitStatus(signal)
              : 1;
        consoleLog.push(
          signal ? `* Terminated by ${signal}` : `* Exited with code ${status}`,
        );
        consoleLog.push(`* stdout ${o.total} B · stderr ${e.total} B`);

        const contentType = contentTypeFor(
          desc.outputType || "auto",
          o.buffer ?? o.preview,
          !!o.buffer,
        );
        const binary = contentType === "application/octet-stream";
        const encode = (buf, ct) =>
          binary ? buf.toString("base64") : decodeText(buf, ct);

        const result = {
          status,
          statusText: signal || "",
          headers: { "content-type": contentType },
          cookies: [],
          elapsed,
          consoleLog,
          kind: "command",
          executable: resolved,
          body: encode(o.buffer ?? o.preview, contentType),
          encoding: binary ? "base64" : "utf8",
          size: o.total,
          stderr: (e.buffer ?? e.preview).toString("utf8"),
          stderrSize: e.total,
        };
        if (!o.buffer) {
          result.truncated = true;
          result.fullSize = o.total;
          if (o.path) {
            result.bodyRef = this.#spill.register({
              path: o.path,
              size: o.total,
              contentType,
              isBinary: binary,
            });
          }
        }
        if (!e.buffer) {
          result.stderrTruncated = true;
          if (e.path) {
            result.stderrRef = this.#spill.register({
              path: e.path,
              size: e.total,
              contentType: OUTPUT_CONTENT_TYPES.text,
              isBinary: false,
            });
          }
        }
        resolve(result);
      };

      child.on("error", (err) => {
        // Spawn failure (ENOENT/EACCES/EINVAL) — no exit/close will follow.
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timeoutTimer);
        clearTimeout(entry.killTimer);
        this.#active.delete(id);
        out.discard();
        errOut.discard();
        resolve(fail("SpawnError", err.message, err.code));
      });
      child.on("exit", (code, signal) => {
        exitInfo = { code, signal };
        // Don't wait forever for pipes a backgrounded grandchild still holds.
        stdioTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle();
        }, STDIO_CLOSE_GRACE_MS);
      });
      child.on("close", (code, signal) => {
        if (!exitInfo) exitInfo = { code, signal };
        settle();
      });
    });
  }

  /** Cancel a running command. @returns {{ok:boolean, reason?:string}} */
  cancel(id) {
    const entry = this.#active.get(id);
    if (!entry) return { ok: false, reason: "not-found" };
    entry.cancelled = true;
    this.#terminate(entry);
    return { ok: true };
  }

  /** Cancel every command owned by a renderer (reload / crash / close). */
  cancelForSender(senderId) {
    for (const [id, entry] of this.#active) {
      if (entry.senderId === senderId) this.cancel(id);
    }
  }

  /** Cancel everything (app quit). */
  cancelAll() {
    for (const id of [...this.#active.keys()]) this.cancel(id);
  }

  /** Polite kill now, forceful kill after the grace period. */
  #terminate(entry) {
    if (entry.killTimer) return; // already terminating
    const pid = entry.child.pid;
    this.#signal(pid, entry.child, false);
    entry.killTimer = setTimeout(
      () => this.#signal(pid, entry.child, true),
      KILL_GRACE_MS,
    );
    entry.killTimer.unref?.();
  }

  #signal(pid, child, force) {
    if (!pid) return;
    if (this.#platform === "win32") {
      // Kill the whole tree — CLIs routinely spawn helpers. taskkill is run by
      // absolute path so the user's command PATH can't redirect it.
      const root = process.env.SystemRoot || "C:\\Windows";
      const taskkill = nodePath.win32.join(root, "System32", "taskkill.exe");
      const a = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
      try {
        const k = this.#spawn(taskkill, a, {
          windowsHide: true,
          stdio: "ignore",
        });
        k.on?.("error", () => {});
      } catch {
        // best-effort
      }
      if (force) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
      return;
    }
    const sig = force ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-pid, sig); // the whole process group (detached: true)
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  }
}

module.exports = {
  CommandRunner,
  contentTypeFor,
  OUTPUT_CONTENT_TYPES,
  KILL_GRACE_MS,
};
