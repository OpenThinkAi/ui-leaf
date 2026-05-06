import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { BunPlugin } from "bun";
import { escapeForScriptTag } from "./internal/html.js";

// Resolve React imports at module load — works under bun test / bun run.
// NOTE: under bun build --compile (binary mode), createRequire() resolves from
// the binary's embedded virtual filesystem. AGT-131 (cross-compile script)
// will need a Bun.build plugin or Bun embedded-files to ensure React is
// reachable inside the compiled binary. Flagging here so AGT-131 is not blindsided.
const requireFromHere = createRequire(import.meta.url);

// BunPlugin that rewrites bare react/react-dom imports to absolute paths
// under ui-leaf's installed node_modules. Ensures the bundled view always
// finds the same React instance regardless of the consumer's package-manager
// hoisting, and prevents duplicate React instances across views.
const reactAliasPlugin: BunPlugin = {
  name: "ui-leaf-react-alias",
  setup(build) {
    // Matches: react, react/jsx-runtime, react/jsx-dev-runtime,
    //          react-dom, react-dom/client, react-dom/profiling, etc.
    build.onResolve({ filter: /^react($|\/|-dom($|\/))/ }, (args) => {
      try {
        return { path: requireFromHere.resolve(args.path) };
      } catch {
        return {
          path: args.path,
          errors: [{ text: `ui-leaf: failed to resolve ${args.path}` }],
        };
      }
    });
  },
};

export interface BuildError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface CompileOptions {
  /** View name or path relative to viewsRoot (e.g. "dashboard" or "dashboard.tsx"). */
  entry: string;
  /** Root directory holding .tsx view files. */
  viewsRoot: string;
  /** JSON-serializable data injected as window.__UI_LEAF__.data. Ignored when dataLoader is true. */
  data?: unknown;
  /** Browser tab title. Defaults to "ui-leaf". */
  title?: string;
  /**
   * Raw CSP string to emit as a <meta http-equiv="Content-Security-Policy"> tag.
   * Undefined / absent means no CSP meta tag is emitted.
   */
  csp?: string;
  /**
   * Extra allowed hostnames (beyond loopback defaults). Accepted in the
   * option bag for API symmetry with DevServerOptions; has no compile-time
   * effect — the runtime DNS-rebinding gate lives in the server.
   */
  allowedHosts?: string[];
  /**
   * Per-launch auth token. Accepted for API symmetry with DevServerOptions;
   * the token is no longer embedded in HTML — it is delivered via the URL
   * fragment and read by the inline bootstrap script.
   */
  token?: string;
  /**
   * When true, generate an entry that fetches data from GET /api/data at
   * render time rather than reading it from window.__UI_LEAF__.data. The
   * compiled HTML bootstrap omits the data field (only token is included).
   * Use when data is sensitive and must not be written to the HTML file.
   */
  dataLoader?: boolean;
}

/**
 * Options for compiling an inline TSX source string.
 *
 * v1.0.0 constraint: `source` is treated as a self-contained TSX string.
 * Relative imports are not supported — the string has no filesystem context
 * to resolve them against. Bare-package imports (react, react-dom) work via
 * the react-alias plugin. This is the intended contract for IPC-driven
 * view hot-swaps (AI-generated self-contained components).
 */
export interface CompileSourceOptions {
  /** Raw TSX source string to compile. Must be a self-contained component. */
  source: string;
  /** JSON-serializable data injected as window.__UI_LEAF__.data. */
  data?: unknown;
  /** Browser tab title. Defaults to "ui-leaf". */
  title?: string;
  /** Raw CSP string. Undefined / absent means no CSP meta tag. */
  csp?: string;
  /**
   * Per-launch auth token. Accepted for API symmetry; not embedded in HTML —
   * see CompileOptions.token.
   */
  token?: string;
}

export interface CompileResult {
  html: string;
  errors: BuildError[];
}

// Shared bridge injected into every compiled entry: mutation + heartbeat.
const SHARED_BRIDGE = `
async function mutate(name: string, args?: unknown): Promise<unknown> {
  const res = await fetch("/mutate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-UI-Leaf-Token": token } : {}),
    },
    body: JSON.stringify({ name, args }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = text;
    try {
      const parsed: unknown = text ? JSON.parse(text) : null;
      if (parsed !== null && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string") {
        detail = (parsed as { error: string }).error;
      }
    } catch { /* keep raw text */ }
    throw new Error("ui-leaf: mutation '" + name + "' failed (" + res.status + "): " + detail);
  }
  return text ? JSON.parse(text) : undefined;
}

async function heartbeat(): Promise<void> {
  try {
    await fetch("/heartbeat", {
      method: "POST",
      headers: token ? { "X-UI-Leaf-Token": token } : {},
    });
  } catch { /* server may have shut down; ignore */ }
}
setInterval(heartbeat, 5000);
heartbeat();`;

/** Run Bun.build on `entryPath` and return the raw JS output or errors. */
async function runBunBuild(entryPath: string): Promise<{ js: string } | { errors: BuildError[] }> {
  let buildOutput: Awaited<ReturnType<typeof Bun.build>>;
  try {
    buildOutput = await Bun.build({
      entrypoints: [entryPath],
      target: "browser",
      format: "esm",
      minify: false,
      sourcemap: "none",
      plugins: [reactAliasPlugin],
    });
  } catch (err) {
    if (err instanceof AggregateError) {
      type BunBuildMsg = { message: string; position?: { file?: string; line?: number; column?: number } | null };
      const errors: BuildError[] = (err.errors as BunBuildMsg[]).map((e) => ({
        file: e.position?.file ?? "<unknown>",
        line: e.position?.line ?? 0,
        column: e.position?.column ?? 0,
        message: e.message,
      }));
      return { errors };
    }
    throw err;
  }
  const output = buildOutput.outputs[0];
  if (!output) {
    return {
      errors: [{ file: "<unknown>", line: 0, column: 0, message: "ui-leaf: Bun.build produced no output" }],
    };
  }
  return { js: await output.text() };
}

/** Assemble the final HTML page from compiled JS and options. */
function assembleHtml(opts: {
  js: string;
  title: string;
  csp: string | undefined;
  data: unknown;
  dataLoader: boolean;
}): string {
  const { js, title, csp, data, dataLoader } = opts;
  // Escape </script> sequences to prevent script-tag break-out.
  const safeJs = js.replace(/<\/script>/gi, "<\\/script>");

  const titleEscaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const cspMeta = csp
    ? `    <meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" />\n`
    : "";

  // Double-stringify data: outer JSON.stringify produces a JSON string, then
  // escapeForScriptTag ensures </script> and U+2028/U+2029 can't break out.
  const dataInit = dataLoader
    ? "window.__UI_LEAF__ = {};"
    : `window.__UI_LEAF__ = { data: JSON.parse(${escapeForScriptTag(JSON.stringify(JSON.stringify(data ?? null)))}) };`;

  // Bootstrap: reads token from URL fragment, stashes it on __UI_LEAF__.token,
  // then immediately clears the fragment from the URL bar so the token is
  // never visible in history. On reload (fragment gone), sets sessionEnded so
  // the bundled module can render a friendly recovery message instead of
  // attempting unauthenticated fetches.
  const bootstrapScript = `${dataInit}
(function(){var m=/[#&]token=([^&#]*)/.exec(window.location.hash);if(m){window.__UI_LEAF__.token=decodeURIComponent(m[1]);history.replaceState(null,"",window.location.pathname+window.location.search);}else{window.__UI_LEAF__.sessionEnded=true;}})();`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${titleEscaped}</title>
${cspMeta}    <!-- ui-leaf bootstrap -->
    <script>${bootstrapScript}</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${safeJs}</script>
  </body>
</html>`;
}

export async function compileView(opts: CompileOptions): Promise<CompileResult> {
  const {
    entry,
    viewsRoot,
    data,
    title = "ui-leaf",
    csp,
    // allowedHosts and token have no compile-time effect; accepted for API symmetry.
    allowedHosts: _allowedHosts,
    token: _token,
    dataLoader = false,
  } = opts;

  const viewsRootAbs = resolve(viewsRoot);
  const hasExt = /\.[a-z]+$/i.test(entry);
  const viewAbs = resolve(viewsRootAbs, hasExt ? entry : `${entry}.tsx`);
  if (!viewAbs.startsWith(viewsRootAbs + sep)) {
    return {
      html: "",
      errors: [
        {
          file: "<unknown>",
          line: 0,
          column: 0,
          message: `ui-leaf: view '${entry}' resolves outside viewsRoot`,
        },
      ],
    };
  }
  try {
    await stat(viewAbs);
  } catch {
    return {
      html: "",
      errors: [
        {
          file: viewAbs,
          line: 0,
          column: 0,
          message: `ui-leaf: view '${entry}' not found at ${viewAbs}`,
        },
      ],
    };
  }

  // Generate a temp entry that imports the resolved view, mounts React via
  // createRoot, and wires the mutation/heartbeat bridge.
  const tempDir = await mkdtemp(join(tmpdir(), "ui-leaf-compile-"));
  try {
    const entryPath = join(tempDir, "entry.tsx");

    const SESSION_ENDED_HTML =
      '<div style="font-family:sans-serif;padding:2em;color:#555"><p>Session ended — re-launch the CLI to continue.</p></div>';

    const entryContent = dataLoader
      ? `import { createRoot } from "react-dom/client";
import View from ${JSON.stringify(viewAbs)};

const ctx = (globalThis as { __UI_LEAF__?: { token?: string; sessionEnded?: boolean } }).__UI_LEAF__ ?? {};
const token = ctx.token;

if (ctx.sessionEnded) {
  const root = document.getElementById("root");
  if (root) root.innerHTML = ${JSON.stringify(SESSION_ENDED_HTML)};
} else {
${SHARED_BRIDGE}

  async function bootstrap(): Promise<void> {
    const res = await fetch("/api/data", {
      headers: token ? { "X-UI-Leaf-Token": token } : {},
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("ui-leaf: /api/data fetch failed (" + res.status + "): " + text);
    }
    const data = await res.json();
    const el = document.getElementById("root");
    if (!el) throw new Error("ui-leaf: #root element missing");
    createRoot(el).render(<View data={data} mutate={mutate} />);
  }
  bootstrap();
}
`
      : `import { createRoot } from "react-dom/client";
import View from ${JSON.stringify(viewAbs)};

const ctx = (globalThis as { __UI_LEAF__?: { data?: unknown; token?: string; sessionEnded?: boolean } }).__UI_LEAF__ ?? {};
const token = ctx.token;

if (ctx.sessionEnded) {
  const root = document.getElementById("root");
  if (root) root.innerHTML = ${JSON.stringify(SESSION_ENDED_HTML)};
} else {
  const data = ctx.data;
${SHARED_BRIDGE}

  const el = document.getElementById("root");
  if (!el) throw new Error("ui-leaf: #root element missing");
  createRoot(el).render(<View data={data} mutate={mutate} />);
}
`;

    await writeFile(entryPath, entryContent);

    const buildResult = await runBunBuild(entryPath);
    if ("errors" in buildResult) return { html: "", errors: buildResult.errors };

    return {
      html: assembleHtml({ js: buildResult.js, title, csp, data, dataLoader }),
      errors: [],
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Compile an inline TSX source string into a full HTML page.
 *
 * The source is treated as a self-contained component; relative imports are
 * not supported (v1.0.0 constraint — the string has no filesystem context).
 * Bare-package imports (react, react-dom) work via the react-alias plugin.
 */
export async function compileSource(opts: CompileSourceOptions): Promise<CompileResult> {
  const { source, data, title = "ui-leaf", csp, token: _token } = opts;

  const tempDir = await mkdtemp(join(tmpdir(), "ui-leaf-src-"));
  try {
    // Write the caller's tsx as the view file, then write a thin entry wrapper.
    const viewPath = join(tempDir, "view.tsx");
    const entryPath = join(tempDir, "entry.tsx");

    await writeFile(viewPath, source);

    const SESSION_ENDED_HTML =
      '<div style="font-family:sans-serif;padding:2em;color:#555"><p>Session ended — re-launch the CLI to continue.</p></div>';

    const entryContent = `import { createRoot } from "react-dom/client";
import View from ${JSON.stringify(viewPath)};

const ctx = (globalThis as { __UI_LEAF__?: { data?: unknown; token?: string; sessionEnded?: boolean } }).__UI_LEAF__ ?? {};
const token = ctx.token;

if (ctx.sessionEnded) {
  const root = document.getElementById("root");
  if (root) root.innerHTML = ${JSON.stringify(SESSION_ENDED_HTML)};
} else {
  const data = ctx.data;
${SHARED_BRIDGE}

  const el = document.getElementById("root");
  if (!el) throw new Error("ui-leaf: #root element missing");
  createRoot(el).render(<View data={data} mutate={mutate} />);
}
`;

    await writeFile(entryPath, entryContent);

    const buildResult = await runBunBuild(entryPath);
    if ("errors" in buildResult) return { html: "", errors: buildResult.errors };

    return {
      html: assembleHtml({ js: buildResult.js, title, csp, data, dataLoader: false }),
      errors: [],
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
