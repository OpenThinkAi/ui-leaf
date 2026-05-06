import { describe, test, expect } from "bun:test";
import { mount } from "../src/index.ts";
import * as vm from "node:vm";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

describe("prototype pollution hardening", () => {
  test(
    "__proto__ key lands as own property, not prototype mutation",
    async () => {
      // JSON.parse creates an object where __proto__ is an own data property.
      // Before the fix, interpolating this into a JS object literal would
      // have triggered Annex B.3.1 and mutated the prototype instead.
      const data = JSON.parse('{"__proto__": {"polluted": true}}');

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

        const ctx = vm.createContext({ window: {} });
        vm.runInContext(match[1], ctx);

        // Assertion 1 (AC #2a): prototype must be the plain Object prototype,
        // not the attacker-supplied { polluted: true } object.
        // Run inside the vm so Object.prototype is the same realm.
        const protoIsClean = vm.runInContext(
          "Object.getPrototypeOf(window.__UI_LEAF__.data) === Object.prototype",
          ctx,
        ) as boolean;
        expect(protoIsClean).toBe(true);

        // Assertion 2 (AC #2b): __proto__ must be an own property with value
        // { polluted: true }. Serialize via vm JSON to avoid cross-realm issues.
        const protoOwnJson = vm.runInContext(
          "JSON.stringify(window.__UI_LEAF__.data.__proto__)",
          ctx,
        ) as string;
        expect(JSON.parse(protoOwnJson)).toEqual({ polluted: true });
      } finally {
        await view.close();
      }
    },
    60_000,
  );
});
