// ui-leaf — Customizable browser views, on demand, for any CLI.
// https://github.com/OpenThinkAi/ui-leaf

import { resolve } from "node:path";
import {
  startDevServer,
  type CspOption,
  type MutationHandler,
} from "./dev-server.js";

export type { CspOption, MutationHandler };

export interface MountOptions {
  /** View name. Resolves to <viewsRoot>/<view>.tsx. */
  view: string;
  /** JSON-serializable data passed to the view as a prop. */
  data: unknown;
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
   *   styles for React, eval for rsbuild HMR). View files can only
   *   *add* further restrictions via meta tag, never remove them.
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
   * Grace period (ms) after server start before the heartbeat watcher arms.
   * Cold-loading clients sometimes take a few seconds to send their first
   * heartbeat. Defaults to 30000.
   *
   * If no client connects within (startupGraceMs + heartbeatTimeoutMs),
   * the server shuts down on its own.
   */
  startupGraceMs?: number;
  // Note: a `shell: "tab" | "app"` option (Chrome --app chromeless window)
  // was deferred from this release; v1 supports only the default
  // browser-tab shell.
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
 * the dev server (and clean up its temp directory) before exiting.
 */
export async function mount(opts: MountOptions): Promise<MountedView> {
  const viewsRoot = opts.viewsRoot ?? resolve(process.cwd(), "views");

  const server = await startDevServer({
    view: opts.view,
    data: opts.data,
    viewsRoot,
    mutations: opts.mutations,
    title: opts.title,
    port: opts.port,
    openBrowser: opts.openBrowser,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    startupGraceMs: opts.startupGraceMs,
    csp: opts.csp,
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
  };
}
