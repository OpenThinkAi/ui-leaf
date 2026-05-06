#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
  /** Identifier in the artifact name and the suffix on `bun-`. */
  id: string;
  /** Final filename in dist/ (with `.exe` for windows). */
  filename: string;
}

const TARGETS: readonly Target[] = [
  { id: "darwin-arm64", filename: "ui-leaf-darwin-arm64" },
  { id: "darwin-x64", filename: "ui-leaf-darwin-x64" },
  { id: "linux-x64", filename: "ui-leaf-linux-x64" },
  { id: "linux-arm64", filename: "ui-leaf-linux-arm64" },
  { id: "windows-x64", filename: "ui-leaf-windows-x64.exe" },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO_ROOT, "packages/cli/src/cli.ts");
const DIST_DIR = join(REPO_ROOT, "dist");

interface BuildOutcome {
  target: Target;
  ok: boolean;
  durationMs: number;
  sizeBytes?: number;
  error?: string;
}

function parseTargetsFlag(argv: readonly string[]): readonly Target[] {
  const idx = argv.indexOf("--targets");
  if (idx === -1) return TARGETS;
  const value = argv[idx + 1];
  if (!value) {
    throw new Error("--targets requires a comma-separated value, e.g. --targets darwin-arm64,linux-x64");
  }
  const requested = value.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Map(TARGETS.map((t) => [t.id, t]));
  const selected: Target[] = [];
  const unknown: string[] = [];
  for (const id of requested) {
    const t = known.get(id);
    if (t) selected.push(t);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    throw new Error(
      `unknown target(s): ${unknown.join(", ")}. valid: ${TARGETS.map((t) => t.id).join(", ")}`,
    );
  }
  return selected;
}

function buildOne(target: Target): Promise<BuildOutcome> {
  const outfile = join(DIST_DIR, target.filename);
  const args = [
    "build",
    "--compile",
    `--target=bun-${target.id}`,
    "--minify",
    `--outfile=${outfile}`,
    ENTRY,
  ];
  const started = Date.now();
  return new Promise((resolveOutcome) => {
    const child = spawn("bun", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", () => { /* discard */ });
    child.on("error", (err) => {
      resolveOutcome({
        target,
        ok: false,
        durationMs: Date.now() - started,
        error: `failed to spawn bun: ${err.message}`,
      });
    });
    child.on("close", async (code) => {
      const durationMs = Date.now() - started;
      if (code !== 0) {
        resolveOutcome({
          target,
          ok: false,
          durationMs,
          error: stderr.trim() || `bun build exited with code ${code}`,
        });
        return;
      }
      try {
        const st = await stat(outfile);
        resolveOutcome({ target, ok: true, durationMs, sizeBytes: st.size });
      } catch (err) {
        resolveOutcome({
          target,
          ok: false,
          durationMs,
          error: `bun build reported success but ${outfile} is missing: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    });
  });
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writeChecksums(): Promise<void> {
  const entries = await readdir(DIST_DIR);
  const binaries = entries.filter((name) => name.startsWith("ui-leaf-")).sort();
  const lines: string[] = [];
  for (const name of binaries) {
    const digest = await hashFile(join(DIST_DIR, name));
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(join(DIST_DIR, "checksums.txt"), `${lines.join("\n")}\n`, "utf8");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const selected = parseTargetsFlag(argv);

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  console.log(`Building ${selected.length} target(s) → ${DIST_DIR}`);
  const outcomes: BuildOutcome[] = [];
  for (const target of selected) {
    process.stdout.write(`  ${target.id} … `);
    const outcome = await buildOne(target);
    outcomes.push(outcome);
    if (outcome.ok) {
      console.log(`ok (${formatDuration(outcome.durationMs)}, ${formatSize(outcome.sizeBytes)})`);
    } else {
      console.log(`FAIL (${formatDuration(outcome.durationMs)})`);
      console.log(`    ${outcome.error?.split("\n").join("\n    ")}`);
    }
  }

  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${outcomes.length} build(s) failed.`);
    process.exit(1);
  }

  await writeChecksums();
  console.log(`\nAll ${outcomes.length} build(s) succeeded. Checksums: ${join(DIST_DIR, "checksums.txt")}`);
}

await main();
