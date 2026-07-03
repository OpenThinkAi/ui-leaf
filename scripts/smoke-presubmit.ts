#!/usr/bin/env bun
//
// scripts/smoke-presubmit.ts (AGT-202)
//
// Pre-merge smoke check, run by `stamp merge` against the merged tree via the
// `smoke` entry in `.stamp/config.yml`'s `branches.main.required_checks`.
// Goal: catch binary/wrapper regressions BEFORE the signed merge commit lands
// on main and the publish workflow cuts a release — replacing the
// `workflow_dispatch` post-publish iteration cycle that cost ~30min per fix
// during v1.0.0 RC.
//
// What it does, in order:
//   1. Path filter — if the PR diff touches none of the binary/wrapper/view
//      surface, skip with exit 0 (doc/test/config-only PRs don't pay the cost).
//   2. Build the host-platform binary ONLY (not the full 5-target matrix)
//      into a tempdir via `scripts/build-binaries.ts --targets <host> --out <tmp>`.
//   3. Drive the binary stdin-IPC round-trip directly against the built
//      binary (mirrors smoke.yml's `binary` job driver): mount with an
//      update written BEFORE `ready` (must be buffered and reflected in the
//      first served paint — issue #72), then a post-ready update (the served
//      HTML must re-assemble so reloads/reopens get fresh data), then close.
//   4. Drive the wrapper round-trip by importing `packages/wrapper-js/src/`
//      TypeScript directly (bun runs TS) and calling `mount({ binaryPath: ... })`
//      with the just-built binary. No npm install. No GH Releases.
//
// Tempdir is cleaned on exit (success, failure, SIGINT, SIGTERM).
//
// Scope per AGT-202: host-platform only. The cross-platform matrix lives in
// the existing post-publish `.github/workflows/smoke.yml` as defense-in-depth.

import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// -----------------------------------------------------------------------------
// Host target detection
// -----------------------------------------------------------------------------

interface HostTarget {
  id: string;
  filename: string;
}

function detectHostTarget(): HostTarget {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return { id: "darwin-arm64", filename: "ui-leaf-darwin-arm64" };
  if (platform === "darwin" && arch === "x64") return { id: "darwin-x64", filename: "ui-leaf-darwin-x64" };
  if (platform === "linux" && arch === "x64") return { id: "linux-x64", filename: "ui-leaf-linux-x64" };
  if (platform === "linux" && arch === "arm64") return { id: "linux-arm64", filename: "ui-leaf-linux-arm64" };
  if (platform === "win32" && arch === "x64") return { id: "windows-x64", filename: "ui-leaf-windows-x64.exe" };
  throw new Error(`smoke-presubmit: unsupported host platform/arch combo ${platform}/${arch}`);
}

// -----------------------------------------------------------------------------
// Path filter — skip the check on PRs that can't affect the binary/wrapper
// -----------------------------------------------------------------------------

// Path prefixes whose changes warrant a re-run of the binary+wrapper smoke.
// If the diff touches NONE of these, exit 0 immediately (no work done).
// Conservative: any miss here costs ~30s on a merge but never a false GREEN.
const SMOKE_RELEVANT_PREFIXES: readonly string[] = [
  "packages/cli/",
  "packages/wrapper-js/src/",
  "scripts/build-binaries.ts",
  "scripts/build-react-bundles.ts",
  "scripts/smoke-presubmit.ts",
  "views/",
  // Workspace metadata (bun.lock / root package.json) can shift the bundled
  // React or transitive surface — re-smoke to be safe.
  "package.json",
  "bun.lock",
];

function diffTouchesSmokeSurface(): boolean {
  // Use HEAD~1..HEAD as the diff range. At `stamp merge` time the working
  // tree is the merge commit (a 2-parent commit) and HEAD~1 is the previous
  // tip of the base — so HEAD~1..HEAD shows everything the merge adds. For
  // local invocations (bun run smoke:presubmit on a feature branch), this is
  // the last commit only, which is a reasonable approximation; the conservative
  // failure mode is "skipped when it should have run", and a local run is
  // already opt-in by the dev who wants to validate before pushing.
  //
  // Fall-open: if `git diff` errors for any reason (shallow clone, no commits,
  // etc.), we treat the PR as smoke-relevant and run the full check. That
  // matches the "conservative" stance: better a wasted 30s than a silent skip.
  const result = Bun.spawnSync(["git", "diff", "--name-only", "HEAD~1..HEAD"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    console.log("[skip-filter] git diff failed; falling open and running full smoke");
    return true;
  }
  const files = new TextDecoder().decode(result.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0) {
    console.log("[skip-filter] empty diff; falling open and running full smoke");
    return true;
  }
  for (const file of files) {
    for (const prefix of SMOKE_RELEVANT_PREFIXES) {
      if (file === prefix || file.startsWith(prefix)) {
        console.log(`[skip-filter] '${file}' matches '${prefix}' — running smoke`);
        return true;
      }
    }
  }
  console.log(`[skip-filter] none of ${files.length} changed file(s) touch the binary/wrapper surface — skipping smoke`);
  return false;
}

// -----------------------------------------------------------------------------
// Tempdir lifecycle — cleanup on exit/signal
// -----------------------------------------------------------------------------

let cleanupPath: string | undefined;
let cleanupRan = false;

async function cleanup(): Promise<void> {
  if (cleanupRan) return;
  cleanupRan = true;
  if (cleanupPath) {
    try {
      await rm(cleanupPath, { recursive: true, force: true });
    } catch {
      // Best-effort; OS will reap /tmp eventually.
    }
  }
}

function installCleanupHandlers(): void {
  // Async cleanup on normal exit (await before process.exit).
  // Synchronous best-effort on signals — the OS will reap /tmp anyway.
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(143));
  });
}

// -----------------------------------------------------------------------------
// Build the host-platform binary into a tempdir
// -----------------------------------------------------------------------------

async function buildHostBinary(target: HostTarget, distDir: string): Promise<string> {
  const started = Date.now();
  console.log(`[build] bun build host binary (${target.id}) → ${distDir}`);
  const args = [
    "run",
    join(REPO_ROOT, "scripts/build-binaries.ts"),
    "--targets",
    target.id,
    "--out",
    distDir,
  ];
  const code: number = await new Promise((res, rej) => {
    const child = spawn("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("error", rej);
    child.on("close", (c) => res(c ?? 1));
  });
  if (code !== 0) {
    throw new Error(`build-binaries.ts exited with code ${code}`);
  }
  const binaryPath = join(distDir, target.filename);
  const st = await stat(binaryPath);
  console.log(`[build] ok (${((Date.now() - started) / 1000).toFixed(1)}s, ${(st.size / (1024 * 1024)).toFixed(1)} MiB)`);
  return binaryPath;
}

// -----------------------------------------------------------------------------
// Write a minimal smoke view (.tsx) for both round-trips
// -----------------------------------------------------------------------------

const SMOKE_VIEW_SOURCE = `export default function Smoke({ title }: { title: string }) {
  return <div id="smoke-title">{title}</div>;
}
`;

async function writeSmokeView(viewsRoot: string): Promise<void> {
  await mkdir(viewsRoot, { recursive: true });
  await writeFile(join(viewsRoot, "smoke.tsx"), SMOKE_VIEW_SOURCE, "utf8");
}

// -----------------------------------------------------------------------------
// Binary stdin-IPC round-trip (mirrors smoke.yml's `binary` job driver)
// -----------------------------------------------------------------------------

async function runBinaryRoundtrip(binaryPath: string, viewsRoot: string): Promise<void> {
  console.log("[binary] driving stdin-IPC mount → pre-ready update → served-HTML asserts → update → close");
  await new Promise<void>((resolveDone, rejectDone) => {
    const child = spawn(binaryPath, ["mount"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const config = JSON.stringify({
      version: "1",
      view: "smoke",
      viewsRoot,
      data: { title: "smoke-ok" },
      openBrowser: false,
      heartbeatTimeoutMs: 5000,
    });

    let ready = false;
    let asserted = false;
    let closeSent = false;
    let closed = false;
    let stdoutBuf = "";
    let failed = false;

    const hardTimeout = setTimeout(() => {
      child.kill();
      rejectDone(new Error("binary round-trip: timeout (mount did not close within 30s)"));
    }, 30000);

    const fail = (err: Error): void => {
      failed = true;
      clearTimeout(hardTimeout);
      child.kill();
      rejectDone(err);
    };

    // On ready: assert the served page first-paints with the PRE-ready
    // update's data (issue #72 — the update written right after the config,
    // long before ready, must be buffered and applied, not dropped), then
    // send a post-ready update and assert the served page tracks it (the
    // HTML re-assembles on update; a reopen()'d tab would get this page).
    const assertServedPages = async (port: number): Promise<void> => {
      const base = `http://127.0.0.1:${port}`;

      const first = await (await fetch(`${base}/`)).text();
      if (!first.includes("pre-ready-payload")) {
        throw new Error("binary round-trip: served HTML does not reflect the pre-ready update (issue #72 regression — update sent before 'ready' was dropped or not applied)");
      }
      if (first.includes("smoke-ok")) {
        throw new Error("binary round-trip: served HTML still embeds the config-time data despite a pre-ready update");
      }
      console.log("[binary] pre-ready update reflected in first served paint");

      child.stdin.write(
        JSON.stringify({ version: "1", type: "update", data: { title: "mutated" } }) + "\n",
      );
      // Give the single-threaded event loop a beat to process the line.
      await new Promise((r) => setTimeout(r, 500));

      const second = await (await fetch(`${base}/`)).text();
      if (!second.includes("mutated") || second.includes("pre-ready-payload")) {
        throw new Error("binary round-trip: served HTML not re-assembled after post-ready update (stale data would be served to reloads/reopens)");
      }
      console.log("[binary] post-ready update reflected in served HTML");
      asserted = true;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let event: { type?: string; port?: number; message?: string };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "ready" && !ready) {
          ready = true;
          console.log(`[binary] ready on port ${event.port}`);
          void assertServedPages(event.port as number)
            .then(() => {
              child.stdin.write(JSON.stringify({ version: "1", type: "close" }) + "\n");
              closeSent = true;
            })
            .catch((err: unknown) => {
              fail(err instanceof Error ? err : new Error(String(err)));
            });
        }
        if (event.type === "closed") {
          closed = true;
          console.log("[binary] closed event received");
        }
        if (event.type === "error") {
          fail(new Error(`binary round-trip: mount error: ${event.message ?? "(no message)"}`));
          return;
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(hardTimeout);
      rejectDone(new Error(`binary round-trip: spawn failed: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(hardTimeout);
      if (failed) return;
      if (!ready) return rejectDone(new Error("binary round-trip: binary exited before 'ready'"));
      if (!asserted) return rejectDone(new Error("binary round-trip: served-HTML asserts never completed"));
      if (!closeSent) return rejectDone(new Error("binary round-trip: close was never sent"));
      if (!closed) return rejectDone(new Error("binary round-trip: no 'closed' event received"));
      console.log(`[binary] PASSED (exit code: ${code})`);
      resolveDone();
    });

    // Send config as the first stdin line, then IMMEDIATELY an update —
    // guaranteed to land while the mount is still compiling / starting up,
    // i.e. before 'ready'. Per the protocol this must be buffered (last
    // write wins) and applied before ready is emitted, never dropped.
    child.stdin.write(config + "\n");
    child.stdin.write(
      JSON.stringify({ version: "1", type: "update", data: { title: "pre-ready-payload" } }) + "\n",
    );
  });
}

// -----------------------------------------------------------------------------
// Wrapper round-trip — import wrapper-js source directly, point at the built
// binary via the `binaryPath` escape hatch. No npm install. No GH Releases.
// -----------------------------------------------------------------------------

async function runWrapperRoundtrip(binaryPath: string, viewsRoot: string): Promise<void> {
  console.log("[wrapper] driving mount({ binaryPath }) → update → close against wrapper-js source");
  // Import from source so the wrapper change in the PR is what gets exercised
  // (the published dist/ would be stale on a feature branch). Bun runs TS
  // directly. Dynamic import to keep this file's top-level import surface
  // small and to defer loading until after the binary is built.
  const wrapperEntry = join(REPO_ROOT, "packages/wrapper-js/src/index.ts");
  const mod = (await import(wrapperEntry)) as typeof import("../packages/wrapper-js/src/index.ts");
  const { mount } = mod;

  const handle = await mount({
    view: "smoke",
    viewsRoot,
    data: { title: "wrapper-smoke-ok" },
    openBrowser: false,
    heartbeatTimeoutMs: 5000,
    binaryPath,
  });
  console.log(`[wrapper] mounted, port: ${handle.port}`);

  await handle.update({ data: { title: "wrapper-mutated" } });
  console.log("[wrapper] update OK");

  await handle.close();
  console.log("[wrapper] closed OK");
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  installCleanupHandlers();

  if (!diffTouchesSmokeSurface()) {
    process.exit(0);
  }

  const host = detectHostTarget();

  const work = await mkdtemp(join(tmpdir(), "ui-leaf-smoke-"));
  cleanupPath = work;
  const distDir = join(work, "dist");
  const viewsRoot = join(work, "views");
  await mkdir(distDir, { recursive: true });

  console.log(`[smoke-presubmit] host=${host.id}  work=${work}`);

  try {
    const binaryPath = await buildHostBinary(host, distDir);
    await writeSmokeView(viewsRoot);
    await runBinaryRoundtrip(binaryPath, viewsRoot);
    await runWrapperRoundtrip(binaryPath, viewsRoot);
    console.log("[smoke-presubmit] ALL CHECKS PASSED");
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(`[smoke-presubmit] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  void cleanup().finally(() => process.exit(1));
});
