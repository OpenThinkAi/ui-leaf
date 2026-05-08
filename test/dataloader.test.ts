import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import * as vm from "node:vm";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

describe("dataLoader", () => {
  test(
    "loader value is served via /api/data and HTML contains no inlined data field",
    async () => {
      const secret = { message: "sensitive", amount: 42 };

      let capturedUrl = "";
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: true,
        silent: true,
        port: 0,
        dataLoader: () => Promise.resolve(secret),
        _opener: async (url) => {
          capturedUrl = url;
        },
      });

      try {
        const resp = await fetch(view.url);
        const html = await resp.text();

        const match = /<script>([^<]*window\.__UI_LEAF__[^<]*)<\/script>/.exec(html);
        if (!match?.[1]) throw new Error("inline __UI_LEAF__ script not found in HTML");

        const ctx = vm.createContext({
          window: { location: { hash: "", pathname: "/", search: "" } },
          history: { replaceState: () => {} },
        });
        vm.runInContext(match[1], ctx);

        // AC #3: inlined script must NOT have a data field.
        const hasDataField = vm.runInContext(
          "Object.prototype.hasOwnProperty.call(window.__UI_LEAF__, 'data')",
          ctx,
        ) as boolean;
        expect(hasDataField).toBe(false);

        // AC #1: /api/data with the bearer token returns the loader's value.
        // Token is delivered via URL fragment to the opener, never inlined.
        const tokenMatch = /[#&]token=([^&#]*)/.exec(capturedUrl);
        if (!tokenMatch?.[1]) throw new Error("token not found in opener URL");
        const token = decodeURIComponent(tokenMatch[1]);
        const dataResp = await fetch(`${view.url}/api/data`, {
          headers: { "X-UI-Leaf-Token": token },
        });
        expect(dataResp.status).toBe(200);
        const body = await dataResp.json();
        expect(body).toEqual(secret);
      } finally {
        await view.close();
      }
    },
    60_000,
  );

  test(
    "GET /api/data without Authorization header returns 401",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        dataLoader: () => Promise.resolve({ ok: true }),
      });

      try {
        // AC #2: no token → 401, nothing written to response body beyond error.
        const resp = await fetch(`${view.url}/api/data`);
        expect(resp.status).toBe(401);
        const body = await resp.json();
        expect(body).toEqual({ error: "unauthorized" });
      } finally {
        await view.close();
      }
    },
    60_000,
  );

  test(
    "supplying both data and dataLoader throws at mount time",
    async () => {
      // AC #1 (mutual exclusion): mount must reject before any server starts.
      await expect(
        mount({
          view: "minimal",
          viewsRoot: VIEWS_ROOT,
          openBrowser: false,
          silent: true,
          port: 0,
          data: { foo: 1 },
          dataLoader: () => Promise.resolve({ bar: 2 }),
        }),
      ).rejects.toThrow("ui-leaf: pass data or dataLoader, not both");
    },
    60_000,
  );
});
