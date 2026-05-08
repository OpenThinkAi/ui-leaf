import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

// Fast timing: grace=50ms, timeout=200ms, check=50ms.
// Worst-case detection latency = 50 + 200 + 50 = 300ms.
const FAST_OPTS = {
  heartbeatTimeoutMs: 200,
  startupGraceMs: 50,
  _heartbeatCheckIntervalMs: 50,
} as const;

// Capture the launch URL via the _opener test seam and pull the token from
// its fragment. The token is delivered via URL fragment to the opener and
// never inlined into the HTML body, so this is the only way to get it.
function tokenCapture(): { capture: (url: string) => Promise<void>; getToken: () => string } {
  let captured = "";
  return {
    capture: async (url: string) => {
      captured = url;
    },
    getToken: () => {
      const m = /[#&]token=([^&#]*)/.exec(captured);
      if (!m?.[1]) throw new Error("token not found in opener URL");
      return decodeURIComponent(m[1]);
    },
  };
}

async function sendHeartbeat(url: string, token: string): Promise<void> {
  await fetch(`${url}/heartbeat`, {
    method: "POST",
    headers: { "X-UI-Leaf-Token": token },
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
      const tc = tokenCapture();
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: true,
        silent: true,
        port: 0,
        ...FAST_OPTS,
        _opener: tc.capture,
      });

      try {
        const token = tc.getToken();
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
      const tc = tokenCapture();
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: true,
        silent: true,
        port: 0,
        ...FAST_OPTS,
        _opener: tc.capture,
      });

      const events: string[] = [];
      view.on("disconnected", () => events.push("disconnected"));
      view.on("reconnected", () => events.push("reconnected"));

      try {
        const token = tc.getToken();
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
      const tc = tokenCapture();
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: true,
        silent: true,
        port: 0,
        ...FAST_OPTS,
        _opener: tc.capture,
      });

      const events: string[] = [];
      view.on("disconnected", () => events.push("disconnected"));
      view.on("reconnected", () => events.push("reconnected"));

      try {
        const token = tc.getToken();

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
      const tc = tokenCapture();
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: true,
        silent: true,
        port: 0,
        ...FAST_OPTS,
        _opener: tc.capture,
      });

      try {
        const token = tc.getToken();
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
      const tc = tokenCapture();
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: true,
        silent: true,
        port: 0,
        ...FAST_OPTS,
        _opener: tc.capture,
      });

      const events: string[] = [];
      view.on("disconnected", () => events.push("disconnected"));
      view.on("reconnected", () => events.push("reconnected"));

      const token = tc.getToken();
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
