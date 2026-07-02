import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "../src/server.ts";
import { HEARTBEAT_INTERVAL_MS } from "../src/compile.ts";

// Issue #75: the default disconnect deadline used to equal the page beat
// interval (5000 == 5000), leaving zero slack — any late beat (timer jitter,
// GC pause, Chrome background-timer clamping on an occluded window) flapped
// disconnected/reconnected on a healthy view. These tests pin the corrected
// defaults and the slack invariant so the pair can't silently drift back
// into a zero-slack configuration.

describe("heartbeat defaults (issue #75)", () => {
  test("page beat interval is 5000 ms", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
  });

  test("default heartbeatTimeoutMs is 15000 ms", () => {
    expect(DEFAULT_HEARTBEAT_TIMEOUT_MS).toBe(15_000);
  });

  test("slack invariant: timeout is at least 2x the beat interval", () => {
    expect(DEFAULT_HEARTBEAT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * HEARTBEAT_INTERVAL_MS,
    );
  });

  test("ipc.json documents the current default", () => {
    const schemaRaw = readFileSync(
      resolve(import.meta.dir, "../schema/ipc.json"),
      "utf-8",
    );
    const schema = JSON.parse(schemaRaw) as {
      $defs: {
        InboundConfig: {
          properties: { heartbeatTimeoutMs: { description: string } };
        };
      };
    };
    const desc =
      schema.$defs.InboundConfig.properties.heartbeatTimeoutMs.description;
    expect(desc).toContain(String(DEFAULT_HEARTBEAT_TIMEOUT_MS));
  });
});
