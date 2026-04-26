// Spike: spin up rsbuild dev server, inject data, open browser.
// No mutations, no heartbeat, no view-resolution conventions yet.

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import open from "open";

const here = dirname(fileURLToPath(import.meta.url));
// dev-server.{ts,js} sits at <pkg>/src or <pkg>/dist. Resolve react from
// the package's own node_modules so consumers don't need to install React.
// Trade-off: consumers always get ui-leaf's bundled React version. If a
// consumer also imports React in their views, both copies could end up in
// the bundle (duplicate-React risk). Re-evaluate when we add view-resolution
// from the consumer's own project tree.
const uiLeafPackageRoot = resolve(here, "..");
const uiLeafNodeModules = resolve(uiLeafPackageRoot, "node_modules");

export interface DevServerOptions {
  view: string;
  data: unknown;
  viewsRoot: string;
  port?: number;
  openBrowser?: boolean;
}

export interface DevServer {
  url: string;
  port: number;
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

export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const { view, data, viewsRoot, port, openBrowser = true } = opts;

  const viewAbs = resolve(viewsRoot, `${view}.tsx`);
  try {
    await stat(viewAbs);
  } catch {
    throw new Error(
      `ui-leaf: view '${view}' not found at ${viewAbs} (looked for .tsx; viewsRoot=${viewsRoot})`,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ui-leaf-"));

  const entryPath = join(tempDir, "entry.tsx");
  await writeFile(
    entryPath,
    `import { createRoot } from "react-dom/client";
import View from ${JSON.stringify(viewAbs)};

const el = document.getElementById("root");
if (!el) throw new Error("ui-leaf: #root element missing from page");
const data = (globalThis as { __UI_LEAF__?: { data?: unknown } }).__UI_LEAF__?.data;
createRoot(el).render(<View data={data} />);
`,
  );

  const htmlPath = join(tempDir, "index.html");
  await writeFile(
    htmlPath,
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ui-leaf</title>
    <script>window.__UI_LEAF__ = { data: ${escapeForScriptTag(JSON.stringify(data))} };</script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  );

  const rsbuild = await createRsbuild({
    cwd: tempDir,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: {
        entry: { index: entryPath },
      },
      server: {
        port: port ?? 3000,
        host: "127.0.0.1",
      },
      html: {
        template: htmlPath,
      },
      tools: {
        rspack: {
          resolve: {
            modules: [uiLeafNodeModules, "node_modules"],
          },
        },
      },
    },
  });

  const devServer = await rsbuild.startDevServer();
  const actualPort = devServer.port;
  const url = `http://127.0.0.1:${actualPort}`;

  if (openBrowser) {
    await open(url);
  }

  return {
    url,
    port: actualPort,
    close: async () => {
      await devServer.server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
