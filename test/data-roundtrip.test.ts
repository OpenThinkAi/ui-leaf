import { describe, test, expect } from "bun:test";
import { startDevServer } from "../packages/cli/src/server.ts";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

describe("data round-trip", () => {
  test(
    "dates, nested objects, arrays, and unicode survive the /api/data path unchanged",
    async () => {
      const data = {
        isoDate: "2024-01-15T10:30:00.000Z",
        nested: { nums: [1, 2, 3], flag: true },
        unicode: "日本\u{1F600}",
      };

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
        const token = /#token=([0-9a-f]+)/.exec(openedUrl)?.[1];
        if (!token) throw new Error(`no token in opened URL: ${openedUrl}`);
        const resp = await fetch(srv.url + "/api/data", {
          headers: { "X-UI-Leaf-Token": token },
        });
        expect(resp.status).toBe(200);
        // The browser does exactly this: res.json() on the /api/data body.
        expect(await resp.json()).toEqual(data);
      } finally {
        await srv.close();
      }
    },
    60_000,
  );
});
