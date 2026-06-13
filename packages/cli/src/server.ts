import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import open from "open";
import { compileView, compileSource } from "./compile.js";
import type { CloseReason } from "./ipc.js";

// Module-level stdout redirect state. Captured ONCE at module load so
// concurrent silent: true mounts share the same "original" reference and
// restore-order doesn't matter. Refcounted so the last close restores.
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
let stdoutRedirectCount = 0;

/**
 * Redirect process.stdout.write to process.stderr until the returned
 * function is called. Safe under concurrent silent mounts.
 */
function redirectStdoutToStderr(): () => void {
  stdoutRedirectCount++;
  if (stdoutRedirectCount === 1) {
    // biome-ignore lint/suspicious/noExplicitAny: stdout.write has overloaded
    // signatures; forward exactly what comes in.
    process.stdout.write = ((chunk: any, enc?: any, cb?: any) =>
      process.stderr.write(chunk, enc, cb)) as typeof process.stdout.write;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    stdoutRedirectCount--;
    if (stdoutRedirectCount === 0) {
      process.stdout.write = ORIGINAL_STDOUT_WRITE;
    }
  };
}

export type MutationHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
) => TResult | Promise<TResult>;

// `(string & {})` preserves the "off" / "strict" autocomplete suggestions
// while still allowing arbitrary CSP strings. Plain string would collapse
// the union and lose IntelliSense for the literals.
export type CspOption = "off" | "strict" | (string & {});

export type Shell = "tab" | "app";

// macOS Chromium-family bundle binary paths. Spawning these directly
// bypasses `/usr/bin/open` so launch args reach Chrome even when an instance
// of that browser is already running with the user's default profile —
// see openInAppMode docstring for the AppleEvent-handoff failure mode.
const MACOS_CHROMIUM_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

// Windows install-path candidates for Chromium-family browsers. Probed in
// order; first executable wins. Spawning directly (rather than via the
// `open` library, which shells through `cmd /c start chrome.exe …`) gives
// us a usable PID to track so the window can be torn down on unmount.
function windowsChromiumBinaries(): string[] {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"];
  const candidates = [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    // Edge ships native-arch installers, so 64-bit Windows lands at
    // Program Files (not the x86 path). Probe both — an Edge-only host
    // would otherwise fall through to a default-browser tab and silently
    // defeat the whole shell:"app" path.
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(
      programFilesX86,
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe",
    ),
  ];
  if (localAppData) {
    candidates.unshift(
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    );
  }
  return candidates;
}

// Linux Chromium-family command names. Resolved against PATH (no shell
// invocation — we walk `process.env.PATH` ourselves so we can build an
// absolute path for the direct spawn, which is what gives us a usable PID
// for the cleanup-on-unmount path).
const LINUX_CHROMIUM_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "brave-browser",
];

async function resolveOnPath(
  command: string,
  accessImpl: typeof access,
): Promise<string | null> {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await isExecutable(candidate, accessImpl)) return candidate;
  }
  return null;
}

async function isExecutable(
  path: string,
  accessImpl: typeof access,
): Promise<boolean> {
  try {
    await accessImpl(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function attachLauncherErrorListener(
  child: ChildProcess | null | undefined,
  label: string,
): void {
  child?.on?.("error", (err: unknown) => {
    // Silenced to prevent uncaughtException (see openInAppMode docstring),
    // but emit a stderr breadcrumb when UI_LEAF_DEBUG=1 is set so the next
    // Chromium quirk leaves a trace. Gated on env (not on the `silent`
    // option) because structured-protocol mode intentionally suppresses
    // incidental output; debug-tracing is orthogonal opt-in.
    if (process.env.UI_LEAF_DEBUG === "1") {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `ui-leaf: chromium app-mode launch failed post-spawn (${label}): ${msg}\n`,
      );
    }
  });
}

/**
 * Try to open `url` in a Chromium browser's --app mode (chromeless window:
 * no URL bar, no tabs). Returns the spawned `ChildProcess` handle when a
 * Chromium browser was found and launched (the caller tracks it so the
 * window can be torn down on unmount — see startDevServer's cleanup()),
 * or `null` when no Chromium variant is installed (caller falls back to
 * the default-browser tab).
 *
 * **Direct-spawn on every platform.** We deliberately do NOT route through
 * the `open` library here:
 *
 *   - macOS (ui-leaf#55): `open` shells out to `/usr/bin/open -a "Google
 *     Chrome" --args …`. When Chrome is already running with the user's
 *     default profile, that delivers an AppleEvent to the existing
 *     instance which silently drops the `--args` (only fresh-launch
 *     `main()` receives them), so `--app=URL` is ignored. Direct spawn
 *     bypasses LaunchServices, and a per-mount `--user-data-dir` opens a
 *     separate process so `--app=` actually takes effect.
 *
 *   - Windows: `open` shells through `cmd /c start chrome.exe …`. The
 *     child we get back is the launcher shim, not chrome.exe — its PID
 *     is useless for tearing the window down later. Direct spawn gives
 *     us a real handle on the browser process itself, which is the only
 *     way cleanup() can reliably close the window on unmount.
 *
 *   - Linux: same PID-tracking concern as Windows; the `open` path
 *     usually goes via `xdg-open` and we lose the browser PID.
 *
 * **Per-mount user-data-dir.** By default each launch gets a fresh temp
 * profile. That bypasses the single-instance lock so the spawn is a brand
 * new Chrome process (not a tab/window in an existing user session), and
 * it means "last window of this profile closes" reliably tears the process
 * down — no inheriting the user's "continue background apps when Chrome
 * is closed" setting.
 *
 * **Opt-in persistent profile** (ui-leaf#63): when `profileDir` is set the
 * launch uses that directory as `--user-data-dir` instead of a temp dir,
 * and it is never deleted on unmount — so login-gated views (DRM
 * streaming, SSO dashboards) keep their session across launches. The dir
 * (and parents) is created on first use. Persistence is the only
 * difference: direct-spawn and `--app=` still apply, so the chromeless
 * window behaves identically. Caveat: a persistent dir is a named profile,
 * so two concurrent mounts pointed at the same dir hit Chrome's
 * single-instance lock — the second hands off to the first's process
 * rather than spawning its own. Use distinct dirs (or sequential mounts)
 * to keep app windows isolated.
 *
 * **--disable-background-mode** is passed as belt-and-suspenders on top
 * of the fresh profile: it disables Chrome's background-mode behaviour
 * for this instance regardless of profile prefs, so the helper processes
 * don't linger after the window closes (the Windows orphan-process
 * scenario this whole code path exists to fix).
 *
 * **Crash containment** (ui-leaf#54): the spawned ChildProcess can emit
 * a delayed `'error'` event post-spawn (Chromium rejecting the launch
 * flags, helper exiting non-zero). Node promotes unhandled `'error'` to
 * `uncaughtException` and kills the host; `attachLauncherErrorListener`
 * attaches a no-op listener so launcher failures stay contained. The
 * child is `unref()`'d so it doesn't keep the host's event loop alive,
 * but the JS reference is retained by the caller for cleanup-time kill.
 *
 * Set `UI_LEAF_DEBUG=1` (env var, opt-in) to emit a stderr breadcrumb
 * each time the silenced `'error'` fires.
 *
 * **Profile leak**: a successful launch leaves a fresh user-data-dir
 * under `os.tmpdir()` and intentionally does not clean it up — when
 * cleanup() kills the Chrome tree we can't safely remove a directory
 * Chrome may still be flushing to. The OS reaps tmpdir periodically.
 * When this function returns null (no Chromium found), the just-created
 * temp dir is removed before returning so a caller-side fallback to a
 * default-browser tab doesn't leak an empty profile. A persistent
 * `profileDir` is never removed on either path — it is caller-owned.
 */
/**
 * Build the Chromium `--app` launch argv. Extracted so the argv is
 * unit-testable without spawning a real browser; deterministic in its return
 * value (the only side effect is a diagnostic `console.warn` on bad input).
 *
 * When `windowSize` is provided, append `--window-size=W,H` so the chromeless
 * window opens at the right size on first paint instead of snapping via
 * `window.resizeTo()`. Non-finite or non-positive dimensions are not emitted
 * as a flag — but they warn, since silently opening at the default size is a
 * hard-to-spot footgun for a caller whose width/height computed to garbage.
 */
export function buildAppModeArgs(
  url: string,
  userDataDir: string,
  windowSize?: { width: number; height: number },
): string[] {
  const args = [
    `--app=${url}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Without this, Chrome on Windows can keep helper processes alive
    // after the last window of the profile closes, surfacing as orphan
    // chrome.exe entries in Task Manager that pile up across runs.
    "--disable-background-mode",
  ];
  if (windowSize !== undefined) {
    const { width, height } = windowSize;
    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      args.push(`--window-size=${Math.round(width)},${Math.round(height)}`);
    } else {
      console.warn(
        "ui-leaf: windowSize dimensions must be positive finite numbers; windowSize ignored",
      );
    }
  }
  return args;
}

async function openInAppMode(
  url: string,
  windowSize: { width: number; height: number } | undefined,
  profileDir: string | undefined,
  spawnImpl: typeof spawn,
  fsAccessImpl: typeof access,
): Promise<ChildProcess | null> {
  // Defensive: openUrl is server-constructed today (http://127.0.0.1:port/
  // #token=...), but a future refactor could change that. Reject anything
  // that isn't an http(s) URL so a stray `data:` or `javascript:` can't
  // be smuggled into a chromeless window (no URL bar to warn the user).
  if (!/^https?:\/\//i.test(url)) return null;

  // Resolve the --user-data-dir. Default: a throwaway temp profile per
  // mount (separate Chrome process, isolated from the user's session,
  // clean teardown). Opt-in (ui-leaf#63): a caller-supplied persistent
  // dir, used verbatim and never deleted, so login-gated views keep their
  // session across launches. See docstring for the full rationale.
  const persistent = profileDir !== undefined;
  let userDataDir: string;
  if (profileDir !== undefined) {
    userDataDir = profileDir;
    try {
      // Create the profile dir (and parents) so a fresh path works on the
      // first launch. Idempotent when it already exists.
      await mkdir(userDataDir, { recursive: true });
    } catch (err) {
      // The caller explicitly asked for persistence and we can't honour it
      // (bad path, permission denied, path is a file). Don't crash the host —
      // returning null falls back to a default-browser tab. Unlike the silent
      // Chrome-not-found fallback (an environmental condition), a bad
      // profile.dir is a caller mistake that silently downgrades intent, so
      // always surface it on stderr rather than swallowing it.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `ui-leaf: could not create persistent profile dir '${userDataDir}': ${msg}. Falling back to a default-browser tab; the session will not persist.\n`,
      );
      return null;
    }
  } else {
    userDataDir = await mkdtemp(join(tmpdir(), "ui-leaf-chrome-"));
  }
  const launchArgs = buildAppModeArgs(url, userDataDir, windowSize);

  // Helper: remove the user-data-dir when we fall through without
  // launching. A persistent (caller-supplied) profile is never removed —
  // persistence across launches is the whole point — so this no-ops there.
  const cleanupProfile = async (): Promise<void> => {
    if (persistent) return;
    try {
      await rm(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS reaper handles anything we miss.
    }
  };

  // Resolve the first usable Chromium binary for this platform. macOS
  // probes known bundle paths; Linux walks PATH; Windows checks known
  // install paths.
  let binPath: string | null = null;
  if (process.platform === "darwin") {
    for (const p of MACOS_CHROMIUM_BINARIES) {
      if (await isExecutable(p, fsAccessImpl)) {
        binPath = p;
        break;
      }
    }
  } else if (process.platform === "win32") {
    for (const p of windowsChromiumBinaries()) {
      if (await isExecutable(p, fsAccessImpl)) {
        binPath = p;
        break;
      }
    }
  } else {
    for (const cmd of LINUX_CHROMIUM_COMMANDS) {
      const resolved = await resolveOnPath(cmd, fsAccessImpl);
      if (resolved) {
        binPath = resolved;
        break;
      }
    }
  }

  if (!binPath) {
    await cleanupProfile();
    return null;
  }

  try {
    // detached + own session/process group so cleanup() can signal the
    // whole tree (helper processes included). Windows ignores `detached`
    // for SIGTERM purposes — cleanup() uses `taskkill /T` there.
    const child = spawnImpl(binPath, launchArgs, {
      detached: true,
      stdio: "ignore",
    });
    attachLauncherErrorListener(child, binPath);
    // unref so a still-running Chrome doesn't keep the host's event loop
    // alive after the server closes. We retain the JS reference for the
    // cleanup-time kill (unref only affects event-loop accounting).
    child.unref();
    return child;
  } catch {
    // spawn can throw synchronously on EPERM, ENOENT-after-access-race, etc.
    await cleanupProfile();
    return null;
  }
}

/**
 * Terminate a Chromium child spawned by openInAppMode. Best-effort and
 * non-throwing: if the child has already exited, this is a no-op.
 *
 * **INVARIANT**: this is only ever called from startDevServer's
 * cleanup() — never from the heartbeat watcher / `disconnected` event.
 * A minimized window must keep the Chrome process alive (heartbeats can
 * pause indefinitely while minimized; killing on that signal would close
 * the window the user is intentionally hiding). The only legitimate kill
 * triggers are explicit unmount (caller invoked `close()`), process
 * shutdown, or an unrecoverable server error — all of which route
 * through cleanup().
 */
function killChromeTree(child: ChildProcess, spawnImpl: typeof spawn): void {
  // `killed` flips after a successful signal; once set, further signals
  // are no-ops. Don't gate on `exitCode != null` — on detached children
  // we may not have received the exit event yet at cleanup time.
  if (child.killed) return;
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    // SIGTERM doesn't propagate to a Windows process tree, and Chrome
    // spawns helper processes (renderer/gpu/utility) that would otherwise
    // outlive the parent. `taskkill /T /F` kills the tree forcefully.
    try {
      const killer = spawnImpl("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        // taskkill missing or refused — fall back to the JS-side kill.
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }

  // POSIX: the child was spawned `detached: true`, so it leads its own
  // process group. Signal the negative PID to reach the whole group
  // (includes Chrome's renderer/gpu/utility helpers). If this throws —
  // ESRCH (group gone) or EPERM (would also fail a direct child.kill) —
  // we're past recourse; best-effort is good enough here.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone or unsignalable */
  }
}

/**
 * Strict preset: locks `connect-src` to same-origin (the architectural
 * lock that forces views to route mutations through the CLI), while
 * permitting common needs (HTTPS images/fonts, inline styles for React).
 * A future v1.x mode could tighten script-src once usage patterns are known.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline' https:",
  "script-src 'self' 'unsafe-inline'",
].join("; ");

function resolveCsp(opt: CspOption | undefined): string | null {
  if (!opt || opt === "off") return null;
  if (opt === "strict") return STRICT_CSP;
  return opt;
}

function timingSafeEqual(a: string, b: string): boolean {
  // Length check is not timing-safe but is fine — the token length is fixed
  // and known to attackers regardless. The byte compare must be timing-safe.
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const DEFAULT_LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1"] as const;

// Extract the hostname portion of a Host header value, stripping the port.
// IPv6 hosts arrive bracketed (`[::1]:5810`); plain hosts as `host:port`
// or bare `host`. Returns lowercased hostname or null on shapes we don't
// recognise (caller treats null as "reject").
function parseHostHeader(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) return null;
    return trimmed.slice(1, close).toLowerCase();
  }
  const colon = trimmed.indexOf(":");
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

// DNS-rebinding defence: every request must arrive with a Host header
// pointing at one of the allowed names. Same gate applies to Origin when
// the browser sends one. Absent Origin is fine — many legitimate
// same-origin requests omit it. `Origin: null` is allowed because
// sandboxed iframes and `file://` pages send it; the Host check still
// constrains the network path so the Origin allowance isn't load-bearing.
function isAllowedHost(value: string | undefined, allowed: Set<string>): boolean {
  const host = value === undefined ? null : parseHostHeader(value);
  return host !== null && allowed.has(host);
}

function isAllowedOrigin(value: string | undefined, allowed: Set<string>): boolean {
  if (value === undefined || value === "" || value === "null") return true;
  try {
    // WHATWG URL keeps the brackets on IPv6 hostnames (`[::1]`), but the
    // allow-list stores them stripped (matching parseHostHeader's output)
    // so origins and hosts compare consistently.
    let hostname = new URL(value).hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    return allowed.has(hostname);
  } catch {
    return false;
  }
}

export interface DevServerOptions {
  view: string;
  data?: unknown;
  dataLoader?: () => Promise<unknown>;
  viewsRoot: string;
  // biome-ignore lint/suspicious/noExplicitAny: each handler has its own
  // arg/return types; the map can't share one shape.
  mutations?: Record<string, MutationHandler<any, any>>;
  /** Browser tab title. Defaults to "ui-leaf". */
  title?: string;
  port?: number;
  openBrowser?: boolean;
  /**
   * Browser shell. Defaults to "tab".
   *
   * - "tab" — open in user's default browser as a regular tab.
   * - "app" — try Chromium's --app mode (chromeless window). Falls back
   *   to "tab" if no Chromium browser is installed (Chrome/Edge/Brave),
   *   with a stderr note. Safari and Firefox always fall back.
   */
  shell?: Shell;
  /** Initial Chrome window size in CSS pixels for shell:"app". Ignored in tab mode. */
  windowSize?: { width: number; height: number };
  /**
   * Opt-in persistent browser profile for shell:"app". When set, Chrome
   * launches with `--user-data-dir=<profile.dir>` instead of a throwaway
   * temp dir, and the directory is never deleted on unmount — so
   * login-gated views (DRM streaming, SSO dashboards) keep their session
   * across launches. Ignored in tab mode. Default: throwaway temp profile.
   */
  profile?: { dir: string };
  /**
   * Browser silence (ms) after which the mount transitions to disconnected.
   * The mount does NOT terminate on disconnect — only explicit close/signal/error does.
   */
  heartbeatTimeoutMs?: number;
  /** Grace period after server start before the heartbeat watcher is armed. */
  startupGraceMs?: number;
  /**
   * Test seam: interval (ms) for the heartbeat watcher tick. Defaults to 1000.
   * Lower values let tests observe disconnect transitions without sleeping ~1s.
   * Never set this in production.
   */
  _heartbeatCheckIntervalMs?: number;
  /** Content-Security-Policy enforcement. See MountOptions.csp. */
  csp?: CspOption;
  /**
   * Extra hostnames (beyond `localhost`, `127.0.0.1`, `[::1]`) accepted in
   * the request `Host` and `Origin` headers. Use to allow a custom
   * `/etc/hosts` alias or another loopback name; values are matched by
   * hostname only (port-agnostic). Anything outside this set + the
   * loopback defaults is rejected with HTTP 403 to defend against
   * DNS-rebinding attacks. Default: empty.
   */
  allowedHosts?: string[];
  /**
   * Suppress ui-leaf output to stdout. When true, process.stdout.write is
   * redirected to process.stderr for the lifetime of the server, restored
   * on close(). Use when driving mount() programmatically and stdout is
   * reserved for a structured protocol (e.g. line-delimited JSON).
   * Default: false.
   */
  silent?: boolean;
  /**
   * Test seam: replace the browser-open implementation. When provided,
   * called instead of `open(url)` for both the initial open and `reopen()`.
   * Never set this in production; use `openBrowser: false` instead.
   */
  _opener?: (url: string) => Promise<void>;
  /**
   * Test seam: replace `spawn` from `node:child_process`. When provided,
   * used instead of the module-level `spawn` for all child spawns inside
   * `openInAppMode` (chromium launch) and `killChromeTree` (taskkill path).
   * Never set this in production.
   */
  _spawn?: typeof spawn;
  /**
   * Test seam: replace `fs.access` from `node:fs/promises`. When provided,
   * used instead of the module-level `access` for all binary-discovery
   * probes inside `openInAppMode`.
   * Never set this in production.
   */
  _fsAccess?: typeof access;
}

export type { CloseReason };

export type DevServerEvent = "data-updated" | "view-swapped" | "disconnected" | "reconnected";
export type DevServerEventListener = () => void;

type ConnectionState = "connecting" | "connected" | "disconnected";

export interface DevServer {
  url: string;
  port: number;
  /** Resolves with the close reason when the mount terminates. */
  closed: Promise<CloseReason>;
  close: (reason?: CloseReason) => Promise<void>;
  /**
   * Replace in-memory data and emit a `data-updated` event to all
   * registered listeners. Does not recompile the view.
   */
  update: (data: unknown) => void;
  /**
   * Recompile the view from an inline TSX source string and replace the
   * in-memory HTML. Emits `view-swapped` on success; preserves the previous
   * HTML on compile failure. Returns errors array (empty = success).
   */
  swapView: (source: string) => Promise<import("./compile.js").BuildError[]>;
  /**
   * Atomically replace both data and view source. If compilation fails,
   * neither takes effect. Returns errors array (empty = success).
   */
  patch: (data: unknown, source: string) => Promise<import("./compile.js").BuildError[]>;
  /**
   * Re-invoke the browser-open function to launch a fresh tab at the same URL.
   * Always opens a new tab — if one is already connected, a duplicate opens.
   */
  reopen: () => Promise<void>;
  /**
   * Subscribe to a server-side event. Listeners are called synchronously
   * after each mutation completes.
   *
   * Events:
   *   "data-updated" — fired by update() and patch()
   *   "view-swapped"  — fired by swapView() and patch()
   */
  on: (event: DevServerEvent, listener: DevServerEventListener) => void;
  off: (event: DevServerEvent, listener: DevServerEventListener) => void;
}

export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const {
    view,
    data,
    dataLoader,
    viewsRoot,
    mutations = {},
    title = "ui-leaf",
    port,
    openBrowser = true,
    shell = "tab",
    windowSize,
    profile,
    heartbeatTimeoutMs = 5_000,
    startupGraceMs = 30_000,
    csp = "strict",
    allowedHosts,
    silent = false,
    _opener,
    _heartbeatCheckIntervalMs = 1000,
    _spawn: spawnImpl = spawn,
    _fsAccess: fsAccessImpl = access,
  } = opts;
  const cspHeader = resolveCsp(csp);
  const allowedHostSet = new Set<string>(DEFAULT_LOOPBACK_HOSTNAMES);
  for (const h of allowedHosts ?? []) allowedHostSet.add(h.toLowerCase());
  const allowedHostList = [...allowedHostSet].join(", ");

  // Programmatic consumers (esp. non-Node CLIs spawning ui-leaf as a
  // subprocess) often reserve stdout for a structured protocol. Redirect
  // process.stdout.write to stderr to catch anything that bypasses our
  // own output path.
  const restoreStdout: (() => void) | null = silent ? redirectStdoutToStderr() : null;

  try {
    if (view.includes("/") || view.includes("\\")) {
      throw new Error(
        `ui-leaf: view '${view}' must be a bare identifier with no path separators`,
      );
    }

    if (data !== undefined && dataLoader) {
      throw new Error("ui-leaf: pass data or dataLoader, not both");
    }

    const token = randomBytes(32).toString("hex");

    // Eagerly invoke the loader before starting the server. The resolved
    // value lives only in this closure — it is never written to disk. If the
    // loader rejects, the setup-failure catch below restores stdout before
    // re-throwing.
    let loadedData: unknown;
    if (dataLoader) {
      loadedData = await dataLoader();
    }

    // Compile the view once at mount time; hold the resulting HTML in memory.
    const result = await compileView({
      entry: view,
      viewsRoot,
      data: dataLoader ? null : data,
      title,
      csp: cspHeader ?? undefined,
      token,
      dataLoader: !!dataLoader,
    });

    if (result.errors.length > 0) {
      const msg = result.errors.map((e) => e.message).join("; ");
      throw new Error(`ui-leaf: view compilation failed: ${msg}`);
    }

    // Mutable view state: the / handler reads from this on every request.
    // update(), swapView(), patch() mutate it in place.
    const viewState = { html: result.html, data: dataLoader ? loadedData : data };

    // Minimal event broker. Pre-seeded so fireEvent's get() always returns a Set.
    const listeners = new Map<DevServerEvent, Set<DevServerEventListener>>([
      ["data-updated", new Set()],
      ["view-swapped", new Set()],
      ["disconnected", new Set()],
      ["reconnected", new Set()],
    ]);
    function fireEvent(event: DevServerEvent): void {
      for (const fn of listeners.get(event)!) fn();
    }

    const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const sseEncoder = new TextEncoder();

    function broadcast(event: Record<string, unknown>): void {
      const frame = sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const controller of sseClients) {
        try {
          controller.enqueue(frame);
        } catch {
          sseClients.delete(controller);
        }
      }
    }

    let lastHeartbeatAt = Date.now();
    let closeRequested = false;
    let connectionState: ConnectionState = "connecting";
    let resolveClosed: (reason: CloseReason) => void = () => {};
    const closed = new Promise<CloseReason>((r) => {
      resolveClosed = r;
    });

    const bunPort = port === undefined ? 5810 : port; // port: 0 → OS picks
    let actualPort = bunPort;

    const handler = (req: Request): Response | Promise<Response> => {
      const host = req.headers.get("host") ?? undefined;
      const origin = req.headers.get("origin") ?? undefined;

      // DNS-rebinding gate: reject any request (including WebSocket upgrade
      // attempts) that does not arrive with an allowed Host. When Origin is
      // present, it must also be in the allowed set.
      const hostOk = isAllowedHost(host, allowedHostSet);
      const originOk = isAllowedOrigin(origin, allowedHostSet);
      if (!hostOk || !originOk) {
        const offender = !hostOk
          ? `Host "${host ?? "(absent)"}"`
          : `Origin "${origin}"`;
        return new Response(
          `ui-leaf: refusing request with ${offender} — only the following hostnames are accepted to prevent DNS rebinding: ${allowedHostList}. Open the server at http://localhost:${actualPort}/ or http://127.0.0.1:${actualPort}/, or pass { allowedHosts: ["my-alias"] } to mount() to permit a custom alias.\n`,
          { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }

      const headers: Record<string, string> = {};
      if (cspHeader) {
        headers["Content-Security-Policy"] = cspHeader;
      }

      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (method === "GET" && path === "/") {
        return new Response(viewState.html, {
          status: 200,
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (method === "POST" && path === "/heartbeat") {
        if (!checkAuth(req, token)) {
          return new Response("", { status: 401, headers });
        }
        lastHeartbeatAt = Date.now();
        if (connectionState === "disconnected") {
          connectionState = "connected";
          fireEvent("reconnected");
        } else if (connectionState === "connecting") {
          connectionState = "connected";
        }
        return new Response("", { status: 204, headers });
      }

      if (method === "POST" && path === "/mutate") {
        if (!checkAuth(req, token)) {
          return new Response("", { status: 401, headers });
        }
        return handleMutate(req, mutations, headers);
      }

      if (method === "GET" && path === "/api/data") {
        if (!dataLoader) {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { ...headers, "Content-Type": "application/json" },
          });
        }
        if (!checkAuth(req, token)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { ...headers, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(viewState.data !== undefined ? viewState.data : null), {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (method === "GET" && path === "/events") {
        if (!checkAuth(req, token)) {
          return new Response("", { status: 401, headers });
        }
        let sseController!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sseController = controller;
            sseClients.add(controller);
            // Enqueue an SSE comment immediately so Bun flushes response headers
            // before any broadcast event arrives (empty streams block header send).
            controller.enqueue(sseEncoder.encode(": connected\n\n"));
            req.signal?.addEventListener("abort", () => {
              sseClients.delete(sseController);
              try { sseController.close(); } catch { /* already closed */ }
            });
          },
          cancel() {
            sseClients.delete(sseController);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            ...headers,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      }

      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    };

    let heartbeatWatcher: NodeJS.Timeout | undefined;

    // `bunServer` is assigned immediately after this declaration by the IIFE
    // below. The `!` assertion is safe: cleanup is never called during server
    // construction, only after the server is running.
    let bunServer!: ReturnType<typeof Bun.serve>;

    // Chromium --app windows we spawned for this mount. Tracked so unmount
    // can tear them down — without this, every mount leaves an orphan
    // window when the host CLI exits, and they pile up across sessions.
    // Children are added by the launch path below and removed on their
    // own 'exit' (so a user-closed window doesn't stay in the set
    // indefinitely). cleanup() iterates and signals the survivors.
    // INVARIANT: nothing outside cleanup() may kill these. The heartbeat
    // watcher must never reach into this set — a minimized window pauses
    // heartbeats and would be killed under the user's feet otherwise.
    const trackedAppWindows = new Set<ChildProcess>();

    const cleanup = async (reason: CloseReason): Promise<void> => {
      if (closeRequested) return;
      closeRequested = true;
      if (heartbeatWatcher) clearInterval(heartbeatWatcher);
      broadcast({ type: "closing", reason });
      for (const controller of sseClients) {
        try { controller.close(); } catch { /* already closed */ }
      }
      sseClients.clear();
      // Tear down any --app windows we spawned. Done before bunServer.stop
      // so the window closes promptly even if the graceful HTTP shutdown
      // is slow (or stuck on a hung in-flight request).
      for (const child of trackedAppWindows) {
        killChromeTree(child, spawnImpl);
      }
      trackedAppWindows.clear();
      // Graceful stop: waits for in-flight writes (including the closing SSE
      // event) to flush before tearing down TCP connections.
      await bunServer.stop();
      if (restoreStdout) restoreStdout();
      resolveClosed(reason);
    };

    // Auto-bump: if bunPort is busy, try bunPort+1 … up to MAX_PORT_ATTEMPTS.
    // port: 0 goes straight to Bun (OS assigns a free port; never EADDRINUSE).
    // The Bun error callback fires for socket errors AND for unhandled throws in
    // the fetch handler. Either case routes through cleanup("error") so the mount
    // terminates cleanly rather than hanging. This means a single buggy request
    // handler is fatal — intentional: unhandled errors indicate broken invariants.
    const serverErrorHandler = (_err: Error): Response => {
      void cleanup("error");
      return new Response(JSON.stringify({ error: "internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    };
    bunServer = (() => {
      if (bunPort === 0) {
        return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler, error: serverErrorHandler, idleTimeout: 0 });
      }
      const MAX_PORT_ATTEMPTS = 10;
      for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
        try {
          return Bun.serve({ hostname: "127.0.0.1", port: bunPort + i, fetch: handler, error: serverErrorHandler, idleTimeout: 0 });
        } catch (err) {
          const isAddrinuse = err instanceof Error && err.message.includes("EADDRINUSE");
          if (!isAddrinuse || i === MAX_PORT_ATTEMPTS - 1) {
            if (isAddrinuse) {
              throw new Error(
                `ui-leaf: ports ${bunPort}–${bunPort + MAX_PORT_ATTEMPTS - 1} are all in use. Pass { port: 0 } to mount() for an OS-assigned port.`,
              );
            }
            throw err;
          }
        }
      }
      throw new Error("unreachable"); // TypeScript: loop always returns or throws
    })();
    actualPort = bunServer.port ?? bunPort;
    const url = `http://127.0.0.1:${actualPort}`;
    const startedAt = Date.now();

    heartbeatWatcher = setInterval(() => {
      if (closeRequested) return;
      const now = Date.now();
      if (now - startedAt < startupGraceMs) return;
      if (now - lastHeartbeatAt > heartbeatTimeoutMs) {
        if (connectionState !== "disconnected") {
          connectionState = "disconnected";
          fireEvent("disconnected");
        }
      }
    }, _heartbeatCheckIntervalMs);

    // The URL passed to the browser includes the token as a hash fragment so it
    // is never sent to the server (browsers strip fragments before HTTP requests).
    // The public `url` returned to consumers stays fragment-free.
    const openUrl = `${url}/#token=${token}`;

    // Browser-open implementation, or the test-seam override if one was supplied.
    const doOpen: () => Promise<void> = _opener
      ? () => _opener(openUrl)
      : async () => {
          if (shell === "app") {
            const child = await openInAppMode(
              openUrl,
              windowSize,
              profile?.dir,
              spawnImpl,
              fsAccessImpl,
            );
            if (child) {
              trackedAppWindows.add(child);
              // Drop the entry when Chrome exits on its own (user closed
              // the window, helper crash, etc.). Keeps the set bounded and
              // means cleanup() won't waste a signal on a dead PID.
              child.once("exit", () => trackedAppWindows.delete(child));
              return;
            }
            process.stderr.write(
              `ui-leaf: shell:"app" requested but no Chromium browser found; falling back to default browser tab.\n`,
            );
            await open(openUrl);
          } else {
            await open(openUrl);
          }
        };

    if (openBrowser) {
      await doOpen();
    }

    return {
      url,
      port: actualPort,
      closed,
      close: (reason: CloseReason = "caller") => cleanup(reason),
      on(event: DevServerEvent, listener: DevServerEventListener): void {
        listeners.get(event)?.add(listener);
      },
      off(event: DevServerEvent, listener: DevServerEventListener): void {
        listeners.get(event)?.delete(listener);
      },
      update(newData: unknown): void {
        viewState.data = newData;
        broadcast({ type: "data-updated", data: newData });
        fireEvent("data-updated");
      },
      async swapView(source: string): Promise<import("./compile.js").BuildError[]> {
        const r = await compileSource({
          source,
          data: viewState.data,
          title,
          csp: cspHeader ?? undefined,
          token,
        });
        if (r.errors.length > 0) return r.errors;
        viewState.html = r.html;
        broadcast({ type: "view-swapped" });
        fireEvent("view-swapped");
        return [];
      },
      async patch(newData: unknown, source: string): Promise<import("./compile.js").BuildError[]> {
        // Compile first with newData so the HTML embeds the incoming data.
        const r = await compileSource({
          source,
          data: newData,
          title,
          csp: cspHeader ?? undefined,
          token,
        });
        if (r.errors.length > 0) return r.errors;
        // Only mutate state on compile success (atomicity guarantee).
        viewState.data = newData;
        viewState.html = r.html;
        broadcast({ type: "data-updated", data: newData });
        broadcast({ type: "view-swapped" });
        fireEvent("data-updated");
        fireEvent("view-swapped");
        return [];
      },
      async reopen(): Promise<void> {
        await doOpen();
      },
    };
  } catch (err) {
    restoreStdout?.();
    throw err;
  }
}

// Custom header (not Authorization: Bearer) so any cross-origin fetch triggers
// a CORS preflight, which browsers block for non-same-origin callers without
// an explicit CORS allow list. This closes the simple-form-POST / no-preflight
// attack vector against the localhost dev server.
function checkAuth(req: Request, token: string): boolean {
  const value = req.headers.get("x-ui-leaf-token") ?? "";
  if (!value) return false;
  return timingSafeEqual(value, token);
}

async function handleMutate(
  req: Request,
  mutations: Record<string, MutationHandler<any, any>>,
  headers: Record<string, string>,
): Promise<Response> {
  // 1 MiB cap: Content-Length precheck short-circuits chunked / large bodies
  // before req.text() buffers them. req.text() still buffers the whole body
  // if Content-Length is absent or underreported — acceptable for this
  // loopback-only server, where the auth gate already runs first.
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > 1024 * 1024) {
    return new Response(JSON.stringify({ error: "request body exceeds 1 MiB limit" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  let body: { name?: string; args?: unknown };
  try {
    const text = await req.text();
    if (text.length > 1024 * 1024) {
      return new Response(JSON.stringify({ error: "request body exceeds 1 MiB limit" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    body = (text ? JSON.parse(text) : undefined) as typeof body;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "bad request" }),
      { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }

  const name = body?.name;
  if (typeof name !== "string" || name.length === 0) {
    return new Response(JSON.stringify({ error: "missing mutation name" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  if (!Object.hasOwn(mutations, name)) {
    return new Response(
      JSON.stringify({
        error: `ui-leaf: no mutation handler registered for '${name}'. Add it to the mutations: { } map passed to mount().`,
      }),
      { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }

  const handler = mutations[name]!;
  try {
    const result = await handler(body.args);
    return new Response(JSON.stringify(result ?? null), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
}
