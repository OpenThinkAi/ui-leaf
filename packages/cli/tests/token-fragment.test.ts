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

  test(
    "bootstrap script persists token to sessionStorage and falls back on reload",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
      });
      expect(result.errors).toHaveLength(0);
      // The on-hash branch writes to sessionStorage under the documented key.
      expect(result.html).toContain("__ui_leaf_token__");
      expect(result.html).toContain("sessionStorage.setItem");
      // The no-hash branch reads from sessionStorage before deciding sessionEnded.
      expect(result.html).toContain("sessionStorage.getItem");
    },
    30_000,
  );
});

// ── Behavioral check: the bootstrap actually does what the comments claim ────
//
// We extract the inline bootstrap script from the compiled HTML and run it in
// a sandbox with stub `window`, `history`, and `sessionStorage` objects. This
// catches regressions that string-match tests can't (e.g. read/write order,
// branch wiring) without spinning up a real browser.

describe("bootstrap script behavior (sandboxed)", () => {
  type Stub = {
    window: { __UI_LEAF__: { token?: string; sessionEnded?: boolean }; location: { hash: string; pathname: string; search: string } };
    history: { replaceState: (s: unknown, t: string, url: string) => void };
    sessionStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
    replaceStateCalls: Array<{ url: string }>;
    storage: Map<string, string>;
  };

  function makeStub(opts: { hash: string; storedToken?: string; storageThrows?: boolean }): Stub {
    const storage = new Map<string, string>();
    if (opts.storedToken) storage.set("__ui_leaf_token__", opts.storedToken);
    const replaceStateCalls: Array<{ url: string }> = [];
    return {
      window: {
        __UI_LEAF__: {},
        location: { hash: opts.hash, pathname: "/", search: "" },
      },
      history: {
        replaceState: (_s, _t, url) => { replaceStateCalls.push({ url }); },
      },
      sessionStorage: {
        getItem: (k) => {
          if (opts.storageThrows) throw new Error("storage disabled");
          return storage.get(k) ?? null;
        },
        setItem: (k, v) => {
          if (opts.storageThrows) throw new Error("storage disabled");
          storage.set(k, v);
        },
      },
      replaceStateCalls,
      storage,
    };
  }

  // Pull just the IIFE the bootstrap injects (the part after `dataInit`).
  // We match the explicit `(function(){…})();` block — the only IIFE the
  // bootstrap emits — so changes upstream of it don't break this regex.
  function extractBootstrapIife(html: string): string {
    const m = html.match(/\(function\(\)\{var KEY[\s\S]*?\}\)\(\);/);
    if (!m) throw new Error("could not find bootstrap IIFE in compiled HTML");
    return m[0];
  }

  async function runBootstrap(stub: Stub): Promise<void> {
    const result = await compileView({
      entry: "trivial",
      viewsRoot: VIEWS_ROOT,
      data: {},
    });
    expect(result.errors).toHaveLength(0);
    const iife = extractBootstrapIife(result.html);
    // Build a Function whose globals are the stubs. The bootstrap reads
    // `window`, `history`, `sessionStorage` directly — feed each as a named
    // arg so the inner code resolves them via the function's lexical scope.
    const fn = new Function("window", "history", "sessionStorage", iife);
    fn(stub.window, stub.history, stub.sessionStorage);
  }

  test("first load with hash token: stores in sessionStorage, clears fragment, no sessionEnded", async () => {
    const stub = makeStub({ hash: "#token=abc123" });
    await runBootstrap(stub);
    expect(stub.window.__UI_LEAF__.token).toBe("abc123");
    expect(stub.window.__UI_LEAF__.sessionEnded).toBeUndefined();
    expect(stub.storage.get("__ui_leaf_token__")).toBe("abc123");
    expect(stub.replaceStateCalls).toHaveLength(1);
  }, 30_000);

  test("refresh: no hash, sessionStorage has token → mount proceeds with stored token", async () => {
    const stub = makeStub({ hash: "", storedToken: "previously-stored" });
    await runBootstrap(stub);
    expect(stub.window.__UI_LEAF__.token).toBe("previously-stored");
    expect(stub.window.__UI_LEAF__.sessionEnded).toBeUndefined();
    expect(stub.replaceStateCalls).toHaveLength(0);
  }, 30_000);

  test("cold load: no hash, no sessionStorage entry → sessionEnded", async () => {
    const stub = makeStub({ hash: "" });
    await runBootstrap(stub);
    expect(stub.window.__UI_LEAF__.token).toBeUndefined();
    expect(stub.window.__UI_LEAF__.sessionEnded).toBe(true);
  }, 30_000);

  test("malformed URL-encoded token in hash → sessionEnded (graceful)", async () => {
    const stub = makeStub({ hash: "#token=%E0%A4%A" });
    await runBootstrap(stub);
    expect(stub.window.__UI_LEAF__.sessionEnded).toBe(true);
  }, 30_000);

  test("private browsing (sessionStorage throws) on first load with hash token: still mounts", async () => {
    const stub = makeStub({ hash: "#token=xyz", storageThrows: true });
    await runBootstrap(stub);
    // The setItem failure must NOT abort the mount — token from hash is enough.
    expect(stub.window.__UI_LEAF__.token).toBe("xyz");
    expect(stub.window.__UI_LEAF__.sessionEnded).toBeUndefined();
    expect(stub.replaceStateCalls).toHaveLength(1);
  }, 30_000);

  test("private browsing (sessionStorage throws) on reload with no hash: sessionEnded", async () => {
    const stub = makeStub({ hash: "", storageThrows: true });
    await runBootstrap(stub);
    expect(stub.window.__UI_LEAF__.sessionEnded).toBe(true);
  }, 30_000);
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
