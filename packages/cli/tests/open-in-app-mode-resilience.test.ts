// Regression test for ui-leaf#54 root cause: the `open` library's launched
// child can emit a delayed `'error'` event after spawn (Chromium rejecting
// the `--app=URL` handoff, helper exiting non-zero post-Apple-Event, etc.).
// Without a listener, Node promotes that to `uncaughtException` and crashes
// the host. openInAppMode defends by attaching a no-op `'error'` listener
// and `unref()`-ing the child. This test exercises that patch by mocking
// the `open` library to return a ChildProcess-like that synchronously
// queues an `'error'` emit after resolve.
//
// Companion to packages/cli/tests/shell-app-stray-connection.test.ts, which
// guards the broader "mount survives stray unauth traffic" behaviour via
// the `_opener` test seam. That test bypasses openInAppMode entirely; this
// one keeps it in the loop.

import { describe, test, expect, afterEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

class FakeChildProcess extends EventEmitter {
  unrefCount = 0;
  unref(): void {
    this.unrefCount++;
  }
}

// Most-recent fake child, captured by the mocked `open` so the test can
// assert on it.
const childRef: { current: FakeChildProcess | null } = { current: null };

// Install module mock BEFORE the dynamic import of server.ts so the
// server module picks up the mocked `open` rather than the real one.
mock.module("open", () => ({
  default: async (_url: string, _opts?: unknown) => {
    const child = new FakeChildProcess();
    childRef.current = child;
    // Defer the 'error' emit to the next macrotask via setImmediate. This
    // gives openInAppMode time to resume past the `await open(...)` and
    // attach its `'error'` listener before we fire. The real failure shape
    // (Chromium rejecting `--app=URL`, helper exiting non-zero after Apple
    // Event delivery) comes from OS signals which are macrotask-scheduled,
    // not microtask-scheduled, so this matches production timing.
    //
    // If openInAppMode failed to attach the listener, this emit would
    // become uncaughtException and crash the Bun test runner.
    setImmediate(() =>
      child.emit("error", new Error("simulated chromium --app post-spawn failure")),
    );
    return child;
  },
  apps: { chrome: "fake-chrome", edge: "fake-edge", brave: "fake-brave" },
}));

// Dynamic import after mock.module so server.ts evaluates with the mock in place.
const { startDevServer } = await import("../src/server.ts");
type Srv = Awaited<ReturnType<typeof startDevServer>>;

let server: Srv | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  childRef.current = null;
});

describe("openInAppMode contains post-spawn ChildProcess errors (ui-leaf#54)", () => {
  test(
    'mount survives a fake Chromium launcher that emits "error" after spawn',
    async () => {
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
      });

      // Yield to the event loop's check phase so the fake child's
      // setImmediate-scheduled 'error' emit fires before we assert.
      await new Promise((r) => setImmediate(r));

      // openInAppMode must have constructed the child, attached an 'error'
      // listener (so the emit was absorbed), and unref()'d it.
      expect(childRef.current).not.toBeNull();
      expect(childRef.current!.listenerCount("error")).toBeGreaterThanOrEqual(1);
      expect(childRef.current!.unrefCount).toBe(1);

      // The server is still alive and serving — the load-bearing assertion.
      const res = await fetch(`${server.url}/`);
      await res.body?.cancel().catch(() => { });
      expect(res.status).toBe(200);
    },
    30_000,
  );
});
