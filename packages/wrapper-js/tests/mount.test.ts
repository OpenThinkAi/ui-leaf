// Integration tests for mount() — AGT-135.
//
// All tests use the mock-binary fixture (real child-process, full protocol)
// rather than the actual compiled binary. The "real-binary" smoke test is
// scoped to AGT-140 (rc.1 cross-platform verification), per the approved
// plan-review comment on the ticket.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { mount } from "../src/index.ts";
import type { MountOptions } from "../src/index.ts";

const MOCK_BINARY_TS = path.resolve(
  import.meta.dir,
  "fixtures",
  "mock-binary.ts",
);

// Build (once) a shim that invokes `bun <mock-binary>` and forwards stdio.
// Identical pattern to spawn.test.ts. On Windows, a .cmd file is used.
let shimPath: string | null = null;
function getMockBinaryShim(): string {
  if (shimPath) return shimPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-leaf-mount-mock-"));
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

type MockStep =
  | { kind: "emit"; msg: Record<string, unknown>; splitAfter?: number; delayMs?: number }
  | { kind: "exit"; code: number; delayMs?: number }
  | { kind: "wait-for"; type: string; timeoutMs?: number }
  | { kind: "stderr"; text: string };

function mountMock(
  script: MockStep[],
  extra?: Partial<MountOptions>,
): ReturnType<typeof mount> {
  return mount({
    view: "test-view",
    viewsRoot: "/tmp/views",
    binaryPath: getMockBinaryShim(),
    silent: true,
    ...extra,
    // biome-ignore lint/suspicious/noExplicitAny: out-of-band test shim
    ...({ __mockScript: script } as any),
  });
}

// Convenience: a script that emits ready, then waits for close, then exits.
function readyThenClose(extra: MockStep[] = []): MockStep[] {
  return [
    { kind: "emit", msg: { version: "1", type: "ready", url: "http://127.0.0.1:9001/#token=abc", port: 9001 } },
    ...extra,
    { kind: "wait-for", type: "close", timeoutMs: 5000 },
    { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
    { kind: "exit", code: 0 },
  ];
}

// ---------------------------------------------------------------------------
// AC #1/#2/#3: mount() resolves with a View carrying url, id, port
// ---------------------------------------------------------------------------

describe("mount() basic shape", () => {
  test("resolves with url, id, port from the ready event", async () => {
    const view = await mountMock(readyThenClose());
    expect(view.url).toBe("http://127.0.0.1:9001/#token=abc");
    expect(view.port).toBe(9001);
    expect(typeof view.id).toBe("string");
    expect(view.id.length).toBeGreaterThan(0);
    await view.close();
  });

  test("each mount() call produces a unique id", async () => {
    const [va, vb] = await Promise.all([
      mountMock(readyThenClose()),
      mountMock(readyThenClose()),
    ]);
    expect(va.id).not.toBe(vb.id);
    await Promise.all([va.close(), vb.close()]);
  });
});

// ---------------------------------------------------------------------------
// AC #3 (spawn integration) + AC #2 (mutations field): mutation round-trip
// ---------------------------------------------------------------------------

describe("mutation round-trip", () => {
  test("registered mutation is dispatched and result is returned", async () => {
    let capturedArgs: unknown = null;
    const view = await mountMock(
      [
        { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
        { kind: "emit", msg: { version: "1", type: "mutate", id: 7, name: "double", args: 21 } },
        { kind: "wait-for", type: "result", timeoutMs: 5000 },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
        { kind: "exit", code: 0 },
      ],
      {
        mutations: {
          double: async (args) => {
            capturedArgs = args;
            return (args as number) * 2;
          },
        },
      },
    );
    await view.close();
    expect(capturedArgs).toBe(21);
  });

  test("mutation handler rejection surfaces as error back to binary", async () => {
    const view = await mountMock(
      [
        { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
        { kind: "emit", msg: { version: "1", type: "mutate", id: 1, name: "boom", args: null } },
        { kind: "wait-for", type: "error", timeoutMs: 5000 },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
        { kind: "exit", code: 0 },
      ],
      {
        mutations: {
          boom: async () => { throw new Error("kaboom"); },
        },
      },
    );
    await view.close();
  });
});

// ---------------------------------------------------------------------------
// AC #4: update() fire-and-forget
// ---------------------------------------------------------------------------

describe("update()", () => {
  test("sends update message and resolves immediately", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "update", timeoutMs: 5000 },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await view.update({ data: { count: 42 } });
    await view.close();
  });
});

// ---------------------------------------------------------------------------
// AC #4: setView() — success and build error
// ---------------------------------------------------------------------------

describe("setView()", () => {
  test("resolves on view-swapped", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "view", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "view-swapped" } },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await view.setView("<div>new view</div>");
    await view.close();
  });

  test("rejects on build error with phase:build", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "view", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "error", phase: "build", message: "TSX compile failed" } },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await expect(view.setView("<bad tsx>")).rejects.toThrow("TSX compile failed");
    await view.close();
  });

  test("serialised: second setView waits for first view-swapped", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "view", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "view-swapped" } },
      { kind: "wait-for", type: "view", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "view-swapped" } },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    // Both should resolve cleanly in order.
    await Promise.all([
      view.setView("<div>first</div>"),
      view.setView("<div>second</div>"),
    ]);
    await view.close();
  });

  test("setSource() is the canonical alias and sends the same {type:view} wire message", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "view", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "view-swapped" } },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await view.setSource("<div>via setSource</div>");
    await view.close();
  });
});

// ---------------------------------------------------------------------------
// AC #4: patch() — four combinations
// ---------------------------------------------------------------------------

describe("patch()", () => {
  test("patch({ data, view }) sends patch and awaits view-swapped", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "patch", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "view-swapped" } },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await view.patch({ data: { x: 1 }, source: "<div/>" });
    await view.close();
  });

  test("patch({ data }) sends update (fire-and-forget)", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "update", timeoutMs: 5000 },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await view.patch({ data: { x: 2 } });
    await view.close();
  });

  test("patch({ source }) sends view and awaits view-swapped", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "view", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "view-swapped" } },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    await view.patch({ source: "<div>view only</div>" });
    await view.close();
  });

  test("patch({}) resolves immediately without sending any message", async () => {
    const view = await mountMock(readyThenClose());
    // Should resolve without the mock receiving any extra message.
    await view.patch({});
    await view.close();
  });
});

// ---------------------------------------------------------------------------
// AC #4: reopen()
// ---------------------------------------------------------------------------

describe("reopen()", () => {
  test("sends reopen message", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "wait-for", type: "reopen", timeoutMs: 5000 },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    view.reopen();
    await view.close();
  });
});

// ---------------------------------------------------------------------------
// AC #4: event subscriptions — onDisconnect / onReconnect / onError
// ---------------------------------------------------------------------------

describe("event subscriptions", () => {
  test("onDisconnect fires on disconnected event", async () => {
    // delayMs: 50 ensures the event arrives after mount() resolves and the
    // test has had a chance to register the handler.
    const view = await mountMock(readyThenClose([
      { kind: "emit", msg: { version: "1", type: "disconnected" }, delayMs: 50 },
    ]));
    let fired = false;
    view.onDisconnect(() => { fired = true; });
    await new Promise((r) => setTimeout(r, 200));
    await view.close();
    expect(fired).toBe(true);
  });

  test("onReconnect fires on reconnected event", async () => {
    const view = await mountMock(readyThenClose([
      { kind: "emit", msg: { version: "1", type: "reconnected" }, delayMs: 50 },
    ]));
    let fired = false;
    view.onReconnect(() => { fired = true; });
    await new Promise((r) => setTimeout(r, 200));
    await view.close();
    expect(fired).toBe(true);
  });

  test("onError fires on non-build error events", async () => {
    const errs: { phase?: string; message: string }[] = [];
    const view = await mountMock(readyThenClose([
      { kind: "emit", msg: { version: "1", type: "error", message: "runtime oops" }, delayMs: 50 },
    ]));
    view.onError((e) => errs.push(e));
    await new Promise((r) => setTimeout(r, 200));
    await view.close();
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toBe("runtime oops");
  });
});

// ---------------------------------------------------------------------------
// AC #4: closed promise — resolves with reason
// ---------------------------------------------------------------------------

describe("closed promise", () => {
  test("resolves with reason:caller after close()", async () => {
    const view = await mountMock(readyThenClose());
    void view.close();
    const result = await view.closed;
    expect(result.reason).toBe("caller");
  });

  test("resolves with reason:signal when process exits on SIGTERM", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "signal" } },
      { kind: "exit", code: 0 },
    ]);
    const result = await view.closed;
    expect(result.reason).toBe("signal");
  });
});

// ---------------------------------------------------------------------------
// AC #4: close() — sends close and awaits closed event
// ---------------------------------------------------------------------------

describe("close()", () => {
  test("resolves once the binary emits closed", async () => {
    const view = await mountMock(readyThenClose());
    await view.close();
    // If close() didn't await properly, this timeout would hang.
    const result = await view.closed;
    expect(result.reason).toBe("caller");
  });
});

// ---------------------------------------------------------------------------
// AC #5: signal abort — pre-ready (kill path)
// ---------------------------------------------------------------------------

describe("signal abort — pre-ready", () => {
  test("mount() rejects with AbortError when signal fires before ready", async () => {
    const controller = new AbortController();
    // Fire abort before ready arrives; the mock delays ready by 200ms.
    const p = mountMock(
      [
        { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 }, delayMs: 400 },
        { kind: "wait-for", type: "__never__", timeoutMs: 8000 },
      ],
      { signal: controller.signal },
    );
    // Abort before the mock emits ready.
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  test("mount() rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      mountMock(readyThenClose(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------
// AC #5: signal abort — post-ready (close + kill grace path)
// ---------------------------------------------------------------------------

describe("signal abort — post-ready", () => {
  test("closed resolves with reason:signal when signal fires after ready", async () => {
    const controller = new AbortController();
    const view = await mountMock(
      [
        { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
        { kind: "exit", code: 0 },
      ],
      { signal: controller.signal },
    );
    controller.abort();
    const result = await view.closed;
    expect(result.reason).toBe("signal");
  });
});

// ---------------------------------------------------------------------------
// AC #6: exit before ready — mount() rejects with a clear error
// ---------------------------------------------------------------------------

describe("exit before ready", () => {
  test("mount() rejects when binary exits without emitting ready", async () => {
    await expect(
      mountMock([
        { kind: "stderr", text: "fatal: bad config\n" },
        { kind: "exit", code: 1 },
      ]),
    ).rejects.toThrow(/binary exited/);
  });
});

// ---------------------------------------------------------------------------
// AC #2: build error on initial mount — binary emits error+closed before ready
// ---------------------------------------------------------------------------

describe("build error before ready", () => {
  test("mount() rejects when binary emits build error and exits before ready", async () => {
    await expect(
      mountMock([
        { kind: "emit", msg: { version: "1", type: "error", phase: "build", message: "TSX compile failed" } },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "error" } },
        { kind: "exit", code: 1 },
      ]),
    ).rejects.toThrow(/binary exited/);
  });
});

// ---------------------------------------------------------------------------
// AC #2: multiple in-flight mutations — id-pairing verified via handler args
// ---------------------------------------------------------------------------

describe("multiple in-flight mutations", () => {
  test("two concurrent mutations are both dispatched and results returned", async () => {
    const dispatched: number[] = [];
    const view = await mountMock(
      [
        { kind: "emit", msg: { version: "1", type: "ready", url: "u", port: 1 } },
        { kind: "emit", msg: { version: "1", type: "mutate", id: 1, name: "work", args: 10 } },
        { kind: "emit", msg: { version: "1", type: "mutate", id: 2, name: "work", args: 20 } },
        { kind: "wait-for", type: "result", timeoutMs: 5000 },
        { kind: "wait-for", type: "result", timeoutMs: 5000 },
        { kind: "wait-for", type: "close", timeoutMs: 5000 },
        { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
        { kind: "exit", code: 0 },
      ],
      {
        mutations: {
          work: async (args) => {
            dispatched.push(args as number);
            return (args as number) * 2;
          },
        },
      },
    );
    await view.close();
    // Both mutations were dispatched; protocol does not guarantee ordering.
    expect([...dispatched].sort((a, b) => a - b)).toEqual([10, 20]);
  });
});

// ---------------------------------------------------------------------------
// AC #2: slow startup — mount() resolves even when ready is delayed
// ---------------------------------------------------------------------------

describe("slow startup", () => {
  test("mount() resolves when the binary delays ready by 200ms", async () => {
    const view = await mountMock([
      { kind: "emit", msg: { version: "1", type: "ready", url: "http://127.0.0.1:9001/", port: 9001 }, delayMs: 200 },
      { kind: "wait-for", type: "close", timeoutMs: 5000 },
      { kind: "emit", msg: { version: "1", type: "closed", reason: "caller" } },
      { kind: "exit", code: 0 },
    ]);
    expect(typeof view.id).toBe("string");
    expect(view.port).toBe(9001);
    await view.close();
  });
});

// ---------------------------------------------------------------------------
// AC #2: disconnect → reconnect cycle — both handlers fire in sequence
// ---------------------------------------------------------------------------

describe("disconnect/reconnect cycle", () => {
  test("onDisconnect then onReconnect fire in order", async () => {
    const events: string[] = [];
    const view = await mountMock(readyThenClose([
      { kind: "emit", msg: { version: "1", type: "disconnected" }, delayMs: 30 },
      { kind: "emit", msg: { version: "1", type: "reconnected" }, delayMs: 30 },
    ]));
    view.onDisconnect(() => events.push("disconnected"));
    view.onReconnect(() => events.push("reconnected"));
    // Wait long enough for both events to arrive (2× 30ms delay + margin).
    await new Promise((r) => setTimeout(r, 200));
    await view.close();
    expect(events).toContain("disconnected");
    expect(events).toContain("reconnected");
    expect(events.indexOf("disconnected")).toBeLessThan(events.indexOf("reconnected"));
  });
});
