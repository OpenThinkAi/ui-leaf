// Spike: dev server with mutation bridge + heartbeat-based shutdown.
// Builds on Spike #1; adds the bridge that makes ui-leaf actually useful.

import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import open from "open";

// Resolve react / react-dom from ui-leaf's installed location using
// Node's actual resolver. With hoisting (npm/pnpm/bun), these end up in
// the consumer's top-level node_modules, NOT under ui-leaf/node_modules.
// Aliasing the resolved directory paths in rspack lets the bundled view
// always find react no matter where the package manager put it.
const uiLeafRequire = createRequire(import.meta.url);
const reactPath = dirname(uiLeafRequire.resolve("react/package.json"));
const reactDomPath = dirname(uiLeafRequire.resolve("react-dom/package.json"));

export type MutationHandler = (args: unknown) => unknown | Promise<unknown>;

export interface DevServerOptions {
  view: string;
  data: unknown;
  viewsRoot: string;
  mutations?: Record<string, MutationHandler>;
  /** Browser tab title. Defaults to "ui-leaf". */
  title?: string;
  port?: number;
  openBrowser?: boolean;
  /** Heartbeat-stop window in ms. Browser silence longer than this triggers shutdown. */
  heartbeatTimeoutMs?: number;
  /** Grace period after server start before the heartbeat watcher is armed. */
  startupGraceMs?: number;
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
    heartbeatTimeoutMs = 75_000,
    startupGraceMs = 30_000,
  } = opts;

  const viewAbs = resolve(viewsRoot, `${view}.tsx`);
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
      source: { entry: { index: entryPath } },
      server: { port: port ?? 3000, host: "127.0.0.1" },
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
    await open(url);
  }

  return {
    url,
    port: actualPort,
    closed,
    close: cleanup,
  };
}
