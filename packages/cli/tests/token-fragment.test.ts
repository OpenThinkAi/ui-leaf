import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { startDevServer, type DevServer } from "../src/server.ts";
import { compileView } from "../src/compile.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

let server: DevServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

async function startTestServer(opts?: {
  data?: unknown;
  mutations?: Record<string, (args: unknown) => unknown>;
}): Promise<DevServer> {
  server = await startDevServer({
    view: "trivial",
    viewsRoot: VIEWS_ROOT,
    data: opts?.data ?? {},
    mutations: opts?.mutations,
    port: 0,
    openBrowser: false,
    heartbeatTimeoutMs: 75_000,
    startupGraceMs: 0,
    silent: true,
  });
  return server;
}

// Helper to extract the token from the URL passed to the fake opener.
// The opener receives `http://127.0.0.1:<port>/#token=<hex>`.
function extractToken(openUrl: string): string | null {
  const m = /[#&]token=([^&#]*)/.exec(openUrl);
  return m ? decodeURIComponent(m[1]!) : null;
}

// ── AC#1 / AC#2 — token in fragment, not in body ────────────────────────────

describe("token delivery via URL fragment", () => {
  test(
    "opener receives a fragment URL containing the token",
    async () => {
      let capturedUrl = "";
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async (u) => { capturedUrl = u; },
      });

      expect(capturedUrl).toMatch(/#token=[0-9a-f]{64}$/);
    },
    30_000,
  );

  test(
    "public server.url is fragment-free",
    async () => {
      let capturedUrl = "";
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async (u) => { capturedUrl = u; },
      });

      // The public url has no fragment; only the opener's url does.
      expect(server!.url).not.toContain("#");
      expect(capturedUrl).toContain("#token=");
    },
    30_000,
  );

  test(
    "GET / body contains no token (AC#2)",
    async () => {
      let capturedUrl = "";
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async (u) => { capturedUrl = u; },
      });

      const token = extractToken(capturedUrl);
      expect(token).not.toBeNull();

      const body = await fetch(server!.url + "/").then((r) => r.text());
      // The token must not appear anywhere in the served HTML.
      expect(body).not.toContain(token!);
    },
    30_000,
  );
});

// ── AC#3 — bootstrap script is present and has the right shape ──────────────

describe("bootstrap script in HTML", () => {
  test(
    "HTML contains the ui-leaf bootstrap comment",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
      });
      expect(result.errors).toHaveLength(0);
      expect(result.html).toContain("<!-- ui-leaf bootstrap -->");
    },
    30_000,
  );

  test(
    "bootstrap script reads location.hash and calls history.replaceState",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
      });
      expect(result.errors).toHaveLength(0);
      expect(result.html).toContain("location.hash");
      expect(result.html).toContain("history.replaceState");
    },
    30_000,
  );

  test(
    "bootstrap script sets sessionEnded when token is absent",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
      });
      expect(result.errors).toHaveLength(0);
      expect(result.html).toContain("sessionEnded");
    },
    30_000,
  );

  test(
    "bundled module uses X-UI-Leaf-Token header (not Authorization)",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
      });
      expect(result.errors).toHaveLength(0);
      expect(result.html).toContain("X-UI-Leaf-Token");
      expect(result.html).not.toContain("Authorization");
      expect(result.html).not.toContain("Bearer");
    },
    30_000,
  );
});

// ── AC#5 / AC#6 — fetch paths include X-UI-Leaf-Token; server enforces it ───

describe("server auth enforcement (AC#6)", () => {
  test(
    "POST /mutate without X-UI-Leaf-Token returns 401 with empty body",
    async () => {
      const srv = await startTestServer({
        mutations: { noop: () => null },
      });

      const res = await fetch(`${srv.url}/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "noop" }),
      });

      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).toBe("");
    },
    30_000,
  );

  test(
    "POST /heartbeat without X-UI-Leaf-Token returns 401 with empty body",
    async () => {
      const srv = await startTestServer();

      const res = await fetch(`${srv.url}/heartbeat`, { method: "POST" });

      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).toBe("");
    },
    30_000,
  );

  test(
    "POST /mutate with wrong token returns 401",
    async () => {
      const srv = await startTestServer({
        mutations: { noop: () => null },
      });

      const res = await fetch(`${srv.url}/mutate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-UI-Leaf-Token": "a".repeat(64),
        },
        body: JSON.stringify({ name: "noop" }),
      });

      expect(res.status).toBe(401);
    },
    30_000,
  );

  test(
    "POST /mutate with correct X-UI-Leaf-Token returns 200",
    async () => {
      let capturedUrl = "";
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        mutations: { echo: (args) => args },
        _opener: async (u) => { capturedUrl = u; },
      });

      const token = extractToken(capturedUrl);
      expect(token).not.toBeNull();

      const res = await fetch(`${server!.url}/mutate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-UI-Leaf-Token": token!,
        },
        body: JSON.stringify({ name: "echo", args: { x: 1 } }),
      });

      expect(res.status).toBe(200);
    },
    30_000,
  );

  test(
    "POST /heartbeat with correct X-UI-Leaf-Token returns 204",
    async () => {
      let capturedUrl = "";
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async (u) => { capturedUrl = u; },
      });

      const token = extractToken(capturedUrl);
      expect(token).not.toBeNull();

      const res = await fetch(`${server!.url}/heartbeat`, {
        method: "POST",
        headers: { "X-UI-Leaf-Token": token! },
      });

      expect(res.status).toBe(204);
    },
    30_000,
  );

  test(
    "GET / does not require the token (AC#7)",
    async () => {
      const srv = await startTestServer();

      const res = await fetch(srv.url + "/");
      expect(res.status).toBe(200);
    },
    30_000,
  );
});

// ── AC#8 — reload-loses-token renders friendly message ──────────────────────

describe("session-ended / reload UX (AC#8)", () => {
  test(
    "compiled HTML contains the friendly session-ended message for the reload case",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
      });
      expect(result.errors).toHaveLength(0);
      // The message is inside the bundled JS (sessionEnded branch in the module).
      expect(result.html).toContain("Session ended");
      expect(result.html).toContain("re-launch the CLI");
    },
    30_000,
  );
});
