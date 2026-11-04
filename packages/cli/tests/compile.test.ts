import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { compileView } from "../src/compile.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

describe("compileView", () => {
  test(
    "successful build of a trivial view returns html and no errors",
    async () => {
      const result = await compileView({
        entry: "trivial",
        viewsRoot: VIEWS_ROOT,
      });
      expect(result.errors).toHaveLength(0);
      expect(result.html).toContain("<!doctype html>");
      expect(result.html).toContain('<div id="root">');
      expect(result.html).toContain('<script type="module">');
      expect(result.html).toContain("<!-- ui-leaf bootstrap -->");
    },
    30_000,
  );

  test(
    "JSX support: view with nested JSX compiles without errors",
    async () => {
      const result = await compileView({
        entry: "with-jsx",
        viewsRoot: VIEWS_ROOT,
      });
      expect(result.errors).toHaveLength(0);
      expect(result.html).toContain("<!doctype html>");
    },
    30_000,
  );

  test(
    "syntax error surfaces in errors array without throwing",
    async () => {
      const result = await compileView({
        entry: "with-syntax-error",
        viewsRoot: VIEWS_ROOT,
      });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        message: expect.any(String),
        line: expect.any(Number),
        column: expect.any(Number),
        file: expect.any(String),
      });
    },
    30_000,
  );

  test(
    "unresolved import surfaces in errors array without throwing",
    async () => {
      const result = await compileView({
        entry: "with-bad-import",
        viewsRoot: VIEWS_ROOT,
      });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        message: expect.any(String),
      });
    },
    30_000,
  );

  test("title is HTML-escaped in the output", async () => {
    const result = await compileView({
      entry: "trivial",
      viewsRoot: VIEWS_ROOT,
      title: "<My & App>",
    });
    expect(result.errors).toHaveLength(0);
    expect(result.html).toContain("<title>&lt;My &amp; App&gt;</title>");
    expect(result.html).not.toContain("<title><My & App></title>");
  }, 30_000);

  test("CSP meta tag is emitted when csp option is set", async () => {
    const csp = "default-src 'self'; script-src 'self'";
    const result = await compileView({
      entry: "trivial",
      viewsRoot: VIEWS_ROOT,
      csp,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.html).toContain("Content-Security-Policy");
    expect(result.html).toContain("default-src 'self'");
  }, 30_000);

  test("output carries no data and bootstraps from /api/data (AGT-2350)", async () => {
    const result = await compileView({
      entry: "trivial",
      viewsRoot: VIEWS_ROOT,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.html).toContain("window.__UI_LEAF__ = {};");
    // The bundle bootstraps from the token-gated endpoint instead.
    expect(result.html).toContain("/api/data");
  }, 30_000);
});
