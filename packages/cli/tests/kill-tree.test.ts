// ui-leaf#67: teardown must signal only the process tree we spawned, never a
// sibling mount's Chrome window. collectDescendantPids is the pure core of that
// scoping — given a process-table snapshot it returns the root pid plus its
// transitive descendants, and nothing else.

import { describe, expect, test } from "bun:test";

import { collectDescendantPids } from "../src/server.ts";

describe("collectDescendantPids (ui-leaf#67)", () => {
  test("returns the root plus its transitive descendants", () => {
    const procs = [
      { pid: 100, ppid: 1 }, // our chrome (root)
      { pid: 101, ppid: 100 }, // renderer
      { pid: 102, ppid: 100 }, // gpu
      { pid: 103, ppid: 101 }, // nested helper
    ];
    const tree = collectDescendantPids(100, procs).sort((a, b) => a - b);
    expect(tree).toEqual([100, 101, 102, 103]);
  });

  test("excludes a sibling tree that shares no ancestry", () => {
    const procs = [
      { pid: 100, ppid: 1 }, // our chrome
      { pid: 101, ppid: 100 }, // our helper
      { pid: 200, ppid: 1 }, // a SIBLING mount's chrome
      { pid: 201, ppid: 200 }, // sibling's helper
    ];
    const tree = collectDescendantPids(100, procs);
    expect(tree).toContain(100);
    expect(tree).toContain(101);
    expect(tree).not.toContain(200);
    expect(tree).not.toContain(201);
  });

  test("returns just the root when it has no children", () => {
    expect(collectDescendantPids(100, [{ pid: 100, ppid: 1 }])).toEqual([100]);
  });

  test("returns just the root when the process table is empty", () => {
    expect(collectDescendantPids(100, [])).toEqual([100]);
  });

  test("does not loop forever on a cyclic parent/child table", () => {
    // Defensive: a malformed snapshot (pid is its own ancestor) must terminate.
    const procs = [
      { pid: 100, ppid: 101 },
      { pid: 101, ppid: 100 },
    ];
    const tree = collectDescendantPids(100, procs).sort((a, b) => a - b);
    expect(tree).toEqual([100, 101]);
  });
});
