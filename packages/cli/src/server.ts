import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import open, { apps } from "open";
import { compileView } from "./compile.js";

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
 * permitting common needs (HTTPS images/fonts, inline styles for React).
 * A future v1.x mode could tighten script-src once usage patterns are known.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
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
  /** Heartbeat-stop window in ms. Browser silence longer than this triggers shutdown. */
  heartbeatTimeoutMs?: number;
  /** Grace period after server start before the heartbeat watcher is armed. */
  startupGraceMs?: number;
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
}

export interface DevServer {
  url: string;
  port: number;
  /** Resolves when the view is closed (heartbeat timeout) or close() is called. */
  closed: Promise<void>;
  close: () => Promise<void>;
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
    heartbeatTimeoutMs = 75_000,
    startupGraceMs = 30_000,
    csp,
    allowedHosts,
    silent = false,
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

    const html = result.html;

    let lastHeartbeatAt = Date.now();
    let closeRequested = false;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });

    const bunPort = port === undefined ? 5810 : port; // port: 0 → OS picks
    let actualPort = bunPort;
    // Auto-bump: if bunPort is busy, try bunPort+1 … up to MAX_PORT_ATTEMPTS.
    // port: 0 goes straight to Bun (OS assigns a free port; never EADDRINUSE).
    const server = (() => {
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
          return new Response(html, {
            status: 200,
            headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (method === "POST" && path === "/heartbeat") {
          if (!checkAuth(req, token)) {
            return new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { ...headers, "Content-Type": "application/json" },
            });
          }
          lastHeartbeatAt = Date.now();
          return new Response("", { status: 204, headers });
        }

        if (method === "POST" && path === "/mutate") {
          if (!checkAuth(req, token)) {
            return new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { ...headers, "Content-Type": "application/json" },
            });
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
          return new Response(JSON.stringify(loadedData !== undefined ? loadedData : null), {
            status: 200,
            headers: { ...headers, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      };
      if (bunPort === 0) {
        return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
      }
      const MAX_PORT_ATTEMPTS = 10;
      for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
        try {
          return Bun.serve({ hostname: "127.0.0.1", port: bunPort + i, fetch: handler });
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

    actualPort = server.port ?? bunPort;
    const url = `http://127.0.0.1:${actualPort}`;
    const startedAt = Date.now();

    let heartbeatWatcher: NodeJS.Timeout | undefined;

    const cleanup = async (): Promise<void> => {
      if (closeRequested) return;
      closeRequested = true;
      if (heartbeatWatcher) clearInterval(heartbeatWatcher);
      await server.stop(true);
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
    restoreStdout?.();
    throw err;
  }
}

function checkAuth(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(match[1]!, token);
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
