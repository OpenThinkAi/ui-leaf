import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import * as vm from "node:vm";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

// Fast timing: grace=50ms, timeout=200ms, check=50ms.
// Worst-case detection latency = 50 + 200 + 50 = 300ms.
const FAST_OPTS = {
  heartbeatTimeoutMs: 200,
  startupGraceMs: 50,
  _heartbeatCheckIntervalMs: 50,
} as const;

async function getToken(url: string): Promise<string> {
  const resp = await fetch(url);
  const html = await resp.text();
  const match = /<script>([^<]*window\.__UI_LEAF__[^<]*)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("inline __UI_LEAF__ script not found in HTML");
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(match[1], ctx);
  return vm.runInContext("window.__UI_LEAF__.token", ctx) as string;
}

async function sendHeartbeat(url: string, token: string): Promise<void> {
  await fetch(`${url}/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function waitForEvent(
  view: { on: (event: string, fn: () => void) => void; off: (event: string, fn: () => void) => void },
  event: string,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      view.off(event, handler);
      reject(new Error(`timed out waiting for '${event}' event after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (): void => {
      clearTimeout(timer);
      resolve();
    };
    view.on(event, handler);
  });
}

describe("disconnect/reconnect lifecycle", () => {
  test(
    "AC #1: heartbeat timeout emits disconnected but does not terminate mount",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        ...FAST_OPTS,
      });

      try {
        const token = await getToken(view.url);
        // Trigger connected state, then go silent.
        await sendHeartbeat(view.url, token);

        await waitForEvent(view, "disconnected");

        // Server must still be reachable.
        const resp = await fetch(view.url);
        expect(resp.status).toBe(200);

        // closed should NOT have resolved.
        let closedFired = false;
        view.closed.then(() => { closedFired = true; });
        await new Promise((r) => setTimeout(r, 100));
        expect(closedFired).toBe(false);
      } finally {
        await view.close();
      }
    },
    10_000,
  );

  test(
    "AC #3: resuming heartbeats after disconnect emits reconnected",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        ...FAST_OPTS,
      });

      const events: string[] = [];
      view.on("disconnected", () => events.push("disconnected"));
      view.on("reconnected", () => events.push("reconnected"));

      try {
        const token = await getToken(view.url);
        await sendHeartbeat(view.url, token);

        await waitForEvent(view, "disconnected");

        // Register reconnected listener BEFORE sending heartbeat, because
        // the event fires synchronously inside the fetch response handler.
        const reconnectedP = waitForEvent(view, "reconnected");
        await sendHeartbeat(view.url, token);
        await reconnectedP;

        expect(events).toEqual(["disconnected", "reconnected"]);
      } finally {
        await view.close();
      }
    },
    10_000,
  );

  test(
    "AC #4: multiple disconnect/reconnect cycles each emit the right events",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        ...FAST_OPTS,
      });

      const events: string[] = [];
      view.on("disconnected", () => events.push("disconnected"));
      view.on("reconnected", () => events.push("reconnected"));

      try {
        const token = await getToken(view.url);

        for (let i = 0; i < 2; i++) {
          await sendHeartbeat(view.url, token);
          await waitForEvent(view, "disconnected");

          const reconnectedP = waitForEvent(view, "reconnected");
          await sendHeartbeat(view.url, token);
          await reconnectedP;
        }

        expect(events).toEqual([
          "disconnected",
          "reconnected",
          "disconnected",
          "reconnected",
        ]);
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "AC #5: view swap applied while disconnected is served after reconnect",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        ...FAST_OPTS,
      });

      try {
        const token = await getToken(view.url);
        await sendHeartbeat(view.url, token);

        await waitForEvent(view, "disconnected");

        // Swap the view while disconnected — should recompile and update viewState.html.
        const MARKER = "uilf-ac5-marker-reconnect";
        const errors = await view.swapView(
          `import { createElement } from "react";
export default function V() { return createElement("div", { id: "${MARKER}" }); }`,
        );
        expect(errors).toHaveLength(0);

        // Register reconnected listener BEFORE sending heartbeat.
        const reconnectedP = waitForEvent(view, "reconnected");
        await sendHeartbeat(view.url, token);
        await reconnectedP;

        // Re-fetch: the swapped HTML should now contain the marker.
        const resp = await fetch(view.url);
        expect(resp.status).toBe(200);
        const html = await resp.text();
        expect(html).toContain(MARKER);
      } finally {
        await view.close();
      }
    },
    20_000,
  );

  test(
    "AC #8: tab close → disconnected (no closed); reopen → reconnected; caller close → closed",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        ...FAST_OPTS,
      });

      const events: string[] = [];
      view.on("disconnected", () => events.push("disconnected"));
      view.on("reconnected", () => events.push("reconnected"));

      const token = await getToken(view.url);
      await sendHeartbeat(view.url, token);

      // Step 1: tab goes silent → disconnected.
      await waitForEvent(view, "disconnected");
      expect(events).toContain("disconnected");

      // Step 2: register reconnected listener BEFORE sending heartbeat.
      const reconnectedP = waitForEvent(view, "reconnected");
      await sendHeartbeat(view.url, token);
      await reconnectedP;
      expect(events).toContain("reconnected");

      // Step 3: caller close → closed with reason "caller".
      const closedP = view.closed;
      await view.close();
      expect(await closedP).toBe("caller");
    },
    10_000,
  );
});
