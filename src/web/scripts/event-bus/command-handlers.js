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
 * command-handlers.js — the interactive Execute path for Command requests
 * (Feature 70).
 *
 * The editor has already resolved {{variables}} per token and built the
 * descriptor (components/command/command-exec.js); here we register the run as
 * an in-flight execution (so the shared hippo:cancel-request path can stop it),
 * ask for approval when the command template is new or changed, execute it in
 * the main process, and publish the result on the normal request lifecycle
 * events — hippo:response-received / hippo:request-error — so the viewer,
 * Timeline, captures, tests and chaining treat it like any other response.
 *
 * @param {object} ctx
 * @param {() => object|null} ctx.getSelectedNode
 * @param {(id: string|null) => object|null} ctx.findRequestNode
 * @param {Set<object>} ctx.inFlightExecs     shared with the cancel handler
 * @param {(node: object) => void} ctx.bumpRecents
 * @param {(name: string, message: string) => string} ctx.buildHint
 */
import { t } from "../i18n.js";
import {
  runCommand,
  commandRequestSnapshot,
} from "../components/command/command-exec.js";
import { confirmCommandRun } from "../components/command/command-approval.js";

/** A user-facing hint for a failed command (falls back to the HTTP hints). */
export function commandErrorHint(name, message, buildHint) {
  if (name === "CommandNotFound") return t("command.error.notFoundHint");
  if (name === "CommandNotApproved") return t("command.error.notApprovedHint");
  if (name === "TimeoutError") return t("command.error.timeoutHint");
  if (name === "Unavailable") return t("request.cmd.unavailable");
  if (name === "SpawnError") return t("command.error.spawnHint");
  return buildHint?.(name, message) ?? "";
}

export function installCommandHandlers(ctx) {
  window.addEventListener("hippo:send-command", async (e) => {
    const { requestId = null, descriptor, variables = [] } = e.detail ?? {};
    if (!descriptor) return;

    const selected = ctx.getSelectedNode();
    const requestNode =
      selected?.id === requestId ? selected : ctx.findRequestNode(requestId);
    if (requestNode) ctx.bumpRecents(requestNode);
    const desc = { ...descriptor, name: requestNode?.name ?? descriptor.name };
    const request = { ...commandRequestSnapshot(desc), variables };

    // Register like an HTTP send so hippo:cancel-request finds it; `cancel`
    // kills the process tree in main (SIGTERM → SIGKILL / taskkill /T).
    const execId = crypto.randomUUID();
    const exec = {
      requestId,
      snapshot: request,
      abortController: null,
      cancelled: false,
      streamId: null,
      cancel: () =>
        window.hippo?.command?.cancel?.({ id: execId })?.catch?.(() => {}),
    };
    ctx.inFlightExecs.add(exec);
    window.dispatchEvent(
      new CustomEvent("hippo:request-loading", {
        detail: { requestId, streamId: null },
      }),
    );

    try {
      const result = await runCommand(desc, {
        confirm: confirmCommandRun,
        id: execId,
      });
      if (exec.cancelled) return;
      if (result.error && result.status === 0) {
        const { name, message } = result.error;
        window.dispatchEvent(
          new CustomEvent("hippo:request-error", {
            detail: {
              requestId,
              requestNode,
              request,
              name,
              message,
              hint: commandErrorHint(name, message, ctx.buildHint),
              elapsed: result.elapsed ?? 0,
              consoleLog: result.consoleLog ?? [],
              stderr: result.stderr ?? "",
              kind: "command",
            },
          }),
        );
        return;
      }
      window.dispatchEvent(
        new CustomEvent("hippo:response-received", {
          detail: {
            requestId,
            requestNode,
            request,
            status: result.status,
            statusText: result.statusText ?? "",
            headers: result.headers ?? {},
            cookies: [],
            body: result.body ?? "",
            elapsed: result.elapsed ?? 0,
            size: result.size ?? 0,
            consoleLog: result.consoleLog ?? [],
            encoding: result.encoding ?? "utf8",
            truncated: result.truncated ?? false,
            bodyRef: result.bodyRef ?? null,
            fullSize: result.fullSize ?? result.size ?? 0,
            kind: "command",
            stderr: result.stderr ?? "",
            stderrSize: result.stderrSize ?? 0,
            stderrTruncated: result.stderrTruncated ?? false,
            stderrRef: result.stderrRef ?? null,
          },
        }),
      );
    } catch (err) {
      if (exec.cancelled) return;
      const name = (err instanceof Error ? err.name : "Error") || "Error";
      const message = (err instanceof Error ? err.message : String(err)) || "";
      window.dispatchEvent(
        new CustomEvent("hippo:request-error", {
          detail: {
            requestId,
            requestNode,
            request,
            name,
            message,
            hint: commandErrorHint(name, message, ctx.buildHint),
            elapsed: 0,
            consoleLog: [`* ${name}: ${message}`],
            kind: "command",
          },
        }),
      );
    } finally {
      ctx.inFlightExecs.delete(exec);
    }
  });
}
