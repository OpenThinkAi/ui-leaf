import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import * as vm from "node:vm";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

describe("data round-trip", () => {
  test(
    "dates, nested objects, arrays, and unicode survive the inline-script path unchanged",
    async () => {
      const data = {
        isoDate: "2024-01-15T10:30:00.000Z",
        nested: { nums: [1, 2, 3], flag: true },
        unicode: "日本\u{1F600}",
      };

      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        data,
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

        // Serialize from the vm context to avoid cross-realm object comparison.
        const resultJson = vm.runInContext(
          "JSON.stringify(window.__UI_LEAF__.data)",
          ctx,
        ) as string;
        expect(JSON.parse(resultJson)).toEqual(data);
      } finally {
        await view.close();
      }
    },
    60_000,
  );
});
