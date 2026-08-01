import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { startDevServer, type DevServer } from "../src/server.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

let server: DevServer | null = null;
let blocker: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  if (blocker) {
    await blocker.stop(true);
    blocker = null;
  }
});

describe("port auto-bump", () => {
  test(
    "a busy requested port bumps to the next free one",
    async () => {
      // Occupy an OS-assigned port, then ask ui-leaf for exactly that port.
      // Regression guard for the EADDRINUSE detection: Bun's error message
      // is a human string ("Failed to start server. Is port N in use?");
      // the code field is what identifies the condition. Before the fix
      // this threw instead of bumping.
      blocker = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("blocked"),
      });
      const busyPort = blocker.port;

      server = await startDevServer({
        _env: {},
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: busyPort,
        openBrowser: false,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
      });

      expect(server.port).toBeGreaterThan(busyPort);
      expect(server.port).toBeLessThanOrEqual(busyPort + 9);
    },
    30_000,
  );
});
