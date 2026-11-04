import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { startDevServer, type DevServer } from "../src/server.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

// Inline TSX sources used across tests.
const SIMPLE_VIEW = `
export default function V({ data }: { data: unknown; mutate: unknown }) {
  return <div>{JSON.stringify(data)}</div>;
}
`.trim();

const BROKEN_VIEW = `this is not valid TSX {{{`;

let server: DevServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

async function startTestServer(opts?: {
  data?: unknown;
  openBrowser?: boolean;
}): Promise<DevServer> {
  server = await startDevServer({
    _env: {},
    view: "trivial",
    viewsRoot: VIEWS_ROOT,
    data: opts?.data ?? { initial: true },
    port: 0,
    openBrowser: opts?.openBrowser ?? false,
    heartbeatTimeoutMs: 75_000,
    startupGraceMs: 0,
    silent: true,
  });
  return server;
}

// Start a server whose tokened launch URL is captured via the opener seam,
// so tests can call the token-gated endpoints.
async function startTokenServer(data: unknown): Promise<{ srv: DevServer; token: string }> {
  let openedUrl = "";
  server = await startDevServer({
    _env: {},
    view: "trivial",
    viewsRoot: VIEWS_ROOT,
    data,
    port: 0,
    openBrowser: true,
    _opener: async (u: string) => { openedUrl = u; },
    heartbeatTimeoutMs: 75_000,
    startupGraceMs: 0,
    silent: true,
  });
  const token = /#token=([0-9a-f]+)/.exec(openedUrl)?.[1];
  if (!token) throw new Error(`no token in opened URL: ${openedUrl}`);
  return { srv: server, token };
}

async function apiData(srv: DevServer, token: string): Promise<unknown> {
  const res = await fetch(srv.url + "/api/data", { headers: { "X-UI-Leaf-Token": token } });
  expect(res.status).toBe(200);
  return res.json();
}

describe("served HTML never carries mount data (AGT-2350)", () => {
  test(
    "GET / has no data payload after mount, update() and patch(); /api/data is token-gated",
    async () => {
      const { srv, token } = await startTokenServer({ mountSecret: "m-111" });

      const atMount = await (await fetch(srv.url + "/")).text();
      expect(atMount).not.toContain("mountSecret");
      expect(atMount).not.toContain("m-111");
      expect(atMount).toContain("window.__UI_LEAF__ = {};");

      srv.update({ updateSecret: "u-222" });
      const afterUpdate = await (await fetch(srv.url + "/")).text();
      expect(afterUpdate).not.toContain("updateSecret");
      expect(afterUpdate).not.toContain("u-222");
      expect(afterUpdate).not.toContain("m-111");

      const errors = await srv.patch({ patchSecret: "p-333" }, SIMPLE_VIEW);
      expect(errors).toHaveLength(0);
      const afterPatch = await (await fetch(srv.url + "/")).text();
      expect(afterPatch).not.toContain("patchSecret");
      expect(afterPatch).not.toContain("p-333");
      expect(afterPatch).not.toContain("u-222");

      // The data is only reachable with the token.
      const noToken = await fetch(srv.url + "/api/data");
      expect(noToken.status).toBe(401);
      expect(await noToken.text()).not.toContain("p-333");
      expect(await apiData(srv, token)).toEqual({ patchSecret: "p-333" });
    },
    60_000,
  );
});

describe("update()", () => {
  test(
    "emits data-updated event on call",
    async () => {
      const srv = await startTestServer({ data: { v: 1 } });

      let fired = false;
      srv.on("data-updated", () => { fired = true; });

      srv.update({ v: 2 });

      expect(fired).toBe(true);
    },
    30_000,
  );

  test(
    "a later load gets fresh data from /api/data after update() (issue #72)",
    async () => {
      const { srv, token } = await startTokenServer({ a: 1 });

      expect(await apiData(srv, token)).toEqual({ a: 1 });
      srv.update({ a: 2 });
      // A new tab / reload / reopen() bootstraps from this endpoint.
      expect(await apiData(srv, token)).toEqual({ a: 2 });
    },
    30_000,
  );

  test(
    "reopen() after update() first-paints the updated data, not the mount-time snapshot",
    async () => {
      const { srv, token } = await startTokenServer({ staleSnapshot_q81: true });
      srv.update({ freshSnapshot_q82: true });
      await srv.reopen();
      const html = await (await fetch(srv.url + "/")).text();
      expect(html).not.toContain("staleSnapshot_q81");
      expect(html).not.toContain("freshSnapshot_q82");
      expect(await apiData(srv, token)).toEqual({ freshSnapshot_q82: true });
    },
    30_000,
  );

  test(
    "update() after swapView() serves the new data from /api/data",
    async () => {
      const { srv, token } = await startTokenServer({ first: 1 });

      const errors = await srv.swapView(SIMPLE_VIEW);
      expect(errors).toHaveLength(0);

      srv.update({ second: 2 });
      expect(await apiData(srv, token)).toEqual({ second: 2 });
    },
    30_000,
  );

  test(
    "dataLoader mode: update() never embeds data into the served HTML",
    async () => {
      server = await startDevServer({
        _env: {},
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        dataLoader: async () => ({ secretInitial: true }),
        port: 0,
        openBrowser: false,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
      });
      const srv = server;

      srv.update({ secretUpdated: true });
      const html = await (await fetch(srv.url + "/")).text();
      // dataLoader HTML bootstraps from GET /api/data; neither payload may
      // be written into the page.
      expect(html).not.toContain("secretInitial");
      expect(html).not.toContain("secretUpdated");
    },
    30_000,
  );
});

describe("swapView()", () => {
  test(
    "on success: replaces HTML and emits view-swapped",
    async () => {
      const srv = await startTestServer();

      let swapped = false;
      srv.on("view-swapped", () => { swapped = true; });

      const errors = await srv.swapView(SIMPLE_VIEW);
      expect(errors).toHaveLength(0);
      expect(swapped).toBe(true);

      const html = await (await fetch(srv.url + "/")).text();
      expect(html).toContain("<!doctype html>");
    },
    30_000,
  );

  test(
    "on compile failure: preserves previous HTML, no view-swapped event, returns errors",
    async () => {
      const srv = await startTestServer({ data: { sentinel: "keep-me" } });

      const before = await (await fetch(srv.url + "/")).text();

      let swapped = false;
      srv.on("view-swapped", () => { swapped = true; });

      const errors = await srv.swapView(BROKEN_VIEW);
      expect(errors.length).toBeGreaterThan(0);
      expect(swapped).toBe(false);

      // Previous HTML still served.
      const after = await (await fetch(srv.url + "/")).text();
      expect(after).toBe(before);
    },
    30_000,
  );
});

describe("patch()", () => {
  test(
    "on success: atomically replaces both data and HTML, emits data-updated then view-swapped",
    async () => {
      const srv = await startTestServer({ data: { orig: true } });

      const events: string[] = [];
      srv.on("data-updated", () => events.push("data-updated"));
      srv.on("view-swapped", () => events.push("view-swapped"));

      const errors = await srv.patch({ patched: true }, SIMPLE_VIEW);
      expect(errors).toHaveLength(0);

      expect(events).toContain("data-updated");
      expect(events).toContain("view-swapped");

      const html = await (await fetch(srv.url + "/")).text();
      expect(html).toContain("<!doctype html>");
      expect(html).not.toContain('"patched"');
    },
    30_000,
  );

  test(
    "on compile failure: neither data nor HTML changes (atomicity guarantee)",
    async () => {
      const srv = await startTestServer({ data: { safe: true } });

      const beforeHtml = await (await fetch(srv.url + "/")).text();

      let dataUpdated = false;
      let viewSwapped = false;
      srv.on("data-updated", () => { dataUpdated = true; });
      srv.on("view-swapped", () => { viewSwapped = true; });

      const errors = await srv.patch({ poisoned: true }, BROKEN_VIEW);
      expect(errors.length).toBeGreaterThan(0);

      // No events fired.
      expect(dataUpdated).toBe(false);
      expect(viewSwapped).toBe(false);

      // Previous HTML still served (data not mutated either) — exact equality.
      const afterHtml = await (await fetch(srv.url + "/")).text();
      expect(afterHtml).toBe(beforeHtml);
    },
    30_000,
  );
});

describe("reopen()", () => {
  test(
    "calls the injected opener exactly once on reopen()",
    async () => {
      let openCount = 0;
      let lastUrl = "";
      const fakeOpener = async (u: string): Promise<void> => {
        openCount++;
        lastUrl = u;
      };

      server = await startDevServer({
        _env: {},
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: false,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: fakeOpener,
      });
      const srv = server;

      await srv.reopen();

      expect(openCount).toBe(1);
      expect(lastUrl).toContain("127.0.0.1");
    },
    30_000,
  );
});

describe("event broker", () => {
  test("off() removes a listener so it no longer fires", async () => {
    const srv = await startTestServer();

    let count = 0;
    const listener = (): void => { count++; };
    srv.on("data-updated", listener);
    srv.update({ x: 1 });
    expect(count).toBe(1);

    srv.off("data-updated", listener);
    srv.update({ x: 2 });
    expect(count).toBe(1); // still 1 — listener was removed
  });

  test("multiple listeners on the same event all fire", async () => {
    const srv = await startTestServer();

    const calls: number[] = [];
    srv.on("data-updated", () => calls.push(1));
    srv.on("data-updated", () => calls.push(2));
    srv.update({});
    expect(calls).toContain(1);
    expect(calls).toContain(2);
  });
});

describe("mutation responses still work after adding new handlers", () => {
  test(
    "POST /mutate without auth token returns 401",
    async () => {
      server = await startDevServer({
        _env: {},
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: false,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        mutations: {
          double: (args: { n: number }) => ({ result: args.n * 2 }),
        },
      });
      const srv = server;

      const res = await fetch(`${srv.url}/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "double", args: { n: 5 } }),
      });
      expect(res.status).toBe(401);
    },
    30_000,
  );
});

describe("strict CSP preset", () => {
  test(
    "style-src includes 'https:' to permit external stylesheet links (Google Fonts CSS, etc.)",
    async () => {
      server = await startDevServer({
        _env: {},
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: false,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        csp: "strict",
      });

      const res = await fetch(server.url + "/");
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp).not.toBeNull();
      // Must have https: alongside the inline-style allowance — without it,
      // external <link rel="stylesheet"> requests are blocked even though
      // font-src and img-src already permit https:. The asymmetry was
      // unintentional (see ui-leaf#36).
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https:");
    },
    30_000,
  );
});
