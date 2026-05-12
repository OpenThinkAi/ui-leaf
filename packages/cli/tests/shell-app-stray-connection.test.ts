import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { startDevServer, type DevServer } from "../src/server.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

let server: DevServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe('shell:"app" survives unauthenticated traffic (ui-leaf#54)', () => {
  test(
    "stray unauthenticated requests to every public route do not terminate the mount",
    async () => {
      const noopOpener = async (_: string): Promise<void> => {
        // Bypass the real Chromium --app launch; the regression we're
        // guarding is that the running server survives unauth traffic,
        // not that the launcher itself behaves.
      };

      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: { v: 1 },
        port: 0,
        openBrowser: true,
        shell: "app",
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: noopOpener,
      });
      const srv = server;

      // Race view.closed against a sentinel so we can observe whether the
      // mount terminated during the unauth burst without hanging the test.
      const closedSignal: Promise<"closed"> = srv.closed.then(() => "closed");
      const aliveSentinel = (ms: number): Promise<"alive"> =>
        new Promise((r) => setTimeout(() => r("alive"), ms));

      const unauthPaths: Array<{ method: "GET" | "POST"; path: string }> = [
        { method: "GET", path: "/" },
        { method: "GET", path: "/events" },
        { method: "GET", path: "/api/data" },
        { method: "POST", path: "/heartbeat" },
        { method: "POST", path: "/mutate" },
      ];

      for (const { method, path } of unauthPaths) {
        const res = await fetch(`${srv.url}${path}`, {
          method,
          ...(method === "POST"
            ? { headers: { "Content-Type": "application/json" }, body: "{}" }
            : {}),
        });
        // Drain to avoid leaving an open HTTP connection (especially /events).
        await res.body?.cancel().catch(() => { /* already cancelled */ });
        // Bare GET / is intentionally public — the React entry's session-end
        // branch handles the no-token case client-side, so the server
        // returns 200 with the bootstrap HTML. Every other route requires
        // the token and returns 401 (mutate/heartbeat/events/api-data).
        // Either way is non-terminating; the alive-sentinel race below is
        // what guards AC #1. Tag the status into the failure message so
        // future regressions surface which route changed shape.
        expect(`${method} ${path} → ${res.status}`).toMatch(
          /(GET \/ → 200|→ 401|→ 404)/,
        );
      }

      const winner = await Promise.race([closedSignal, aliveSentinel(250)]);
      expect(winner).toBe("alive");
    },
    30_000,
  );

  test(
    "explicit close() still terminates the mount after surviving unauth traffic",
    async () => {
      const noopOpener = async (_: string): Promise<void> => { };

      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        shell: "app",
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: noopOpener,
      });
      const srv = server;

      // Hit one unauth route to mirror the bug repro.
      const res = await fetch(`${srv.url}/heartbeat`, { method: "POST" });
      await res.body?.cancel().catch(() => { });
      expect(res.status).toBe(401);

      await srv.close();
      const reason = await srv.closed;
      expect(reason).toBe("caller");
      server = null; // already closed; prevent afterEach double-close
    },
    30_000,
  );
});
