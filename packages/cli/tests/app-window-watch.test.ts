// ui-leaf#101: unit tests for the shell:"app" lifecycle helpers — the CDP
// pipe client, the page-target window watcher, and the parent-pid watcher.

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { watchAppWindows } from "../src/internal/app-window-watch.ts";
import { countPageTargets, createCdpPipeClient } from "../src/internal/cdp-pipe.ts";
import { watchParent } from "../src/internal/parent-watch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchAppWindows", () => {
  test("fires onEmpty once page targets have been gone for the grace period", async () => {
    let pages = 1;
    let fired = 0;
    const w = watchAppWindows({
      countPages: async () => pages,
      onEmpty: () => fired++,
      intervalMs: 5,
      emptyGraceMs: 40,
      launchGraceMs: 10_000,
    });
    await sleep(30);
    expect(fired).toBe(0);
    pages = 0;
    await sleep(120);
    expect(fired).toBe(1);
    await sleep(40);
    expect(fired).toBe(1); // at most once
    w.stop();
  });

  test("never fires while a page target exists (minimized window keeps its target)", async () => {
    let fired = 0;
    const w = watchAppWindows({
      countPages: async () => 1,
      onEmpty: () => fired++,
      intervalMs: 5,
      emptyGraceMs: 10,
      launchGraceMs: 10,
    });
    await sleep(100);
    expect(fired).toBe(0);
    w.stop();
  });

  test("a page reappearing within the grace period resets the clock", async () => {
    let pages = 1;
    let fired = 0;
    const w = watchAppWindows({
      countPages: async () => pages,
      onEmpty: () => fired++,
      intervalMs: 5,
      emptyGraceMs: 80,
      launchGraceMs: 10_000,
    });
    await sleep(20);
    pages = 0;
    await sleep(40);
    pages = 1;
    await sleep(40);
    pages = 0;
    await sleep(40);
    expect(fired).toBe(0);
    w.stop();
  });

  test("failed probes (null) never count as zero windows", async () => {
    let fired = 0;
    const w = watchAppWindows({
      countPages: async () => null,
      onEmpty: () => fired++,
      intervalMs: 5,
      emptyGraceMs: 10,
      launchGraceMs: 10,
    });
    await sleep(100);
    expect(fired).toBe(0);
    w.stop();
  });

  test("uses the launch grace when no page was ever seen", async () => {
    let fired = 0;
    const w = watchAppWindows({
      countPages: async () => 0,
      onEmpty: () => fired++,
      intervalMs: 5,
      emptyGraceMs: 10,
      launchGraceMs: 150,
    });
    await sleep(60);
    expect(fired).toBe(0); // emptyGrace alone would have fired by now
    await sleep(200);
    expect(fired).toBe(1);
    w.stop();
  });

  test("stop() prevents a later onEmpty", async () => {
    let fired = 0;
    const w = watchAppWindows({
      countPages: async () => 0,
      onEmpty: () => fired++,
      intervalMs: 5,
      emptyGraceMs: 30,
      launchGraceMs: 30,
    });
    w.stop();
    await sleep(80);
    expect(fired).toBe(0);
  });
});

// A fake Chrome end of the pipe: reads NUL-framed requests from `toChrome`,
// answers on `fromChrome` via `respond`.
function fakePipe(respond: (msg: { id: number; method: string }) => unknown) {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const seen: string[] = [];
  let buf = "";
  toChrome.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nul: number;
    while ((nul = buf.indexOf("\0")) !== -1) {
      const msg = JSON.parse(buf.slice(0, nul));
      buf = buf.slice(nul + 1);
      seen.push(msg.method);
      const reply = respond(msg);
      if (reply !== undefined) fromChrome.write(`${JSON.stringify(reply)}\0`);
    }
  });
  return { toChrome, fromChrome, seen };
}

describe("createCdpPipeClient", () => {
  test("correlates replies by id, across chunked frames", async () => {
    const { toChrome, fromChrome } = fakePipe(() => undefined);
    const client = createCdpPipeClient(toChrome, fromChrome);
    const a = client.call("A.one");
    const b = client.call("B.two");
    // Reply out of order, split mid-frame, with an event interleaved.
    const frames =
      `${JSON.stringify({ id: 2, result: { v: "b" } })}\0` +
      `${JSON.stringify({ method: "Target.targetCreated", params: {} })}\0` +
      `${JSON.stringify({ id: 1, result: { v: "a" } })}\0`;
    fromChrome.write(frames.slice(0, 10));
    fromChrome.write(frames.slice(10));
    expect(await a).toEqual({ v: "a" });
    expect(await b).toEqual({ v: "b" });
    client.close();
  });

  test("rejects on a CDP error reply", async () => {
    const { toChrome, fromChrome } = fakePipe((m) => ({ id: m.id, error: { message: "nope" } }));
    const client = createCdpPipeClient(toChrome, fromChrome);
    await expect(client.call("X.y")).rejects.toThrow("nope");
    client.close();
  });

  test("times out an unanswered call", async () => {
    const { toChrome, fromChrome } = fakePipe(() => undefined);
    const client = createCdpPipeClient(toChrome, fromChrome);
    await expect(client.call("X.y", {}, 20)).rejects.toThrow("timed out");
    client.close();
  });

  test("pipe end rejects pending calls and later calls", async () => {
    const { toChrome, fromChrome } = fakePipe(() => undefined);
    const client = createCdpPipeClient(toChrome, fromChrome);
    const pending = client.call("X.y", {}, 5000);
    fromChrome.end();
    fromChrome.resume();
    await expect(pending).rejects.toThrow("closed");
    expect(client.closed).toBe(true);
    await expect(client.call("X.z")).rejects.toThrow("closed");
  });

  test("countPageTargets counts only page targets, null on failure", async () => {
    const { toChrome, fromChrome } = fakePipe((m) => ({
      id: m.id,
      result: {
        targetInfos: [
          { type: "page" },
          { type: "service_worker" },
          { type: "background_page" },
          { type: "page" },
        ],
      },
    }));
    const client = createCdpPipeClient(toChrome, fromChrome);
    expect(await countPageTargets(client)).toBe(2);
    client.close();
    expect(await countPageTargets(client)).toBeNull();
  });
});

describe("watchParent", () => {
  test("fires once when the parent pid changes", async () => {
    let ppid = 4242;
    let fired = 0;
    const w = watchParent({ getPpid: () => ppid, onParentGone: () => fired++, intervalMs: 5 });
    await sleep(30);
    expect(fired).toBe(0);
    ppid = 1; // reparented to init/launchd
    await sleep(30);
    expect(fired).toBe(1);
    ppid = 7;
    await sleep(30);
    expect(fired).toBe(1);
    w.stop();
  });

  test("stop() disarms it", async () => {
    let ppid = 4242;
    let fired = 0;
    const w = watchParent({ getPpid: () => ppid, onParentGone: () => fired++, intervalMs: 5 });
    w.stop();
    ppid = 1;
    await sleep(30);
    expect(fired).toBe(0);
  });
});
