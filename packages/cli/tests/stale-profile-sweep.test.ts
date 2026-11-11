// AGT-2354: sweepStaleChromeProfiles removes leftover ui-leaf-chrome-* temp
// profiles only when they are clearly unused (old AND not locked by a live
// Chrome), and never touches anything else.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleChromeProfiles, STALE_PROFILE_AGE_MS } from "../src/server.ts";

let root: string;
const NOW = Date.now();
const OLD = (NOW - STALE_PROFILE_AGE_MS - 60_000) / 1000;
const posixTest = process.platform === "win32" ? test.skip : test;

function makeDir(name: string, mtimeSec?: number): string {
  const d = join(root, name);
  mkdirSync(d);
  if (mtimeSec !== undefined) utimesSync(d, mtimeSec, mtimeSec);
  return d;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ui-leaf-sweep-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sweepStaleChromeProfiles", () => {
  test("removes an old unlocked temp profile and keeps a recent one", async () => {
    const old = makeDir("ui-leaf-chrome-old", OLD);
    const recent = makeDir("ui-leaf-chrome-recent");
    const removed = await sweepStaleChromeProfiles(root, NOW);
    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  posixTest("keeps an old profile whose SingletonLock names a live pid", async () => {
    const live = makeDir("ui-leaf-chrome-live");
    symlinkSync(`somehost-${process.pid}`, join(live, "SingletonLock"));
    utimesSync(live, OLD, OLD);
    expect(await sweepStaleChromeProfiles(root, NOW)).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  posixTest("removes an old profile whose SingletonLock names a dead pid", async () => {
    const dead = makeDir("ui-leaf-chrome-dead");
    // pid 2^22+ is above the default pid_max on Linux and macOS's 99999.
    symlinkSync("somehost-4194999", join(dead, "SingletonLock"));
    utimesSync(dead, OLD, OLD);
    expect(await sweepStaleChromeProfiles(root, NOW)).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
  });

  test("never touches dirs without the ui-leaf-chrome- prefix", async () => {
    const other = makeDir("some-other-profile", OLD);
    const persistent = makeDir("ui-leaf-test-profile-x", OLD);
    expect(await sweepStaleChromeProfiles(root, NOW)).toEqual([]);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(persistent)).toBe(true);
  });

  test("returns empty for a missing directory", async () => {
    expect(await sweepStaleChromeProfiles(join(root, "nope"), NOW)).toEqual([]);
  });
});
