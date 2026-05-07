#!/usr/bin/env bun
// CI smoke harness for examples/.
//
// Spawns each example script in smoke mode (UI_LEAF_SMOKE=1) and verifies it:
//   1. Emits "[<lang>] view ready at <url>" on stderr.
//   2. Exits 0 within 30 s.
//
// The bash example is Linux-only (bash + Windows has historical shell-quoting
// grief; the wrapper-js integration tests already exercise spawn+IPC on all
// hosts). Python and Node run on every host.
//
// Usage:
//   bun run scripts/smoke-examples.ts
//
// The test.yml step runs this after "Build host binary" so the compiled binary
// is at dist/ui-leaf-<host-target>[.exe].

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
const distBin = resolve(REPO_ROOT, "dist", `ui-leaf-${hostTarget()}${binSuffix}`);
// Fall back to the node-run CLI for local development (no compiled binary needed).
const UI_LEAF_BIN = existsSync(distBin) ? distBin : "ui-leaf";

const VIEWS_ROOT = resolve(REPO_ROOT, "examples", "views");

// Build the wrapper-js dist if the example's import target doesn't exist yet.
// The node example imports from the built dist, not from the TypeScript source,
// so it mirrors the real-user experience end-to-end.
const wrapperDist = resolve(REPO_ROOT, "packages", "wrapper-js", "dist", "index.js");
if (!existsSync(wrapperDist)) {
  console.log("wrapper-js dist not found — building…");
  const result = Bun.spawnSync(["bun", "run", "build:wrapper"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    console.error("build:wrapper failed");
    process.exit(1);
  }
}

interface ExampleSpec {
  label: string;
  cmd: string;
  args: string[];
  skipOnPlatform?: string[];
}

const examples: ExampleSpec[] = [
  {
    label: "bash",
    cmd: "bash",
    args: [resolve(REPO_ROOT, "examples", "bash", "counter.sh")],
    // bash + Windows has historically poor shell-quoting behaviour; skip there.
    // The wrapper-js integration.test.ts already covers spawn+IPC on Windows.
    skipOnPlatform: ["win32"],
  },
  {
    label: "python",
    cmd: "python3",
    args: [resolve(REPO_ROOT, "examples", "python", "counter.py")],
  },
  {
    label: "node",
    cmd: "bun",
    args: ["run", resolve(REPO_ROOT, "examples", "node", "counter.js")],
  },
];

const sharedEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  UI_LEAF_SMOKE: "1",
  UI_LEAF_BIN,
  UI_LEAF_VIEWS_ROOT: VIEWS_ROOT,
};

function runExample(spec: ExampleSpec): Promise<void> {
  if (spec.skipOnPlatform?.includes(process.platform)) {
    console.log(`  [SKIP] ${spec.label} (not supported on ${process.platform})`);
    return Promise.resolve();
  }

  return new Promise<void>((resolveP, rejectP) => {
    const child = spawn(spec.cmd, spec.args, {
      env: sharedEnv,
      // Stdout is not used by the examples in smoke mode; stderr carries the
      // "[lang] view ready" line and other diagnostic output.
      stdio: ["ignore", "ignore", "pipe"],
    });

    let sawReady = false;
    let stderrBuf = "";

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text); // forward for visibility in CI logs
      stderrBuf += text;
      if (!sawReady && stderrBuf.includes("view ready at")) {
        sawReady = true;
      }
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`${spec.label}: timed out after 30 s`));
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!sawReady) {
        rejectP(
          new Error(`${spec.label}: exited without emitting "view ready at" on stderr`),
        );
        return;
      }
      if (code !== 0) {
        rejectP(new Error(`${spec.label}: exited with code ${code}`));
        return;
      }
      console.log(`  [OK]   ${spec.label}`);
      resolveP();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectP(new Error(`${spec.label}: spawn error — ${err.message}`));
    });
  });
}

let failures = 0;

for (const spec of examples) {
  console.log(`Running ${spec.label} example…`);
  try {
    await runExample(spec);
  } catch (err) {
    console.error(`  [FAIL] ${(err as Error).message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} example(s) failed.`);
  process.exit(1);
}

console.log("\nAll examples passed.");
