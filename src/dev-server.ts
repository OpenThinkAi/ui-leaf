// Spike: dev server with mutation bridge + heartbeat-based shutdown.
// Builds on Spike #1; adds the bridge that makes ui-leaf actually useful.

import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import open, { apps } from "open";

// Resolve react / react-dom from ui-leaf's installed location using
// Node's actual resolver. With hoisting (npm/pnpm/bun), these end up in
// the consumer's top-level node_modules, NOT under ui-leaf/node_modules.
// Aliasing the resolved directory paths in rspack lets the bundled view
// always find react no matter where the package manager put it.
const uiLeafRequire = createRequire(import.meta.url);
const reactPath = dirname(uiLeafRequire.resolve("react/package.json"));
const reactDomPath = dirname(uiLeafRequire.resolve("react-dom/package.json"));

// Module-level stdout redirect state. Captured ONCE at module load so
// concurrent silent: true mounts share the same "original" reference and
// restore-order doesn't matter. Refcounted so the last close restores.
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
let stdoutRedirectCount = 0;

/**
 * Ask the OS for a free port and return it. Used when the consumer
 * requests `port: 0`. There's a small race window between close() and
 * rsbuild's bind, but in practice it's never been an issue for dev
 * tooling.
 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        reject(new Error("ui-leaf: failed to obtain a free port from the OS"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

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

/**
 * Try to open `url` in a Chromium browser's --app mode (chromeless window:
 * no URL bar, no tabs). Returns true if a Chromium browser was found and
 * launched, false if no Chromium variant is installed (caller should fall
 * back to the default-browser tab).
 */
async function openInAppMode(url: string): Promise<boolean> {
  // Order: most-common Chromium variants first.
  const candidates = [apps.chrome, apps.edge, apps.brave];
  for (const app of candidates) {
    try {
      await open(url, { app: { name: app, arguments: [`--app=${url}`] } });
      return true;
    } catch {
      // Try next candidate; `open` throws if the binary isn't installed.
    }
  }
  return false;
}

/**
 * Strict preset: locks `connect-src` to same-origin (the architectural
 * lock that forces views to route mutations through the CLI), while
 * permitting common needs (HTTPS images/fonts, inline styles for React,
 * eval/inline-scripts for rsbuild's HMR client). A future "production"
 * mode could ship a tighter preset once HMR isn't in the picture.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
].join("; ");

function resolveCsp(opt: CspOption | undefined): string | null {
  if (!opt || opt === "off") return null;
  if (opt === "strict") return STRICT_CSP;
  return opt;
}

export interface DevServerOptions {
  view: string;
  data: unknown;
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
  /** Heartbeat-stop window in ms. Browser silence longer than this triggers shutdown. */
  heartbeatTimeoutMs?: number;
  /** Grace period after server start before the heartbeat watcher is armed. */
  startupGraceMs?: number;
  /** Content-Security-Policy enforcement. See MountOptions.csp. */
  csp?: CspOption;
  /**
   * Suppress ui-leaf / rsbuild output to stdout. When true:
   * - rsbuildConfig.logLevel is set to 'silent' (no banner, build, or
   *   deprecation messages)
   * - process.stdout.write is redirected to process.stderr for the
   *   lifetime of the dev server, restored on close()
   *
   * Use when driving mount() programmatically and stdout is reserved for
   * a structured protocol (e.g. line-delimited JSON to a parent process).
   * Default: false.
   */
  silent?: boolean;
}

export interface DevServer {
  url: string;
  port: number;
  /** Resolves when the view is closed (heartbeat timeout) or close() is called. */
  closed: Promise<void>;
  close: () => Promise<void>;
}

function escapeForScriptTag(json: string): string {
  // Defend against </script> break-out and U+2028 / U+2029 line terminators
  // that JSON.stringify emits raw but JS string literals don't accept.
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // 1 MiB cap per request — protects against accidental huge payloads.
    if (total > 1024 * 1024) {
      throw new Error("request body exceeds 1 MiB limit");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  // Length check is not timing-safe but is fine — the token length is fixed
  // and known to attackers regardless. The byte compare must be timing-safe.
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const {
    view,
    data,
    viewsRoot,
    mutations = {},
    title = "ui-leaf",
    port,
    openBrowser = true,
    shell = "tab",
    heartbeatTimeoutMs = 75_000,
    startupGraceMs = 30_000,
    csp,
    silent = false,
  } = opts;
  const cspHeader = resolveCsp(csp);

  // Resolve port: 0 means "let the OS pick" — but rsbuild doesn't honor
  // port: 0 (it literally binds to 0 and reports back 0). Pre-allocate a
  // free port via Node's net layer and pass that explicit port to rsbuild
  // instead. Default 5810 if no port specified.
  const resolvedPort = port === 0 ? await findFreePort() : (port ?? 5810);

  // Programmatic consumers (esp. non-Node CLIs spawning ui-leaf as a
  // subprocess) often reserve stdout for a structured protocol. Belt-and-
  // -suspenders: rsbuild's logLevel:'silent' catches its own logger output,
  // and process.stdout.write is redirected to stderr to catch anything
  // that bypasses rsbuild's logger (banner before logger init, third-party
  // module writes, etc.).
  const restoreStdout: (() => void) | null = silent ? redirectStdoutToStderr() : null;

  try {
  if (view.includes("/") || view.includes("\\")) {
    throw new Error(
      `ui-leaf: view '${view}' must be a bare identifier with no path separators`,
    );
  }
  const viewsRootAbs = resolve(viewsRoot);
  const viewAbs = resolve(viewsRootAbs, `${view}.tsx`);
  if (!viewAbs.startsWith(viewsRootAbs + sep)) {
    throw new Error(
      `ui-leaf: view '${view}' resolves outside viewsRoot`,
    );
  }
  try {
    await stat(viewAbs);
  } catch {
    throw new Error(
      `ui-leaf: view '${view}' not found at ${viewAbs} (looked for .tsx; viewsRoot=${viewsRoot})`,
    );
  }

  const token = randomBytes(32).toString("hex");
  const tempDir = await mkdtemp(join(tmpdir(), "ui-leaf-"));

  const entryPath = join(tempDir, "entry.tsx");
  await writeFile(
    entryPath,
    `import { createRoot } from "react-dom/client";
import View from ${JSON.stringify(viewAbs)};

const ctx = (globalThis).__UI_LEAF__ || {};
const data = ctx.data;
const token = ctx.token;

async function mutate(name, args) {
  const res = await fetch("/mutate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ name, args }),
  });
  const text = await res.text().catch(function () { return ""; });
  if (!res.ok) {
    var detail = text;
    try {
      var parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
        detail = parsed.error;
      }
    } catch (_) { /* keep raw text */ }
    throw new Error("ui-leaf: mutation '" + name + "' failed (" + res.status + "): " + detail);
  }
  return text ? JSON.parse(text) : undefined;
}

async function heartbeat() {
  try {
    await fetch("/heartbeat", {
      method: "POST",
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
  } catch {
    /* server may have shut down; ignore */
  }
}
setInterval(heartbeat, 5000);
heartbeat();

const el = document.getElementById("root");
if (!el) throw new Error("ui-leaf: #root element missing");
createRoot(el).render(<View data={data} mutate={mutate} />);
`,
  );

  const dataInline = escapeForScriptTag(JSON.stringify(data));
  const tokenInline = JSON.stringify(token);
  const titleEscaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const htmlPath = join(tempDir, "index.html");
  await writeFile(
    htmlPath,
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${titleEscaped}</title>
    <script>window.__UI_LEAF__ = { data: ${dataInline}, token: ${tokenInline} };</script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  );

  let lastHeartbeatAt = Date.now();
  let closeRequested = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  function checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    return timingSafeEqual(match[1]!, token);
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  const rsbuild = await createRsbuild({
    cwd: tempDir,
    rsbuildConfig: {
      plugins: [pluginReact()],
      ...(silent ? { logLevel: "silent" as const } : {}),
      source: { entry: { index: entryPath } },
      // 5810 is unused by the major Node dev tools (vite=5173, parcel=1234,
      // webpack=8080, next/CRA=3000). rsbuild auto-bumps to the next free
      // port if 5810 is busy, so collisions are graceful.
      server: { port: resolvedPort, host: "127.0.0.1" },
      // Note: `dev.setupMiddlewares` is deprecated as of rsbuild 2.x in
      // favor of `server.setup`, but the new API has a different signature
      // and bypasses the rsbuild CSRF middleware in ways that break our
      // POST endpoints. Sticking with the deprecated path for v1.
      dev: {
        setupMiddlewares: [
          (middlewares) => {
            middlewares.unshift(async (req, res, next) => {
              const url = req.url ?? "";
              if (req.method === "POST" && url === "/heartbeat") {
                if (!checkAuth(req)) {
                  sendJson(res, 401, { error: "unauthorized" });
                  return;
                }
                lastHeartbeatAt = Date.now();
                sendJson(res, 204, undefined);
                return;
              }
              if (req.method === "POST" && url === "/mutate") {
                if (!checkAuth(req)) {
                  sendJson(res, 401, { error: "unauthorized" });
                  return;
                }
                let body: { name?: string; args?: unknown };
                try {
                  body = (await readJsonBody(req)) as typeof body;
                } catch (err) {
                  sendJson(res, 400, {
                    error: err instanceof Error ? err.message : "bad request",
                  });
                  return;
                }
                const name = body?.name;
                if (typeof name !== "string" || name.length === 0) {
                  sendJson(res, 400, { error: "missing mutation name" });
                  return;
                }
                if (!Object.hasOwn(mutations, name)) {
                  sendJson(res, 404, {
                    error: `ui-leaf: no mutation handler registered for '${name}'. Add it to the mutations: { } map passed to mount().`,
                  });
                  return;
                }
                const handler = mutations[name]!;
                try {
                  const result = await handler(body.args);
                  sendJson(res, 200, result ?? null);
                } catch (err) {
                  sendJson(res, 500, {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
                return;
              }
              next();
            });
            // CSP middleware unshifts AFTER the route handler so it ends up
            // at index 0 — runs first on every request, sets the header,
            // then yields to the route or rsbuild static handlers. No-op
            // when csp resolves to null (the "off" default).
            if (cspHeader) {
              middlewares.unshift((_req, res, next) => {
                res.setHeader("Content-Security-Policy", cspHeader);
                next();
              });
            }
          },
        ],
      },
      html: { template: htmlPath },
      tools: {
        rspack: {
          resolve: {
            alias: {
              react: reactPath,
              "react-dom": reactDomPath,
            },
          },
        },
      },
    },
  });

  const devServer = await rsbuild.startDevServer();
  const actualPort = devServer.port;
  const url = `http://127.0.0.1:${actualPort}`;
  const startedAt = Date.now();

  let heartbeatWatcher: NodeJS.Timeout | undefined;

  const cleanup = async (): Promise<void> => {
    if (closeRequested) return;
    closeRequested = true;
    if (heartbeatWatcher) clearInterval(heartbeatWatcher);
    await devServer.server.close();
    await rm(tempDir, { recursive: true, force: true });
    if (restoreStdout) restoreStdout();
    resolveClosed();
  };

  heartbeatWatcher = setInterval(() => {
    const now = Date.now();
    if (now - startedAt < startupGraceMs) return;
    if (now - lastHeartbeatAt > heartbeatTimeoutMs) {
      void cleanup();
    }
  }, 1000);

  if (openBrowser) {
    if (shell === "app") {
      const launched = await openInAppMode(url);
      if (!launched) {
        process.stderr.write(
          `ui-leaf: shell:"app" requested but no Chromium browser found; falling back to default browser tab.\n`,
        );
        await open(url);
      }
    } else {
      await open(url);
    }
  }

  return {
    url,
    port: actualPort,
    closed,
    close: cleanup,
  };
  } catch (err) {
    // If setup fails before the dev server's close() is wired up, the
    // caller never gets a close to call. Restore stdout on the throw
    // path; the success path restores via cleanup() on close().
    restoreStdout?.();
    throw err;
  }
}
