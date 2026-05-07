// Real-binary smoke test — AC #5.
//
// Gated on dist/ui-leaf-<host-target>[.exe] existing. If the binary hasn't
// been compiled for the current host, the test is skipped with a clear
// message. CI runs `bun build --compile` before the test suite so this test
// actually fires on each OS runner rather than being skipped there.

import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mount } from "../src/index.ts";

function hostTarget(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin") return "darwin-x64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  if (p === "linux") return "linux-x64";
  if (p === "win32") return "windows-x64";
  return `${p}-${a}`;
}

const binSuffix = process.platform === "win32" ? ".exe" : "";
const binaryPath = path.resolve(
  import.meta.dir,
  "..",
  "dist",
  `ui-leaf-${hostTarget()}${binSuffix}`,
);
const binaryExists = fs.existsSync(binaryPath);

test.skipIf(!binaryExists)(
  "real binary: mount + update + close",
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-leaf-integ-"));
    try {
      const viewFile = path.join(tmpDir, "test-view.tsx");
      fs.writeFileSync(
        viewFile,
        "export default function View() { return <div>hello</div>; }",
      );

      const view = await mount({
        binaryPath,
        view: "test-view",
        viewsRoot: tmpDir,
        silent: true,
        openBrowser: false,
      });

      expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      await view.update({ data: { tick: 1 } });
      await view.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  30_000,
);
