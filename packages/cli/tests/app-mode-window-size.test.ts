// ui-leaf#56: shell:"app" should launch Chrome at the requested size via
// `--window-size=W,H` so the chromeless window opens correctly on first paint
// instead of snapping via window.resizeTo(). buildAppModeArgs is the pure
// argv builder extracted from openInAppMode for exactly this assertion.

import { describe, expect, spyOn, test } from "bun:test";

import { buildAppModeArgs } from "../src/server.ts";

const URL = "http://127.0.0.1:5810/#token=abc";
const DIR = "/tmp/ui-leaf-chrome-xyz";

describe("buildAppModeArgs (#56 window size)", () => {
  test("emits --window-size=W,H when a valid windowSize is provided (AC#1)", () => {
    const args = buildAppModeArgs(URL, DIR, { width: 600, height: 870 });
    expect(args).toContain("--window-size=600,870");
    // base flags still present
    expect(args).toContain(`--app=${URL}`);
    expect(args).toContain(`--user-data-dir=${DIR}`);
  });

  test("omits --window-size entirely when windowSize is undefined (AC#2)", () => {
    const args = buildAppModeArgs(URL, DIR);
    expect(args.some((a) => a.startsWith("--window-size="))).toBe(false);
  });

  test("ignores non-positive / non-finite dimensions and warns (validation)", () => {
    for (const bad of [
      { width: 0, height: 870 },
      { width: 600, height: -1 },
      { width: Number.NaN, height: 870 },
      { width: 600, height: Number.POSITIVE_INFINITY },
    ]) {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const args = buildAppModeArgs(URL, DIR, bad);
      expect(args.some((a) => a.startsWith("--window-size="))).toBe(false);
      // Bad dims must not be swallowed silently — the caller needs a trail.
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  });

  test("does NOT warn when windowSize is simply omitted", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    buildAppModeArgs(URL, DIR);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("rounds fractional dimensions to integers", () => {
    const args = buildAppModeArgs(URL, DIR, { width: 600.4, height: 869.6 });
    expect(args).toContain("--window-size=600,870");
  });
});
