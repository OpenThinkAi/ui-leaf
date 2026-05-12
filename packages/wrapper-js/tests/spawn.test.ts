import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { spawnUiLeaf } from "../src/spawn.ts";
import type { OutboundMessage, SpawnConfig } from "../src/protocol.ts";

const MOCK_BINARY_TS = path.resolve(
  import.meta.dir,
  "fixtures",
  "mock-binary.ts",
);

// Build (once) a shim that invokes `bun <mock-binary>` and forwards stdio.
// spawnUiLeaf passes "mount" as argv[1]; the shim ignores extra args.
// On Windows, a .cmd file is used — Bun 1.1+ spawns .cmd files natively.
let shimPath: string | null = null;
function getMockBinaryShim(): string {
  if (shimPath) return shimPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-leaf-mock-"));
  if (process.platform === "win32") {
    const shim = path.join(dir, "ui-leaf.cmd");
    fs.writeFileSync(shim, `@echo off\nbun ${JSON.stringify(MOCK_BINARY_TS)} %*\r\n`);
    shimPath = shim;
  } else {
    const shim = path.join(dir, "ui-leaf");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nexec bun ${JSON.stringify(MOCK_BINARY_TS)} "$@"\n`,
      { mode: 0o755 },
    );
    shimPath = shim;
  }
  return shimPath;
}

function spawnMockViaBun(opts: {
  script?: unknown[];
  silent?: boolean;
  mutations?: string[];
}): ReturnType<typeof spawnUiLeaf> {
  const config: SpawnConfig = {
    view: "test-view",
    viewsRoot: "/tmp/views",
    binaryPath: getMockBinaryShim(),
    ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
    ...(opts.mutations !== undefined ? { mutations: opts.mutations } : {}),
  };
  // Inject the canned-script into the config; the mock looks for it on its
  // first stdin line as a non-standard `__mockScript` field.
  return spawnUiLeaf({
    ...config,
    // biome-ignore lint/suspicious/noExplicitAny: out-of-band test shim
    ...({ __mockScript: opts.script ?? [] } as any),
  });
}

// ---------------------------------------------------------------------------
// AC #3: ready resolves with { url, port, id }
// ---------------------------------------------------------------------------
describe("ready", () => {
  test("resolves when the binary emits a ready event", async () => {
    const handle = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: {
            version: "1",
            type: "ready",
            url: "http://127.0.0.1:9001/#token=abc",
            port: 9001,
          },
        },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
        { kind: "exit", code: 0 },
      ],
    });
    const ready = await handle.ready;
    expect(ready.url).toBe("http://127.0.0.1:9001/#token=abc");
    expect(ready.port).toBe(9001);
    expect(typeof ready.id).toBe("string");
    expect(ready.id.length).toBeGreaterThan(0);

    handle.send({ version: "1", type: "close" });
    const exit = await handle.exited;
    expect(exit.code).toBe(0);
  });

  test("ready ids are unique across spawns", async () => {
    const a = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        { kind: "exit", code: 0 },
      ],
    });
    const b = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 2 },
        },
        { kind: "exit", code: 0 },
      ],
    });
    const [ra, rb] = await Promise.all([a.ready, b.ready]);
    expect(ra.id).not.toBe(rb.id);
    await Promise.all([a.exited, b.exited]);
  });
});

// ---------------------------------------------------------------------------
// AC #4: mutation dispatch (success / error / no-handler)
// ---------------------------------------------------------------------------
describe("mutation dispatch", () => {
  test("success path: handler resolves → wrapper writes result", async () => {
    const handle = spawnMockViaBun({
      mutations: ["double"],
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        {
          kind: "emit",
          msg: { version: "1", type: "mutate", id: 7, name: "double", args: 21 },
        },
        { kind: "wait-for", type: "result", timeoutMs: 5000 },
        { kind: "exit", code: 0 },
      ],
    });
    handle.onMutate(async (id, name, args) => {
      expect(id).toBe(7);
      expect(name).toBe("double");
      return (args as number) * 2;
    });
    const events: OutboundMessage[] = [];
    handle.onEvent((e) => events.push(e));
    await handle.exited;
    // The mock echoes inbound traffic as `__mockRecv`; verifying via .exited
    // resolving (mock waits for type:"result" then exits) is sufficient.
  });

  test("error path: handler rejects → wrapper writes error", async () => {
    const handle = spawnMockViaBun({
      mutations: ["boom"],
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        {
          kind: "emit",
          msg: { version: "1", type: "mutate", id: 1, name: "boom", args: null },
        },
        { kind: "wait-for", type: "error", timeoutMs: 5000 },
        { kind: "exit", code: 0 },
      ],
    });
    handle.onMutate(async () => {
      throw new Error("kaboom");
    });
    await handle.exited; // mock advances on receiving "error" → exit 0
  });

  test("no-handler path: writes back error 'no handler for <name>'", async () => {
    const handle = spawnMockViaBun({
      mutations: ["wat"],
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        {
          kind: "emit",
          msg: { version: "1", type: "mutate", id: 99, name: "wat", args: {} },
        },
        { kind: "wait-for", type: "error", timeoutMs: 5000 },
        { kind: "exit", code: 0 },
      ],
    });
    // Intentionally do not call onMutate.
    await handle.exited;
  });
});

// ---------------------------------------------------------------------------
// AC #3 (.send) + the full set of inbound types reach the binary
// ---------------------------------------------------------------------------
describe(".send delivers update / view / patch / reopen / close", () => {
  test("each inbound type round-trips through stdin", async () => {
    const handle = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        { kind: "wait-for", type: "update", timeoutMs: 5000 },
        { kind: "wait-for", type: "view", timeoutMs: 5000 },
        { kind: "wait-for", type: "patch", timeoutMs: 5000 },
        { kind: "wait-for", type: "reopen", timeoutMs: 5000 },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "exit", code: 0 },
      ],
    });
    await handle.ready;
    handle.send({ version: "1", type: "update", data: { x: 1 } });
    handle.send({ version: "1", type: "view", source: "<jsx>" });
    handle.send({
      version: "1",
      type: "patch",
      data: 42,
      view: { source: "<jsx2>" },
    });
    handle.send({ version: "1", type: "reopen" });
    handle.send({ version: "1", type: "close" });
    const exit = await handle.exited;
    expect(exit.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC #5 line buffering — exercised end-to-end via splitAfter in the fixture.
// ---------------------------------------------------------------------------
describe("line buffering", () => {
  test("a ready message split across two stdout writes is reassembled", async () => {
    const handle = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: {
            version: "1",
            type: "ready",
            url: "http://split-test.local/",
            port: 4242,
          },
          splitAfter: 12, // pause partway through the JSON
        },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "exit", code: 0 },
      ],
    });
    const ready = await handle.ready;
    expect(ready.url).toBe("http://split-test.local/");
    expect(ready.port).toBe(4242);
    handle.send({ version: "1", type: "close" });
    await handle.exited;
  });
});

// ---------------------------------------------------------------------------
// AC #7: unknown event types do not throw; surfaced via onEvent
// ---------------------------------------------------------------------------
describe("forward-compat", () => {
  test("unknown event types reach onEvent without crashing", async () => {
    const handle = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        {
          kind: "emit",
          msg: { version: "1", type: "future-event", payload: "?" },
        },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "exit", code: 0 },
      ],
    });
    const seen: OutboundMessage[] = [];
    handle.onEvent((e) => seen.push(e));
    await handle.ready;
    // Give the second event time to arrive.
    await new Promise((r) => setTimeout(r, 50));
    handle.send({ version: "1", type: "close" });
    await handle.exited;
    const types = seen.map((e) => e.type);
    expect(types).toContain("ready");
    expect(types).toContain("future-event");
  });
});

// ---------------------------------------------------------------------------
// AC #2/#3: malformed stdout — non-JSON line surfaces as error event, no crash
// ---------------------------------------------------------------------------
describe("malformed stdout handling", () => {
  test("non-JSON line from binary surfaces as synthetic error event and does not crash", async () => {
    const errors: OutboundMessage[] = [];
    const handle = spawnMockViaBun({
      script: [
        { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
        { kind: "raw", text: "this is not valid json at all" },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
        { kind: "exit", code: 0 },
      ],
    });
    handle.onEvent((e) => {
      if (e.type === "error") errors.push(e);
    });
    await handle.ready;
    // Give the raw line time to arrive.
    await new Promise((r) => setTimeout(r, 50));
    handle.send({ version: "1", type: "close" });
    await handle.exited;
    expect(errors.length).toBeGreaterThan(0);
    const e0 = errors[0]!;
    expect(e0.type).toBe("error");
    // OutboundError is the only member of OutboundMessage with `message`.
    expect((e0 as { type: "error"; message: string }).message).toContain("malformed JSON");
  });
});

// ---------------------------------------------------------------------------
// AC #3: kill behaviour — SIGTERM exits cleanly; .exited resolves
// ---------------------------------------------------------------------------
describe("kill", () => {
  test("kill() sends SIGTERM and .exited resolves with reason 'signal'", async () => {
    const handle = spawnMockViaBun({
      script: [
        {
          kind: "emit",
          msg: { version: "1", type: "ready", url: "u", port: 1 },
        },
        // Sit idle until SIGTERM arrives. The mock's SIGTERM handler emits
        // closed:signal and exits 0 — on POSIX. On Windows there are no
        // signals; child.kill() invokes the uncatchable TerminateProcess,
        // so the mock never gets to run its handler.
        { kind: "wait-for", type: "__never__", timeoutMs: 8000 },
      ],
    });
    await handle.ready;
    handle.kill();
    const exit = await handle.exited;
    if (process.platform === "win32") {
      // Windows: no POSIX signals. The mock can't catch SIGTERM, so it's
      // force-terminated with no closed event and Node reports code=null.
      // The wrapper falls back to the killRequested → "killed" path.
      expect(exit.code).toBeNull();
      expect(exit.reason).toBe("killed");
    } else {
      expect(exit.code).toBe(0);
      // The mock emits closed:signal; observedCloseReason wins over killRequested.
      expect(["signal", "killed"]).toContain(exit.reason);
    }
  });
});
