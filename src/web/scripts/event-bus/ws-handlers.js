/**
 * ws-handlers.js — WebSocket connect / send / disconnect event-bus handlers
 * (Feature 32).
 *
 * The editor has already resolved {{var}} tokens and built the handshake
 * headers; here we open/close the main-process socket and mirror sent frames
 * into the console (the server only echoes the received side). Inbound status
 * and message pushes are handled by _onWsStatus / _onWsMessage in app.js, which
 * own the live-connection registry these handlers populate.
 *
 * Shared state (the selected node, settings, the connection maps, the live
 * console, the tree) is reached through the bus context (`ctx`, built by
 * buildBusContext() in app.js).
 *
 * @param {object} ctx
 * @param {() => object|null} ctx.getSelectedNode
 * @param {() => object} ctx.getSettings
 * @param {() => object} ctx.getWsConsole   the live (swappable) WS console instance
 * @param {() => object} ctx.getTreeView
 * @param {Map} ctx.wsConns                 socket id → live connection record
 * @param {Map} ctx.wsPendingTerminal       socket id → terminal status seen before registration
 * @param {(id: string|null) => Promise<void>} ctx.closeWsConn
 * @param {(showWs: boolean, console?: object) => void} ctx.setResponsePane
 * @param {(id: string|null) => object|null} ctx.connForRequest
 * @param {() => Set<string>} ctx.getLiveRequestIds
 * @param {(settings: object) => object} ctx.proxyDescriptorFields
 */
import { t } from "../i18n.js";
import { WsConsole } from "../components/ws-console.js";

export function installWsHandlers(ctx) {
  window.addEventListener("wurl:ws-connect", async (e) => {
    const { url, headers, subprotocols } = e.detail ?? {};
    if (window.wurl?.isElectron !== true || !window.wurl.ws) {
      ctx.getWsConsole().applyStatus({
        state: "error",
        message: t("app.wsDesktopOnly"),
      });
      window.dispatchEvent(
        new CustomEvent("wurl:ws-state", { detail: { state: "error" } }),
      );
      return;
    }
    // Close any existing connection for this request (re-connect scenario).
    await ctx.closeWsConn(ctx.getSelectedNode()?.id);
    // Create a fresh console for this connection and swap it into the pane.
    const newConsole = new WsConsole();
    ctx.setResponsePane(true, newConsole);
    ctx.getWsConsole().reset();
    ctx.getWsConsole().applyStatus({ state: "connecting" });
    window.dispatchEvent(
      new CustomEvent("wurl:ws-state", { detail: { state: "connecting" } }),
    );
    const settings = ctx.getSettings();
    const desc = {
      url,
      headers,
      subprotocols,
      verifySsl: settings.verifySsl ?? true,
      timeout: settings.timeout ?? 30000,
      ...ctx.proxyDescriptorFields(settings),
    };
    try {
      const { id } = await window.wurl.ws.open(desc);
      const pendingTerminal = ctx.wsPendingTerminal.get(id);
      if (pendingTerminal) {
        // The socket failed/closed before we could register it (a status push
        // raced ahead of this response); surface that terminal status and skip
        // registering a live connection, so no orphaned pulsing dot is shown.
        ctx.wsPendingTerminal.delete(id);
        newConsole.applyStatus(pendingTerminal);
        window.dispatchEvent(
          new CustomEvent("wurl:ws-state", {
            detail: { state: pendingTerminal.state },
          }),
        );
        return;
      }
      ctx.wsConns.set(id, {
        id,
        requestId: ctx.getSelectedNode()?.id ?? null,
        state: "connecting",
        console: newConsole,
      });
      ctx.getTreeView()?.setWsLiveIds(ctx.getLiveRequestIds());
    } catch (err) {
      ctx.getWsConsole().applyStatus({
        state: "error",
        message: err?.message ?? "Failed to open socket.",
      });
      window.dispatchEvent(
        new CustomEvent("wurl:ws-state", { detail: { state: "error" } }),
      );
    }
  });

  window.addEventListener("wurl:ws-send", async (e) => {
    const entry = ctx.connForRequest(ctx.getSelectedNode()?.id);
    if (!entry || !window.wurl?.ws) return;
    const data = e.detail?.data ?? "";
    const res = await window.wurl.ws.send({ id: entry.id, data });
    if (res?.ok) {
      entry.console.addFrame({ direction: "sent", data, ts: Date.now() });
    } else {
      entry.console.applyStatus({
        state: "system",
        message: `Send failed: ${res?.reason ?? "unknown"}`,
      });
    }
  });

  window.addEventListener("wurl:ws-disconnect", async () => {
    const entry = ctx.connForRequest(ctx.getSelectedNode()?.id);
    if (!entry || !window.wurl?.ws) return;
    entry.state = "closing";
    entry.console.applyStatus({ state: "closing" });
    window.dispatchEvent(
      new CustomEvent("wurl:ws-state", { detail: { state: "closing" } }),
    );
    await window.wurl.ws.close({
      id: entry.id,
      code: 1000,
      reason: "client",
    });
    // The "closed" push removes the entry and updates the console + editor.
  });
}
