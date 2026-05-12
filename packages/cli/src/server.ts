import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import open, { apps } from "open";
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

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
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
 * no URL bar, no tabs). Returns true if a Chromium browser was found and
 * launched, false if no Chromium variant is installed (caller should fall
 * back to the default-browser tab).
 *
 * **macOS direct-spawn path** (ui-leaf#55): on macOS the `open` library
 * shells out to `/usr/bin/open -a "Google Chrome" --args …`. When Chrome
 * is already running with the user's default profile, that delivers an
 * AppleEvent to the existing instance which silently drops the `--args`
 * (only fresh-launch `main()` receives them), so `--app=URL` is ignored
 * and the URL opens in a normal tab — no chromeless window appears. The
 * fix is to spawn the bundle binary directly via `child_process.spawn`,
 * bypassing `/usr/bin/open` entirely, plus pass `--user-data-dir=<tmp>`
 * to a fresh per-mount temp profile so Chrome opens a separate process
 * (single-instance lock is per-profile) and `--app=` actually takes
 * effect.
 *
 * **Linux/Windows path**: defer to the `open` library, which spawns the
 * browser binary directly on those platforms (not through a LaunchServices
 * shim), so launch args reach the new Chrome process on cold launch.
 * `--user-data-dir=<tmp>` is still useful here for isolation and to dodge
 * any single-instance behaviour.
 *
 * **Crash containment** (ui-leaf#54): the spawned ChildProcess can emit a
 * delayed `'error'` event post-spawn (Chromium rejecting the launch flags,
 * helper binary exiting non-zero after delivering its message). Node
 * promotes unhandled `'error'` to `uncaughtException` and kills the host;
 * we attach a no-op listener and `unref()` the child so launcher failures
 * stay contained.
 *
 * Set `UI_LEAF_DEBUG=1` (env var, opt-in) to emit a stderr breadcrumb each
 * time the silenced `'error'` fires.
 *
 * **Profile leak**: a successful launch leaves a fresh user-data-dir under
 * `os.tmpdir()` (macOS `/var/folders/.../T`, Linux `/tmp`, Windows
 * `%TEMP%`) and intentionally does not clean it up — Chrome is unref'd
 * and the host has no reliable signal for "Chrome closed this profile,"
 * and deleting the dir while Chrome is still using it would corrupt the
 * live window. The OS reaps tmpdir periodically (macOS does this every
 * ~3 days; Linux on reboot or via systemd-tmpfiles); the profile state
 * is small (single window, no extensions) so accumulation is bounded.
 * When the function returns false (no Chromium found), the just-created
 * dir is removed before returning so a caller-side fallback to a
 * default-browser tab doesn't leak an empty profile.
 */
async function openInAppMode(url: string): Promise<boolean> {
  // Defensive: openUrl is server-constructed today (http://127.0.0.1:port/
  // #token=...), but a future refactor could change that. Reject anything
  // that isn't an http(s) URL so a stray `data:` or `javascript:` can't
  // be smuggled into a chromeless window (no URL bar to warn the user).
  if (!/^https?:\/\//i.test(url)) return false;

  // Each mount gets its own --user-data-dir so Chrome opens a separate
  // process and the chromeless window stays isolated from the user's
  // primary session. See docstring for the full rationale.
  const userDataDir = await mkdtemp(join(tmpdir(), "ui-leaf-chrome-"));
  const launchArgs = [
    `--app=${url}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Helper: remove the user-data-dir when we fall through without launching.
  const cleanupProfile = async (): Promise<void> => {
    try {
      await rm(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS reaper handles anything we miss.
    }
  };

  if (process.platform === "darwin") {
    for (const binPath of MACOS_CHROMIUM_BINARIES) {
      if (!(await isExecutable(binPath))) continue;
      try {
        const child = spawn(binPath, launchArgs, {
          detached: true,
          stdio: "ignore",
        });
        attachLauncherErrorListener(child, binPath);
        child.unref();
        return true;
      } catch {
        // Spawn can throw synchronously on EPERM, ENOENT-after-access-race, etc.
        // Try the next candidate.
      }
    }
    await cleanupProfile();
    return false;
  }

  // Linux / Windows: defer to the `open` library, which spawns the browser
  // binary directly (no LaunchServices shim) so launch args are honored.
  const candidates = [apps.chrome, apps.edge, apps.brave];
  for (const app of candidates) {
    try {
      const child = (await open(url, { app: { name: app, arguments: launchArgs } })) as
        | ChildProcess
        | undefined;
      attachLauncherErrorListener(child, app);
      child?.unref?.();
      return true;
    } catch {
      // Try next candidate; `open` throws if the binary isn't installed.
    }
  }
  await cleanupProfile();
  return false;
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
    heartbeatTimeoutMs = 5_000,
    startupGraceMs = 30_000,
    csp = "strict",
    allowedHosts,
    silent = false,
    _opener,
    _heartbeatCheckIntervalMs = 1000,
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

    const cleanup = async (reason: CloseReason): Promise<void> => {
      if (closeRequested) return;
      closeRequested = true;
      if (heartbeatWatcher) clearInterval(heartbeatWatcher);
      broadcast({ type: "closing", reason });
      for (const controller of sseClients) {
        try { controller.close(); } catch { /* already closed */ }
      }
      sseClients.clear();
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
            const launched = await openInAppMode(openUrl);
            if (!launched) {
              process.stderr.write(
                `ui-leaf: shell:"app" requested but no Chromium browser found; falling back to default browser tab.\n`,
              );
              await open(openUrl);
            }
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
