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

describe("buildAppModeArgs (#65 window position)", () => {
  test("emits --window-position=X,Y when a valid windowPosition is provided", () => {
    const args = buildAppModeArgs(URL, DIR, undefined, { x: 100, y: 60 });
    expect(args).toContain("--window-position=100,60");
  });

  test("allows negative coordinates (monitor left of / above the primary)", () => {
    const args = buildAppModeArgs(URL, DIR, undefined, { x: -1920, y: -200 });
    expect(args).toContain("--window-position=-1920,-200");
  });

  test("omits --window-position entirely when windowPosition is undefined", () => {
    const args = buildAppModeArgs(URL, DIR);
    expect(args.some((a) => a.startsWith("--window-position="))).toBe(false);
  });

  test("ignores non-finite coordinates and warns", () => {
    for (const bad of [
      { x: Number.NaN, y: 60 },
      { x: 100, y: Number.POSITIVE_INFINITY },
    ]) {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const args = buildAppModeArgs(URL, DIR, undefined, bad);
      expect(args.some((a) => a.startsWith("--window-position="))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  });

  test("rounds fractional coordinates to integers", () => {
    const args = buildAppModeArgs(URL, DIR, undefined, { x: 100.4, y: 59.6 });
    expect(args).toContain("--window-position=100,60");
  });

  test("composes with windowSize", () => {
    const args = buildAppModeArgs(
      URL,
      DIR,
      { width: 600, height: 870 },
      { x: 100, y: 60 },
    );
    expect(args).toContain("--window-size=600,870");
    expect(args).toContain("--window-position=100,60");
  });
});

describe("buildAppModeArgs (#64 extensions)", () => {
  test("emits paired --load-extension / --disable-extensions-except flags", () => {
    const args = buildAppModeArgs(URL, DIR, undefined, undefined, [
      "/abs/ext-a",
      "/abs/ext-b",
    ]);
    expect(args).toContain("--load-extension=/abs/ext-a,/abs/ext-b");
    expect(args).toContain("--disable-extensions-except=/abs/ext-a,/abs/ext-b");
  });

  test("omits both extension flags when extensions is undefined or empty", () => {
    for (const ext of [undefined, []]) {
      const args = buildAppModeArgs(URL, DIR, undefined, undefined, ext);
      expect(args.some((a) => a.startsWith("--load-extension="))).toBe(false);
      expect(args.some((a) => a.startsWith("--disable-extensions-except="))).toBe(false);
    }
  });
});

describe("buildAppModeArgs (#66 debug port)", () => {
  test("emits --remote-debugging-port + loopback address for a valid port", () => {
    const args = buildAppModeArgs(URL, DIR, undefined, undefined, undefined, 9222);
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
  });

  test("omits the debug flags when debugPort is undefined", () => {
    const args = buildAppModeArgs(URL, DIR);
    expect(args.some((a) => a.startsWith("--remote-debugging-port="))).toBe(false);
    expect(args.some((a) => a.startsWith("--remote-debugging-address="))).toBe(false);
  });

  test("ignores out-of-range / non-integer ports and warns", () => {
    for (const bad of [0, -1, 70000, 9222.5, Number.NaN]) {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const args = buildAppModeArgs(URL, DIR, undefined, undefined, undefined, bad);
      expect(args.some((a) => a.startsWith("--remote-debugging-port="))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  });
});
