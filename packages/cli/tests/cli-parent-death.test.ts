// ui-leaf#101: `ui-leaf mount` must exit when the process that spawned it
// dies, even when stdin never reaches EOF (another process still holds the
// pipe's write end). Reproduces the 5-day launchd orphan: an intermediate
// shell spawns the CLI behind a pipeline whose writer (`sleep`) outlives the
// shell; SIGKILLing the shell reparents the CLI with stdin still open.

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let dir: string | null = null;
const cleanupPids: number[] = [];

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("ui-leaf mount: parent death (ui-leaf#101)", () => {
  test.skipIf(process.platform === "win32")(
    "exits with closed:signal when reparented while stdin stays open",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "ui-leaf-parent-death-"));
      const out = join(dir, "out");
      const pidFile = join(dir, "pids");
      const writerFile = join(dir, "writer");
      const config = JSON.stringify({
        version: "1",
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: false,
      });
      // $! after a backgrounded pipeline is its last stage: the CLI.
      const script = `{ printf '%s\\n' "$CFG"; exec sh -c 'echo $$ > "$WRITER"; exec sleep 60'; } | "$BUN" "$CLI" mount > "$OUT" 2>&1 &
cli=$!
echo "$cli" > "$PIDS"
wait`;
      const shell = spawn("sh", ["-c", script], {
        env: { ...process.env, CFG: config, BUN: process.execPath, CLI, OUT: out, PIDS: pidFile, WRITER: writerFile },
        stdio: "ignore",
      });
      cleanupPids.push(shell.pid!);

      let cliPid = 0;
      for (let i = 0; i < 300; i++) {
        try {
          const text = readFileSync(out, "utf8");
          if (text.includes('"type":"ready"')) {
            cliPid = Number(readFileSync(pidFile, "utf8").trim());
            break;
          }
        } catch {
          /* not yet */
        }
        await sleep(50);
      }
      expect(cliPid).toBeGreaterThan(0);
      cleanupPids.push(cliPid, Number(readFileSync(writerFile, "utf8").trim()));

      shell.kill("SIGKILL"); // parent dies; `sleep` keeps stdin's write end open

      for (let i = 0; i < 100 && alive(cliPid); i++) await sleep(50);
      expect(alive(cliPid)).toBe(false);
      expect(readFileSync(out, "utf8")).toContain('"type":"closed","reason":"signal"');
    },
    30_000,
  );
});
