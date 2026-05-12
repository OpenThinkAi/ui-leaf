// Regression test for ui-leaf#54 + ui-leaf#55. openInAppMode's launcher
// can emit a delayed `'error'` event on the spawned child (Chromium
// rejecting the `--app=URL` handoff, helper exiting non-zero post-Apple-
// Event delivery, etc.). Without a listener Node promotes that to
// uncaughtException and crashes the host (#54). On macOS we additionally
// bypass `/usr/bin/open` and spawn the Chromium binary directly with
// `--user-data-dir=<tmp>` so launch args aren't dropped by the AppleEvent
// route to an already-running instance (#55).
//
// The test exercises both paths:
//   - darwin: mock `node:child_process.spawn` (and `node:fs/promises.access`
//             so the binary is found without filesystem state)
//   - linux/win: mock the `open` library
//
// Both paths share the listener-attachment contract via
// attachLauncherErrorListener; the test asserts that contract holds on the
// platform we're running on, plus checks the spawn-args shape on darwin.
//
// Companion to shell-app-stray-connection.test.ts, which guards the
// broader "mount survives stray unauth traffic" behaviour via the
// `_opener` test seam (bypassing openInAppMode entirely).

import { describe, test, expect, afterEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");
const IS_DARWIN = process.platform === "darwin";

class FakeChildProcess extends EventEmitter {
  unrefCount = 0;
  unref(): void {
    this.unrefCount++;
  }
}

// Captured by whichever mock the current platform takes.
const childRef: { current: FakeChildProcess | null } = { current: null };
const spawnLog: Array<{ command: string; args: readonly string[] }> = [];
const openLog: Array<{ url: string; appArgs: readonly string[] }> = [];

function makeFakeChildEmittingError(label: string): FakeChildProcess {
  const child = new FakeChildProcess();
  // Defer the 'error' emit to the next macrotask (check phase) so
  // attachLauncherErrorListener can attach before we fire. The real
  // failure shape (Chromium refusing the launch flags, helper exit
  // post-AppleEvent) comes from OS signals which are macrotask-scheduled.
  // If the listener wasn't attached, this emit would become
  // uncaughtException and crash the test runner.
  setImmediate(() =>
    child.emit(
      "error",
      new Error(`simulated chromium app-mode launch failure (${label})`),
    ),
  );
  return child;
}

// Platform-specific module mocks must run BEFORE the dynamic import of
// server.ts so the server module evaluates against the mocks.
if (IS_DARWIN) {
  // Pretend the first macOS Chromium binary exists; skip the others. The
  // spawn mock catches the resulting spawn() call.
  mock.module("node:fs/promises", () => {
    const real = require("node:fs/promises") as typeof import("node:fs/promises");
    const access = async (path: unknown, _mode?: unknown): Promise<void> => {
      if (typeof path === "string" && path.includes("Google Chrome.app")) return;
      throw new Error("ENOENT (test-mocked)");
    };
    return { ...real, default: { ...real, access }, access };
  });

  mock.module("node:child_process", () => {
    const real = require("node:child_process") as typeof import("node:child_process");
    const fakeSpawn = ((command: string, args: readonly string[]) => {
      spawnLog.push({ command, args: [...args] });
      const child = makeFakeChildEmittingError(command);
      childRef.current = child;
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { ...real, default: { ...real, spawn: fakeSpawn }, spawn: fakeSpawn };
  });
} else {
  mock.module("open", () => ({
    default: async (
      url: string,
      opts?: { app?: { name: string; arguments?: readonly string[] } },
    ) => {
      const appArgs = opts?.app?.arguments ?? [];
      openLog.push({ url, appArgs: [...appArgs] });
      const child = makeFakeChildEmittingError(opts?.app?.name ?? "default-browser");
      childRef.current = child;
      return child;
    },
    apps: { chrome: "fake-chrome", edge: "fake-edge", brave: "fake-brave" },
  }));
}

// Dynamic import after mocks so server.ts evaluates with them in place.
const { startDevServer } = await import("../src/server.ts");
type Srv = Awaited<ReturnType<typeof startDevServer>>;

let server: Srv | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  childRef.current = null;
  spawnLog.length = 0;
  openLog.length = 0;
});

describe("openInAppMode resilience + launch-args contract", () => {
  test(
    'mount survives a fake Chromium launcher that emits "error" after spawn (ui-leaf#54)',
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

      // attachLauncherErrorListener must have attached an 'error' listener
      // and unref()'d the child on whichever path ran.
      expect(childRef.current).not.toBeNull();
      expect(childRef.current!.listenerCount("error")).toBeGreaterThanOrEqual(1);
      expect(childRef.current!.unrefCount).toBe(1);

      // Load-bearing: server is still alive after the silenced error.
      const res = await fetch(`${server.url}/`);
      await res.body?.cancel().catch(() => { });
      expect(res.status).toBe(200);
    },
    30_000,
  );

  test.skipIf(!IS_DARWIN)(
    "darwin: spawns Chromium binary directly (not via /usr/bin/open) with --user-data-dir (ui-leaf#55)",
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

      await new Promise((r) => setImmediate(r));

      // Exactly one spawn invocation against the Chrome bundle binary.
      expect(spawnLog).toHaveLength(1);
      const call = spawnLog[0]!;
      expect(call.command).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");

      // The launch args must include both --app= (to trigger chromeless
      // window) and --user-data-dir= (to bypass single-instance lock — the
      // #55 root cause). Order is implementation detail; presence matters.
      const args = call.args;
      expect(args.some((a) => a.startsWith("--app="))).toBe(true);
      expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
      expect(args).toContain("--no-first-run");
      expect(args).toContain("--no-default-browser-check");

      // We did NOT shell out through /usr/bin/open — that's the whole point.
      expect(call.command).not.toBe("/usr/bin/open");
      expect(call.command).not.toBe("open");
    },
    30_000,
  );

  test.skipIf(IS_DARWIN)(
    "linux/windows: open() called with --user-data-dir and --app= args",
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

      await new Promise((r) => setImmediate(r));

      expect(openLog.length).toBeGreaterThanOrEqual(1);
      const appArgs = openLog[0]!.appArgs;
      expect(appArgs.some((a) => a.startsWith("--app="))).toBe(true);
      expect(appArgs.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
      expect(appArgs).toContain("--no-first-run");
      expect(appArgs).toContain("--no-default-browser-check");
    },
    30_000,
  );
});
