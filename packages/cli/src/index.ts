// ui-leaf — Customizable browser views, on demand, for any CLI.
// https://github.com/OpenThinkAi/ui-leaf

import { resolve } from "node:path";
import {
  startDevServer,
  type CspOption,
  type DevServerEvent,
  type DevServerEventListener,
  type MutationHandler,
  type Shell,
} from "./server.js";
import type { BuildError } from "./compile.js";

export type { BuildError, CspOption, DevServerEvent, DevServerEventListener, MutationHandler, Shell };

export interface MountOptions {
  /** View name. Resolves to <viewsRoot>/<view>.tsx. */
  view: string;
  /**
   * JSON-serializable data passed to the view as a prop.
   *
   * Privacy note: the data is compiled into the HTML served at the mount URL
   * and held in memory for the mount lifetime. Any same-UID local process
   * that can reach `127.0.0.1:<port>` can fetch `GET /` and read it — the
   * per-launch token guards `/mutate` against drive-by cross-origin requests
   * in the browser, not against other processes on the machine. For PHI, PCI,
   * financial records, or anything where a same-UID local reader is in your
   * threat model, use `dataLoader` instead — the loader's return value is
   * served at a token-gated `/api/data` endpoint and never appears in the HTML.
   */
  data?: unknown;
  /**
   * Async function that supplies sensitive data to the view without
   * including it in the served HTML. When provided, the loader is called
   * once during mount setup; its resolved value is served at a token-gated
   * `GET /api/data` endpoint (same per-launch token as `/mutate`) and the
   * view fetches it on first render before calling `createRoot().render()`.
   * The data never appears in the compiled HTML.
   *
   * Use this instead of `data` for PHI, PCI, financial records, or anything
   * else where in-HTML data exposure is in your threat model.
   *
   * Error semantics: if the loader rejects, the rejection propagates to the
   * `mount()` caller (no automatic retry). Errors surface at mount time,
   * matching the synchronous `data` path's behavior.
   *
   * Mutual exclusion: passing both `data` and `dataLoader` throws at
   * mount time.
   */
  dataLoader?: () => Promise<unknown>;
  /**
   * Mutation handlers the view can call via mutate(name, args).
   * Each handler can self-type its args and return:
   *
   *   mutations: {
   *     recategorize: async (args: { id: string; category: string }) => {
   *       await db.recategorize(args.id, args.category);
   *       return { ok: true };
   *     },
   *   }
   *
   * Each request body is capped at 1 MiB; oversized POSTs are rejected
   * with a 400 and the view's mutate() promise rejects with a clear error.
   */
  // biome-ignore lint/suspicious/noExplicitAny: each handler has its own
  // arg/return types; the map can't share one shape.
  mutations?: Record<string, MutationHandler<any, any>>;
  /** Root directory holding view .tsx files. Defaults to <cwd>/views. */
  viewsRoot?: string;
  /** Browser tab title. Defaults to "ui-leaf". */
  title?: string;
  /**
   * Port to bind. Defaults to 5810 — unused by the major Node dev tools.
   * If the port is unavailable, ui-leaf bumps to the next free port and
   * the actual bound port is reflected on the returned `url` and `port`.
   * Pass `0` to let the OS pick a free port directly.
   * Override only if you need a stable URL (e.g. an external bookmark).
   */
  port?: number;
  /**
   * Open the browser when ready. Defaults to true. When false, mount()
   * returns the URL on its resolved value so the caller can drive a
   * headless browser, log the address, etc.
   */
  openBrowser?: boolean;
  /**
   * Browser shell. Defaults to "tab".
   *
   * - `"tab"` — open in the user's default browser as a regular tab.
   *   Works everywhere; URL bar is visible.
   *
   * - `"app"` — try Chromium's `--app` mode for a chromeless window
   *   (no URL bar, no tabs, looks like a desktop app). Available on
   *   Chrome, Edge, and Brave. If no Chromium browser is installed,
   *   ui-leaf falls back to "tab" with a stderr note. Safari and
   *   Firefox always fall back.
   *
   * Pair with the share-link pattern (see "Sharing views across users"
   * in the README) when you want users to never see a localhost URL.
   */
  shell?: Shell;
  /**
   * Abort to close the dev server early. The returned `closed` promise
   * resolves either way; if you need to distinguish a signal-driven close
   * from a natural tab-close, check `signal.aborted` after the await.
   */
  signal?: AbortSignal;
  /**
   * Browser silence (ms) that triggers shutdown after the startup grace
   * window. Defaults to 75000 — chosen to survive a single browser
   * background-tab throttle (browsers clamp setInterval in hidden tabs to
   * roughly once per minute). Lower it if you want faster shutdown on tab
   * close; raise it if your debugger pauses the page or your machine
   * sleeps mid-session.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Content-Security-Policy enforcement. Defaults to "off".
   *
   * - `"off"` — no CSP header sent. Views can fetch arbitrary URLs and
   *   embed external resources freely. The data/mutations convention is
   *   honor-system.
   *
   * - `"strict"` — ui-leaf sends a balanced preset: locks `connect-src`
   *   to same-origin (the architectural lock — views cannot fetch
   *   external APIs, so all data flows through `data` and `mutations`),
   *   while permitting common needs (HTTPS images / fonts, inline
   *   styles for React). View files can only *add* further restrictions
   *   via meta tag, never remove them.
   *
   * - `string` — raw CSP header value for full control. Use when the
   *   "strict" preset doesn't fit (e.g. you need `connect-src` to
   *   include a Sentry endpoint).
   *
   * Trade-off: when set to "strict" or a custom string, a view file
   * cannot relax the policy at runtime. Switching back requires changing
   * the mount() call. That rigidity is a feature.
   */
  csp?: CspOption;
  /**
   * Extra hostnames accepted in the request `Host` and `Origin` headers
   * on top of the built-in loopback set (`localhost`, `127.0.0.1`, `[::1]`).
   *
   * The dev server gates every request on this set to defend against
   * DNS-rebinding attacks; non-matching requests get HTTP 403. Use this
   * escape hatch when you need to reach the dev server through a custom
   * `/etc/hosts` alias (e.g. `["my-app.local"]`) or any other loopback
   * name. Hostnames are matched case-insensitively, port-agnostic.
   *
   * Be deliberate: any hostname you add becomes a viable DNS-rebinding
   * target. Don't add wildcards, public DNS names, or LAN hostnames you
   * don't fully control.
   */
  allowedHosts?: string[];
  /**
   * Suppress ui-leaf output to stdout. Default: false.
   *
   * When you drive `mount()` programmatically — e.g. as part of a Node
   * bridge for a non-Node CLI that's spawned ui-leaf as a subprocess —
   * stdout is usually reserved for a structured protocol (line-delimited
   * JSON, etc.). Setting `silent: true` redirects `process.stdout.write`
   * to `process.stderr` for the lifetime of the server, restored on close.
   *
   * Tradeoff: any other code in the same process that writes to stdout
   * during the server's lifetime is also redirected. Hold the captured
   * `process.stdout.write` reference yourself if you need to write to the
   * real stdout from the same process.
   */
  silent?: boolean;
  /**
   * Grace period (ms) after server start before the heartbeat watcher arms.
   * Cold-loading clients sometimes take a few seconds to send their first
   * heartbeat. Defaults to 30000.
   *
   * If no client connects within (startupGraceMs + heartbeatTimeoutMs),
   * the server shuts down on its own.
   */
  startupGraceMs?: number;
}

export interface MountedView {
  /** URL the view is reachable at (http://127.0.0.1:<port>). */
  url: string;
  /** Bound port. Useful when port: 0 was requested. */
  port: number;
  /** Resolves when the view closes (heartbeat timeout) or close() is called. */
  closed: Promise<void>;
  /** Force-close the dev server early. */
  close: () => Promise<void>;
  /**
   * Replace in-memory data and notify all `data-updated` listeners.
   * Preserves in-page React state — no recompile.
   */
  update: (data: unknown) => void;
  /**
   * Swap the view source on the fly. Triggers a recompile; on success replaces
   * the served HTML and notifies all `view-swapped` listeners. On compile
   * failure the previous HTML is preserved. Returns compile errors if any.
   */
  swapView: (source: string) => Promise<BuildError[]>;
  /**
   * Atomically replace both data and view source. If compilation fails neither
   * takes effect. Returns compile errors if any.
   */
  patch: (data: unknown, source: string) => Promise<BuildError[]>;
  /**
   * Re-invoke the browser-open function to launch a fresh tab at the same URL.
   * Always opens a new tab — if one is already connected, a duplicate opens.
   */
  reopen: () => Promise<void>;
  /** Subscribe to a server-side event (data-updated | view-swapped). */
  on: (event: DevServerEvent, listener: DevServerEventListener) => void;
  /** Unsubscribe a previously-registered listener. */
  off: (event: DevServerEvent, listener: DevServerEventListener) => void;
}

/**
 * Mount a customizable browser view from a CLI. Spins up a local dev server
 * and renders the chosen view with the given data. Returns once the server
 * is ready; await `result.closed` to block until the user closes the
 * browser tab.
 *
 * Mutations triggered in the view are dispatched to the registered handlers
 * here; the view never reaches the CLI's backing API directly.
 *
 * Multi-tab note: if the user opens the served URL in additional tabs (or
 * duplicates the tab), each tab heartbeats independently and the server
 * stays alive while *any* tab is open. Closing the original tab does not
 * shut down the CLI if a duplicate is still loaded.
 *
 * Ctrl+C: this function installs SIGINT and SIGTERM handlers that close
 * the server before exiting.
 */
export async function mount(opts: MountOptions): Promise<MountedView> {
  const viewsRoot = opts.viewsRoot ?? resolve(process.cwd(), "views");

  const server = await startDevServer({
    view: opts.view,
    data: opts.data,
    dataLoader: opts.dataLoader,
    viewsRoot,
    mutations: opts.mutations,
    title: opts.title,
    port: opts.port,
    openBrowser: opts.openBrowser,
    shell: opts.shell,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    startupGraceMs: opts.startupGraceMs,
    csp: opts.csp,
    allowedHosts: opts.allowedHosts,
    silent: opts.silent,
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      await server.close();
      // Re-raise so default exit codes still apply.
      process.kill(process.pid, signal);
    })();
  };
  const sigint = (): void => onSignal("SIGINT");
  const sigterm = (): void => onSignal("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);

  if (opts.signal) {
    if (opts.signal.aborted) {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      await server.close();
      return {
        url: server.url,
        port: server.port,
        closed: Promise.resolve(),
        close: server.close,
      };
    }
    opts.signal.addEventListener(
      "abort",
      () => void server.close(),
      { once: true },
    );
  }

  const closed = server.closed.finally(() => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  });

  return {
    url: server.url,
    port: server.port,
    closed,
    close: server.close,
    update: server.update.bind(server),
    swapView: (source: string) => server.swapView(source),
    patch: (data: unknown, source: string) => server.patch(data, source),
    reopen: server.reopen.bind(server),
    on: server.on.bind(server),
    off: server.off.bind(server),
  };
}
