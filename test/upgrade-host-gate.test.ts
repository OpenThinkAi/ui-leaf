import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import { connect } from "node:net";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

// Minimal RFC 6455 upgrade request. Sec-WebSocket-Key value is the canonical
// example from the RFC; rsbuild won't accept this socket (no token query
// param) but we never get that far — the Host gate runs first.
function buildUpgradeRequest(host: string, path: string): string {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

// Send an upgrade request to 127.0.0.1:port and resolve with what happened
// before either `timeoutMs` elapses or the server closes the socket.
function probeUpgrade(
  port: number,
  host: string,
  path: string,
  timeoutMs: number,
): Promise<{ bytesReceived: number; closedByPeer: boolean }> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    let bytesReceived = 0;
    let closedByPeer = false;
    const settle = (): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve({ bytesReceived, closedByPeer });
    };
    sock.on("connect", () => sock.write(buildUpgradeRequest(host, path)));
    sock.on("data", (chunk) => {
      bytesReceived += chunk.length;
    });
    sock.on("close", () => {
      closedByPeer = true;
      settle();
    });
    sock.on("error", () => settle());
    setTimeout(settle, timeoutMs);
  });
}

describe("HMR upgrade Host gate", () => {
  test(
    "rejects WebSocket upgrade with non-loopback Host header",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        data: {},
      });

      try {
        // AC #2: attacker.example Host triggers our gate, which calls
        // socket.destroy() before rsbuild's HMR handler ever reads or
        // writes — so zero application bytes flow back.
        const result = await probeUpgrade(
          view.port,
          "attacker.example",
          "/rsbuild-hmr",
          500,
        );
        expect(result.closedByPeer).toBe(true);
        expect(result.bytesReceived).toBe(0);
      } finally {
        await view.close();
      }
    },
    60_000,
  );

  test(
    "allows WebSocket upgrade with loopback Host header",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        data: {},
      });

      try {
        // AC #3: with Host: 127.0.0.1, our gate must not destroy the
        // socket. We probe a path rsbuild's HMR layer doesn't claim
        // (`shouldHandle` returns false on path mismatch and rsbuild's
        // handler bails silently), so any close inside the probe window
        // would have to come from our gate. Holding the socket open for
        // the full 250 ms window proves the gate let it through.
        const result = await probeUpgrade(
          view.port,
          "127.0.0.1",
          "/not-rsbuild-hmr",
          250,
        );
        expect(result.closedByPeer).toBe(false);
      } finally {
        await view.close();
      }
    },
    60_000,
  );
});
