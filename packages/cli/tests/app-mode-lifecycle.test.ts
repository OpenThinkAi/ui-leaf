// ui-leaf#101: a shell:"app" mount's `closed` must resolve when its Chrome
// goes away — whether Chrome exits (⌘Q, SIGTERM, crash) or lingers with zero
// windows after the last app window closed (macOS). Drives startDevServer with
// a fake Chrome child whose fds 3/4 speak a scripted CDP over PassThrough
// streams, via the existing _spawn / _fsAccess / _listProcesses seams.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");
const IS_DARWIN = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextPid = 700_000;

class FakeChrome extends EventEmitter {
  pid = nextPid++;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  pages = 1;
  /** When true, Browser.close makes the fake exit (graceful quit). */
  honorsBrowserClose = true;
  methods: string[] = [];
  stdio: Array<PassThrough | null>;
  private toChrome = new PassThrough();
  private fromChrome = new PassThrough();
  constructor() {
    super();
    this.stdio = [null, null, null, this.toChrome, this.fromChrome];
    let buf = "";
    this.toChrome.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nul: number;
      while ((nul = buf.indexOf("\0")) !== -1) {
        const msg = JSON.parse(buf.slice(0, nul)) as { id: number; method: string };
        buf = buf.slice(nul + 1);
        this.methods.push(msg.method);
        if (msg.method === "Target.getTargets") {
          const targetInfos = [
            { type: "service_worker" },
            ...Array.from({ length: this.pages }, () => ({ type: "page" })),
          ];
          this.reply({ id: msg.id, result: { targetInfos } });
        } else if (msg.method === "Browser.close") {
          this.reply({ id: msg.id, result: {} });
          if (this.honorsBrowserClose) setTimeout(() => this.exit(0, null), 5);
        }
      }
    });
  }
  private reply(obj: unknown): void {
    if (!this.fromChrome.destroyed) this.fromChrome.write(`${JSON.stringify(obj)}\0`);
  }
  unref(): void {}
  kill(): boolean {
    this.killed = true;
    return true;
  }
  exit(code: number | null, signal: string | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.fromChrome.end();
    this.emit("exit", code, signal);
  }
}

const spawned: Array<{ child: FakeChrome; args: string[]; options: unknown }> = [];
const fakeSpawn = ((command: string, args: readonly string[], options: unknown) => {
  const child = new FakeChrome();
  if (command !== "taskkill") spawned.push({ child, args: [...args], options });
  return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
}) as unknown as typeof import("node:child_process").spawn;

const fakeAccess = async (path: unknown): Promise<void> => {
  if (typeof path !== "string") throw new Error("ENOENT");
  if (IS_DARWIN && path.includes("Google Chrome.app")) return;
  if (IS_WIN && path.toLowerCase().endsWith("chrome.exe")) return;
  if (!IS_DARWIN && !IS_WIN && path.endsWith("/google-chrome")) return;
  throw new Error("ENOENT");
};

const ORIGINAL_PROCESS_KILL = process.kill.bind(process);
const processKillLog: Array<{ pid: number; signal: unknown }> = [];

const { startDevServer } = await import("../src/server.ts");
type Srv = Awaited<ReturnType<typeof startDevServer>>;
let server: Srv | null = null;

beforeEach(() => {
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
  spawned.length = 0;
  processKillLog.length = 0;
  process.kill = ORIGINAL_PROCESS_KILL;
});

type AppWatch = NonNullable<Parameters<typeof startDevServer>[0]["_appWatch"]>;
async function mountApp(appWatch: AppWatch = {}): Promise<Srv> {
  server = await startDevServer({
    _env: {},
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
    _listProcesses: () => [],
    _appWatch: { intervalMs: 5, emptyGraceMs: 40, launchGraceMs: 2000, quitGraceMs: 100, ...appWatch },
  });
  return server;
}

const settle = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, sleep(ms).then(() => "pending" as const)]);

describe("shell:app lifecycle (ui-leaf#101)", () => {
  test.skipIf(IS_WIN)("launches Chrome with a private CDP pipe on fds 3/4", async () => {
    await mountApp();
    expect(spawned).toHaveLength(1);
    const { args, options } = spawned[0]!;
    expect(args).toContain("--remote-debugging-pipe");
    // No network debugging endpoint unless the caller opted into debugPort.
    expect(args.some((a) => a.startsWith("--remote-debugging-port="))).toBe(false);
    expect((options as { stdio: unknown }).stdio).toEqual([
      "ignore",
      "ignore",
      "ignore",
      "pipe",
      "pipe",
    ]);
  }, 30_000);

  test("closed resolves with 'browser' when the Chrome child exits (⌘Q / SIGTERM / crash)", async () => {
    const srv = await mountApp();
    expect(await settle(srv.closed, 100)).toBe("pending");
    spawned[0]!.child.exit(null, "SIGTERM");
    expect(await settle(srv.closed, 2000)).toBe("browser");
    server = null;
  }, 30_000);

  test.skipIf(IS_WIN)(
    "last app window closed (Chrome lingering, 0 pages): asks Chrome to quit over CDP and resolves closed",
    async () => {
      const srv = await mountApp();
      const chrome = spawned[0]!.child;
      await sleep(60);
      expect(await settle(srv.closed, 10)).toBe("pending");
      chrome.pages = 0; // user hit ⌘W on the only window
      expect(await settle(srv.closed, 2000)).toBe("browser");
      server = null;
      expect(chrome.methods).toContain("Browser.close");
      // Graceful quit sufficed: no signal reached any pid.
      expect(processKillLog).toHaveLength(0);
    },
    30_000,
  );

  test.skipIf(IS_WIN)(
    "falls back to a pid-scoped SIGTERM (never a process-group kill) when Chrome ignores Browser.close",
    async () => {
      const srv = await mountApp();
      const chrome = spawned[0]!.child;
      chrome.honorsBrowserClose = false;
      await sleep(60); // let the watcher see the window first
      chrome.pages = 0;
      // Wait for the empty grace + quit grace to elapse.
      for (let i = 0; i < 100 && processKillLog.length === 0; i++) await sleep(10);
      const pids = processKillLog.map((c) => c.pid);
      expect(pids).toContain(chrome.pid);
      expect(pids.every((p) => p > 0)).toBe(true); // no kill(-pid)
      expect(processKillLog.every((c) => c.signal === "SIGTERM")).toBe(true);
      expect(await settle(srv.closed, 20)).toBe("pending");
      chrome.exit(null, "SIGTERM"); // the signal took effect
      expect(await settle(srv.closed, 2000)).toBe("browser");
      server = null;
    },
    30_000,
  );

  test.skipIf(IS_WIN)(
    "a window that keeps its page target (e.g. minimized) is never torn down",
    async () => {
      const srv = await mountApp();
      await sleep(200); // many watcher ticks, far past the empty grace
      expect(await settle(srv.closed, 10)).toBe("pending");
      expect(spawned[0]!.child.methods).not.toContain("Browser.close");
      expect(processKillLog).toHaveLength(0);
    },
    30_000,
  );

  test("with several app windows (reopen), closed waits for the last Chrome to exit", async () => {
    const srv = await mountApp();
    await srv.reopen();
    expect(spawned).toHaveLength(2);
    spawned[0]!.child.exit(0, null);
    expect(await settle(srv.closed, 100)).toBe("pending");
    spawned[1]!.child.exit(0, null);
    expect(await settle(srv.closed, 2000)).toBe("browser");
    server = null;
  }, 30_000);

  test("explicit close still reports 'caller' and Chrome's exit afterwards doesn't change it", async () => {
    const srv = await mountApp();
    const chrome = spawned[0]!.child;
    await srv.close();
    server = null;
    chrome.exit(null, "SIGTERM");
    expect(await srv.closed).toBe("caller");
  }, 30_000);
});
