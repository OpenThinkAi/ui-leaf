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
  /** JSON-serializable data injected as window.__UI_LEAF__.data. */
  data: unknown;
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
   * effect — the runtime DNS-rebinding gate lives in the dev server.
   */
  allowedHosts?: string[];
}

export interface CompileResult {
  html: string;
  errors: BuildError[];
}

export async function compileView(opts: CompileOptions): Promise<CompileResult> {
  const {
    entry,
    viewsRoot,
    data,
    title = "ui-leaf",
    csp,
    // allowedHosts has no compile-time effect; accepted for API symmetry.
    allowedHosts: _allowedHosts,
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
  // createRoot, and wires the mutation/heartbeat bridge. The view's default
  // export is a React component that cannot self-bootstrap (no createRoot
  // call); this mirrors the existing dev-server.ts entry.tsx pattern.
  const tempDir = await mkdtemp(join(tmpdir(), "ui-leaf-compile-"));
  try {
    const entryPath = join(tempDir, "entry.tsx");
    await writeFile(
      entryPath,
      `import { createRoot } from "react-dom/client";
import View from ${JSON.stringify(viewAbs)};

const ctx = (globalThis as { __UI_LEAF__?: { data?: unknown; token?: string } }).__UI_LEAF__ ?? {};
const data = ctx.data;
const token = ctx.token;

async function mutate(name: string, args?: unknown): Promise<unknown> {
  const res = await fetch("/mutate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
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
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
  } catch { /* server may have shut down; ignore */ }
}
setInterval(heartbeat, 5000);
heartbeat();

const el = document.getElementById("root");
if (!el) throw new Error("ui-leaf: #root element missing");
createRoot(el).render(<View data={data} mutate={mutate} />);
`,
    );

    // Bun.build throws AggregateError on build failure (syntax errors,
    // unresolved imports, etc.) rather than returning { success: false }.
    // Catch and map to BuildError[] so callers never see a thrown exception.
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
        return { html: "", errors };
      }
      throw err;
    }

    const output = buildOutput.outputs[0];
    if (!output) {
      return {
        html: "",
        errors: [
          {
            file: "<unknown>",
            line: 0,
            column: 0,
            message: "ui-leaf: Bun.build produced no output",
          },
        ],
      };
    }

    const js = await output.text();
    // Escape </script> sequences to prevent script-tag break-out.
    // U+2028/U+2029 are valid ECMAScript in module scripts (ES2019+) and
    // do not appear raw in bundler output, so no further escaping is needed.
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
    // The browser calls JSON.parse() on the embedded string — same pattern as
    // dev-server.ts to avoid Annex B.3.1 prototype mutation via object literals.
    const dataInline = escapeForScriptTag(
      JSON.stringify(JSON.stringify(data ?? null)),
    );

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${titleEscaped}</title>
${cspMeta}    <!-- ui-leaf bootstrap -->
    <script>window.__UI_LEAF__ = { data: JSON.parse(${dataInline}) };</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${safeJs}</script>
  </body>
</html>`;

    return { html, errors: [] };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
