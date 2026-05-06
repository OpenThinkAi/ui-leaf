import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import { connect } from "node:net";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

// Minimal RFC 6455 upgrade request. Sec-WebSocket-Key value is the canonical
// example from the RFC.
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

// Send an upgrade request to 127.0.0.1:port and resolve with the raw HTTP
// response text received before either `timeoutMs` elapses or the server
// closes the socket.
function probeUpgrade(
  port: number,
  host: string,
  path: string,
  timeoutMs: number,
): Promise<{ responseText: string; closedByPeer: boolean }> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    let responseText = "";
    let closedByPeer = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve({ responseText, closedByPeer });
    };
    sock.on("connect", () => sock.write(buildUpgradeRequest(host, path)));
    sock.on("data", (chunk) => {
      responseText += (chunk as Buffer).toString("utf8");
    });
    sock.on("close", () => {
      closedByPeer = true;
      settle();
    });
    sock.on("error", () => settle());
    setTimeout(settle, timeoutMs);
  });
}

describe("upgrade Host gate", () => {
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
        // ui-leaf's DNS-rebinding gate intercepts the upgrade request before
        // any routing and returns 403 when Host is not in the allowed set.
        const result = await probeUpgrade(
          view.port,
          "attacker.example",
          "/any-path",
          500,
        );
        expect(result.responseText).toContain("HTTP/1.1 403");
      } finally {
        await view.close();
      }
    },
    60_000,
  );

  test(
    "does not reject WebSocket upgrade with loopback Host header",
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
        // With Host: 127.0.0.1, our gate must not fire. The response from
        // Bun.serve (no WebSocket handler configured) will be some non-403
        // status — proving the gate let the request through.
        const result = await probeUpgrade(
          view.port,
          "127.0.0.1",
          "/any-path",
          500,
        );
        expect(result.responseText).not.toContain("HTTP/1.1 403");
        expect(result.responseText.length).toBeGreaterThan(0);
      } finally {
        await view.close();
      }
    },
    60_000,
  );
});
