// Regression test for ui-leaf#54 + ui-leaf#55 + the Windows orphan-window
// cleanup work (this file's expanded scope).
//
// openInAppMode's launcher can emit a delayed `'error'` event on the
// spawned child (Chromium rejecting the `--app=URL` handoff, helper
// exiting non-zero post-Apple-Event delivery, etc.). Without a listener
// Node promotes that to uncaughtException and crashes the host (#54). On
// every platform we bypass the OS launcher shim and spawn the Chromium
// binary directly with `--user-data-dir=<tmp>` so launch args aren't
// dropped (#55) AND so we have a real PID to track for cleanup on
// unmount (the Windows orphan fix).
//
// The test injects fake `spawn` and `access` implementations via the
// `_spawn` / `_fsAccess` test seams on DevServerOptions (matching the
// existing `_opener` convention). No process-global module mocks are
// installed, so nothing leaks to other files in the same Bun worker.
//
// Assertions:
//   - the silenced 'error' listener is attached + child is unref'd (#54)
//   - `--app=`, `--user-data-dir=`, and `--disable-background-mode` are
//     in the launch args
//   - server.close() signals the tracked Chrome PID (cleanup-on-unmount)
//   - heartbeat timeout does NOT signal the Chrome PID (minimize-safety
//     INVARIANT — a minimized window must never be killed)
//
// Companion to shell-app-stray-connection.test.ts, which guards the
// broader "mount survives stray unauth traffic" behaviour via the
// `_opener` test seam (bypassing openInAppMode entirely).

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");
const IS_DARWIN = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

class FakeChildProcess extends EventEmitter {
  pid = 424242;
  killed = false;
  unrefCount = 0;
  killCalls: Array<string | number | undefined> = [];
  unref(): void {
    this.unrefCount++;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

// Captured by the fake spawn.
const childRef: { current: FakeChildProcess | null } = { current: null };
const spawnLog: Array<{ command: string; args: readonly string[] }> = [];
// Captured taskkill calls on Windows (cleanup path).
const taskkillLog: Array<readonly string[]> = [];
// Captured process.kill(pid, signal) calls (POSIX cleanup path).
const processKillLog: Array<{ pid: number; signal: string | number | undefined }> = [];

// Fake fs.access: pretend whichever binary the platform's discovery loop
// probes first exists. macOS uses bundle paths; Windows uses Program Files;
// Linux walks PATH. Injected via _fsAccess — no process-global mock.
const fakeAccess = async (path: unknown, _mode?: unknown): Promise<void> => {
  if (typeof path !== "string") throw new Error("ENOENT (test-mocked)");
  if (IS_DARWIN && path.includes("Google Chrome.app")) return;
  if (IS_WIN && path.toLowerCase().endsWith("chrome.exe")) return;
  if (!IS_DARWIN && !IS_WIN && path.endsWith("/google-chrome")) return;
  throw new Error("ENOENT (test-mocked)");
};

// Fake spawn: intercepts Chromium launch and taskkill calls.
// Injected via _spawn — no process-global mock.
const fakeSpawn = ((command: string, args: readonly string[]) => {
  if (command === "taskkill") {
    taskkillLog.push([...args]);
    // taskkill child also needs to be an EventEmitter (the code attaches
    // an 'error' listener and calls unref()). It does NOT need to be the
    // childRef captured — that one is the tracked Chrome process.
    const tk = new FakeChildProcess();
    return tk as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }
  spawnLog.push({ command, args: [...args] });
  const child = makeFakeChildEmittingError(command);
  childRef.current = child;
  return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
}) as unknown as typeof import("node:child_process").spawn;

function makeFakeChildEmittingError(label: string): FakeChildProcess {
  const child = new FakeChildProcess();
  // Defer the 'error' emit to the next macrotask so
  // attachLauncherErrorListener can attach before we fire. If the
  // listener wasn't attached, this emit would become uncaughtException
  // and crash the test runner.
  setImmediate(() =>
    child.emit(
      "error",
      new Error(`simulated chromium app-mode launch failure (${label})`),
    ),
  );
  return child;
}

// Saved real process.kill so we can restore it after each test. The patch
// is applied fresh in beforeEach so it's always active during the test body
// (including srv.close()) and restored in afterEach so subsequent tests and
// files see the real implementation.
const ORIGINAL_PROCESS_KILL = process.kill.bind(process);

const { startDevServer } = await import("../src/server.ts");
type Srv = Awaited<ReturnType<typeof startDevServer>>;

let server: Srv | null = null;

beforeEach(() => {
  // (Re-)apply the process.kill patch before each test so the stub is always
  // in place for the test body (including any srv.close() calls within it).
  process.kill = ((pid: number, signal?: string | number) => {
    processKillLog.push({ pid, signal });
    return true;
  }) as typeof process.kill;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  childRef.current = null;
  spawnLog.length = 0;
  taskkillLog.length = 0;
  processKillLog.length = 0;
  // Restore process.kill after each test so subsequent tests (and files in
  // the same Bun worker) see the real implementation — no leak.
  process.kill = ORIGINAL_PROCESS_KILL;
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
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));

      // attachLauncherErrorListener must have attached an 'error' listener
      // and unref()'d the child.
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

  test(
    "direct-spawns the Chromium binary (not via launcher shim) with the expected launch args",
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
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));

      // Exactly one spawn invocation against a Chromium binary. We never
      // shell out to /usr/bin/open, cmd.exe, or xdg-open here.
      expect(spawnLog).toHaveLength(1);
      const call = spawnLog[0]!;
      if (IS_DARWIN) {
        expect(call.command).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
        expect(call.command).not.toBe("/usr/bin/open");
      } else if (IS_WIN) {
        expect(call.command.toLowerCase()).toEndWith("chrome.exe");
        expect(call.command.toLowerCase()).not.toContain("cmd.exe");
      } else {
        expect(call.command).toEndWith("/google-chrome");
        expect(call.command).not.toContain("xdg-open");
      }

      // Launch-args contract: --app= triggers the chromeless window,
      // --user-data-dir= forces a separate process (single-instance lock
      // is per profile), --disable-background-mode keeps Chrome from
      // sticking around after the last window closes (the Windows
      // orphan-process behaviour we're plugging).
      const args = call.args;
      expect(args.some((a) => a.startsWith("--app="))).toBe(true);
      expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
      expect(args).toContain("--no-first-run");
      expect(args).toContain("--no-default-browser-check");
      expect(args).toContain("--disable-background-mode");
    },
    30_000,
  );
});

describe("Chrome lifecycle: kill-on-unmount + minimize-safety", () => {
  test(
    "server.close() signals the tracked Chrome process (window closes on unmount)",
    async () => {
      const srv = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        shell: "app",
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));
      expect(childRef.current).not.toBeNull();
      const tracked = childRef.current!;

      // Trigger the unmount path. cleanup() should reach into
      // trackedAppWindows and signal the Chrome PID.
      await srv.close();
      // server is now closed; null out the afterEach handle.
      server = null;

      if (IS_WIN) {
        // Windows path uses taskkill /T /F against the tracked PID.
        expect(taskkillLog.length).toBeGreaterThanOrEqual(1);
        const args = taskkillLog[0]!;
        expect(args).toContain("/pid");
        expect(args).toContain(String(tracked.pid));
        expect(args).toContain("/T");
        expect(args).toContain("/F");
      } else {
        // POSIX path signals the negative PID (process group).
        const groupSignals = processKillLog.filter((c) => c.pid === -tracked.pid);
        expect(groupSignals.length).toBeGreaterThanOrEqual(1);
        expect(groupSignals[0]!.signal).toBe("SIGTERM");
      }
    },
    30_000,
  );

  test(
    "heartbeat timeout does NOT signal the Chrome process (minimize-safety invariant)",
    async () => {
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        shell: "app",
        // Aggressive timing: 50ms heartbeat with 10ms watcher tick and no
        // startup grace. The "disconnected" event will fire well within
        // the test window since we never POST /heartbeat.
        heartbeatTimeoutMs: 50,
        startupGraceMs: 0,
        _heartbeatCheckIntervalMs: 10,
        silent: true,
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));
      expect(childRef.current).not.toBeNull();
      const tracked = childRef.current!;

      // Observe the disconnected event so we know the heartbeat watcher
      // actually fired (not just that time passed).
      const disconnected = new Promise<void>((resolve) => {
        server!.on("disconnected", () => resolve());
      });

      // Settle: wait for disconnect + a bit more for any (forbidden) kill
      // path to run.
      await Promise.race([
        disconnected,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      await new Promise((r) => setTimeout(r, 100));

      // INVARIANT: no signal was sent to the tracked Chrome PID via any
      // path. A minimized window must survive heartbeat pauses.
      expect(tracked.killCalls).toHaveLength(0);
      expect(taskkillLog).toHaveLength(0);
      const signalsToTracked = processKillLog.filter(
        (c) => c.pid === tracked.pid || c.pid === -tracked.pid,
      );
      expect(signalsToTracked).toHaveLength(0);

      // Sanity: the server is still serving.
      const res = await fetch(`${server!.url}/`);
      await res.body?.cancel().catch(() => { });
      expect(res.status).toBe(200);
    },
    30_000,
  );
});

describe("persistent profile (ui-leaf#63)", () => {
  // Unique per-run dir under tmpdir; created by the launch path, asserted to
  // survive unmount, then removed by the test (it's caller-owned, so ui-leaf
  // never cleans it up — that's the whole point of the feature).
  const profileDir = join(
    tmpdir(),
    `ui-leaf-test-profile-${process.pid}-${Date.now()}`,
  );

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  test(
    "uses the caller's profile dir as --user-data-dir and creates it on first use",
    async () => {
      expect(existsSync(profileDir)).toBe(false);

      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        shell: "app",
        profile: { dir: profileDir },
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));

      // The persistent dir is passed verbatim — NOT an mkdtemp temp dir.
      expect(spawnLog).toHaveLength(1);
      expect(spawnLog[0]!.args).toContain(`--user-data-dir=${profileDir}`);
      // Created on first use so a fresh path works.
      expect(existsSync(profileDir)).toBe(true);
    },
    30_000,
  );

  test(
    "does NOT delete the profile dir on unmount (session persists across launches)",
    async () => {
      const srv = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        shell: "app",
        profile: { dir: profileDir },
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));
      expect(existsSync(profileDir)).toBe(true);

      await srv.close();
      server = null;

      // The whole point of #63: the profile survives unmount so a re-launch
      // reuses the same logged-in session.
      expect(existsSync(profileDir)).toBe(true);
    },
    30_000,
  );
});

describe("window position (ui-leaf#65)", () => {
  test(
    "passes --window-position=X,Y through to the Chromium launch args",
    async () => {
      server = await startDevServer({
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        shell: "app",
        windowPosition: { x: 100, y: 60 },
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _spawn: fakeSpawn,
        _fsAccess: fakeAccess,
      });

      await new Promise((r) => setImmediate(r));

      expect(spawnLog).toHaveLength(1);
      expect(spawnLog[0]!.args).toContain("--window-position=100,60");
    },
    30_000,
  );
});

describe("load extensions (ui-leaf#64)", () => {
  const extDir = join(tmpdir(), `ui-leaf-test-ext-${process.pid}-${Date.now()}`);
  const missingDir = join(tmpdir(), `ui-leaf-test-ext-missing-${process.pid}`);
  // A single element with an embedded comma — Chrome would parse it as two
  // dirs. The server-layer filter must reject it (defends the SDK path, which
  // skips the stdio config validation).
  const commaDir = `${extDir},/abs/evil`;

  // fs.access seam that accepts the platform Chrome binary (so the launch
  // proceeds) AND the existing extension dir, but rejects everything else
  // (so `missingDir` reads as absent). No real dirs needed — access is faked.
  const fsAccessWithExt = (async (path: unknown, mode?: unknown): Promise<void> => {
    if (path === extDir) return;
    return fakeAccess(path, mode);
  }) as typeof import("node:fs/promises").access;

  test(
    "loads existing dirs; skips missing and comma-injecting ones with a stderr warning",
    async () => {
      const stderrWrites: string[] = [];
      const realStderrWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: stderr.write is overloaded
      process.stderr.write = ((chunk: any) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      try {
        server = await startDevServer({
          view: "trivial",
          viewsRoot: VIEWS_ROOT,
          data: {},
          port: 0,
          openBrowser: true,
          shell: "app",
          extensions: [extDir, missingDir, commaDir],
          heartbeatTimeoutMs: 75_000,
          startupGraceMs: 0,
          silent: true,
          _spawn: fakeSpawn,
          _fsAccess: fsAccessWithExt,
        });

        await new Promise((r) => setImmediate(r));
      } finally {
        process.stderr.write = realStderrWrite;
      }

      expect(spawnLog).toHaveLength(1);
      const args = spawnLog[0]!.args;
      // Only the existing dir is loaded; missing + comma dirs are filtered out.
      expect(args).toContain(`--load-extension=${extDir}`);
      expect(args).toContain(`--disable-extensions-except=${extDir}`);
      expect(args.some((a) => a.includes(missingDir))).toBe(false);
      // The comma path never reaches the args — no injection of /abs/evil.
      expect(args.some((a) => a.includes("/abs/evil"))).toBe(false);
      // Both skipped paths are surfaced, not silently dropped.
      const stderr = stderrWrites.join("");
      expect(stderr).toContain(missingDir);
      expect(stderr).toContain("contains ','");
    },
    30_000,
  );
});
