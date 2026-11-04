import { describe, test, expect } from "bun:test";
import { startDevServer } from "../packages/cli/src/server.ts";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

describe("prototype pollution hardening", () => {
  test(
    "__proto__ key lands as own property, not prototype mutation",
    async () => {
      // JSON.parse creates an object where __proto__ is an own data property.
      // Data reaches the page only as a JSON body from /api/data (AGT-2350),
      // parsed with res.json() — JSON.parse semantics — so it can never be
      // interpolated into a JS object literal (Annex B.3.1).
      const data = JSON.parse('{"__proto__": {"polluted": true}}');

      let openedUrl = "";
      const srv = await startDevServer({
        _env: {},
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        data,
        port: 0,
        openBrowser: true,
        _opener: async (u: string) => { openedUrl = u; },
        silent: true,
      });

      try {
        const html = await (await fetch(srv.url + "/")).text();
        expect(html).not.toContain("polluted");

        const token = /#token=([0-9a-f]+)/.exec(openedUrl)?.[1];
        if (!token) throw new Error(`no token in opened URL: ${openedUrl}`);
        const body = await (
          await fetch(srv.url + "/api/data", { headers: { "X-UI-Leaf-Token": token } })
        ).text();
        const parsed = JSON.parse(body) as Record<string, unknown>;

        expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
        expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
        expect(parsed["__proto__"]).toEqual({ polluted: true });
      } finally {
        await srv.close();
      }
    },
    60_000,
  );
});
