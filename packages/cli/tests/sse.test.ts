import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { startDevServer, type DevServer } from "../src/server.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

const SIMPLE_VIEW = `
export default function V({ data }: { data: unknown; mutate: unknown }) {
  return <div>{JSON.stringify(data)}</div>;
}
`.trim();

let servers: DevServer[] = [];

afterEach(async () => {
  for (const s of servers) {
    await s.close().catch(() => {});
  }
  servers = [];
});

function track(srv: DevServer): DevServer {
  servers.push(srv);
  return srv;
}

async function newServer(data: unknown = { v: 0 }): Promise<{ srv: DevServer; token: string }> {
  let openUrl = "";
  const srv = track(
    await startDevServer({
      view: "trivial",
      viewsRoot: VIEWS_ROOT,
      data,
      port: 0,
      openBrowser: true,
      heartbeatTimeoutMs: 75_000,
      startupGraceMs: 0,
      silent: true,
      _opener: async (u) => {
        openUrl = u;
      },
    }),
  );
  const m = /[#&]token=([^&#]*)/.exec(openUrl);
  const token = m ? decodeURIComponent(m[1]!) : "";
  return { srv, token };
}

// Read up to `limit` SSE events from an already-opened Response, or until `ms` elapses.
async function readEvents(
  res: Response,
  limit: number,
  ms = 4000,
): Promise<Array<Record<string, unknown>>> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  const out: Array<Record<string, unknown>> = [];

  let settled = false;
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      settled = true;
      resolve();
    }, ms),
  );

  async function pump(): Promise<void> {
    while (out.length < limit && !settled) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) {
            try {
              out.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>);
            } catch {
              /* skip malformed */
            }
          }
        }
      }
    }
  }

  await Promise.race([pump(), timeout]);
  reader.cancel().catch(() => {});
  return out;
}

// Read all SSE events until the stream closes (used for closing-event tests).
async function readUntilClose(res: Response): Promise<Array<Record<string, unknown>>> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  const out: Array<Record<string, unknown>> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            out.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>);
          } catch {
            /* skip malformed */
          }
        }
      }
    }
  }
  return out;
}

// ── Auth and headers ─────────────────────────────────────────────────────────

describe("GET /events — auth and headers", () => {
  test(
    "returns 401 without X-UI-Leaf-Token (AC#1)",
    async () => {
      const { srv } = await newServer();
      const res = await fetch(`${srv.url}/events`);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    },
    30_000,
  );

  test(
    "returns 403 for disallowed Host (AC#2)",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token, Host: "evil.example.com" },
      });
      expect(res.status).toBe(403);
      await res.body?.cancel();
    },
    30_000,
  );

  test(
    "returns 200 with text/event-stream and no-cache (AC#3)",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      await res.body?.cancel();
    },
    30_000,
  );
});

// ── Wire format ──────────────────────────────────────────────────────────────

describe("GET /events — wire format (AC#4)", () => {
  test(
    "data-updated event carries data payload on update()",
    async () => {
      const { srv, token } = await newServer({ v: 1 });
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      const eventsPromise = readEvents(res, 1);
      srv.update({ v: 42 });
      const events = await eventsPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "data-updated", data: { v: 42 } });
    },
    30_000,
  );

  test(
    "view-swapped event is broadcast on swapView()",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      const eventsPromise = readEvents(res, 1);
      await srv.swapView(SIMPLE_VIEW);
      const events = await eventsPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "view-swapped" });
    },
    30_000,
  );

  test(
    "patch() broadcasts data-updated then view-swapped",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      const eventsPromise = readEvents(res, 2);
      await srv.patch({ v: 99 }, SIMPLE_VIEW);
      const events = await eventsPromise;
      const types = events.map((e) => e.type);
      expect(types).toContain("data-updated");
      expect(types).toContain("view-swapped");
      const du = events.find((e) => e.type === "data-updated");
      expect(du).toMatchObject({ type: "data-updated", data: { v: 99 } });
    },
    30_000,
  );

  test(
    "closing event carries reason:caller on close('caller')",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      const eventsPromise = readEvents(res, 1);
      await srv.close("caller");
      servers = servers.filter((s) => s !== srv);
      const events = await eventsPromise;
      expect(events).toContainEqual({ type: "closing", reason: "caller" });
    },
    30_000,
  );

  test(
    "closing event carries reason:signal on close('signal')",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      const eventsPromise = readEvents(res, 1);
      await srv.close("signal");
      servers = servers.filter((s) => s !== srv);
      const events = await eventsPromise;
      expect(events).toContainEqual({ type: "closing", reason: "signal" });
    },
    30_000,
  );
});

// ── Security ─────────────────────────────────────────────────────────────────

describe("GET /events — security (AC#10)", () => {
  test(
    "SSE response body never contains the auth token",
    async () => {
      const { srv, token } = await newServer();
      const res = await fetch(`${srv.url}/events`, {
        headers: { "X-UI-Leaf-Token": token },
      });
      const eventsPromise = readEvents(res, 1);
      srv.update({ safe: true });
      const events = await eventsPromise;
      expect(JSON.stringify(events)).not.toContain(token);
    },
    30_000,
  );
});

// ── Cross-mount isolation ────────────────────────────────────────────────────

describe("GET /events — cross-mount isolation (AC#11)", () => {
  test(
    "update() on mount A does not emit to mount B stream",
    async () => {
      const { srv: srvA, token: tokenA } = await newServer({ mount: "A" });
      const { srv: srvB, token: tokenB } = await newServer({ mount: "B" });

      const resA = await fetch(`${srvA.url}/events`, {
        headers: { "X-UI-Leaf-Token": tokenA },
      });
      const resB = await fetch(`${srvB.url}/events`, {
        headers: { "X-UI-Leaf-Token": tokenB },
      });

      const eventsAPromise = readEvents(resA, 1);
      const eventsBPromise = readEvents(resB, 1, 500);

      srvA.update({ from: "A" });

      const eventsA = await eventsAPromise;
      const eventsB = await eventsBPromise;

      expect(eventsA).toHaveLength(1);
      expect(eventsA[0]).toMatchObject({ type: "data-updated", data: { from: "A" } });
      expect(eventsB).toHaveLength(0);
    },
    30_000,
  );
});
