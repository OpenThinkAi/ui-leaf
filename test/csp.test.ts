import { describe, test, expect } from "bun:test";
import { mount } from "../packages/cli/src/index.ts";
import { join } from "node:path";

const VIEWS_ROOT = join(import.meta.dir, "fixtures");

// The strict preset directives expected in every "strict" mount.
const STRICT_DIRECTIVES = [
  "default-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
];

describe("CSP", () => {
  test(
    "default mount sends strict CSP header on GET /",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
      });
      try {
        const resp = await fetch(view.url);
        const csp = resp.headers.get("content-security-policy");
        expect(csp).not.toBeNull();
        for (const directive of STRICT_DIRECTIVES) {
          expect(csp).toContain(directive);
        }
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "strict preset includes connect-src 'self' (blocks cross-origin fetch)",
    async () => {
      // Browser behavior: connect-src 'self' causes the browser to block
      // fetch() to any non-same-origin URL. This test verifies the directive
      // is present in the header — the actual browser block is not unit-testable.
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        csp: "strict",
      });
      try {
        const resp = await fetch(view.url);
        const csp = resp.headers.get("content-security-policy");
        expect(csp).toContain("connect-src 'self'");
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "strict preset includes form-action 'self' (blocks cross-origin form submission)",
    async () => {
      // Browser behavior: form-action 'self' causes the browser to block
      // form submissions to any non-same-origin action. This test verifies
      // the directive is present in the header.
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        csp: "strict",
      });
      try {
        const resp = await fetch(view.url);
        const csp = resp.headers.get("content-security-policy");
        expect(csp).toContain("form-action 'self'");
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "same-origin endpoints succeed under default strict CSP",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
      });
      try {
        // GET / — the main view
        const root = await fetch(view.url);
        expect(root.status).toBe(200);

        // POST /heartbeat — no token needed for heartbeat
        const hb = await fetch(`${view.url}/heartbeat`, { method: "POST" });
        expect(hb.status).toBeLessThan(500);

        // GET /events — SSE endpoint
        const sse = await fetch(`${view.url}/events`);
        expect(sse.status).toBeLessThan(500);
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "strict preset includes img-src with https: (HTTPS images load)",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        csp: "strict",
      });
      try {
        const resp = await fetch(view.url);
        const csp = resp.headers.get("content-security-policy");
        expect(csp).toContain("img-src");
        expect(csp).toContain("https:");
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "csp: 'off' sends no Content-Security-Policy header",
    async () => {
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        csp: "off",
      });
      try {
        const resp = await fetch(view.url);
        expect(resp.headers.get("content-security-policy")).toBeNull();
      } finally {
        await view.close();
      }
    },
    30_000,
  );

  test(
    "csp: '<custom>' passes the string through verbatim",
    async () => {
      const customCsp =
        "default-src 'self'; connect-src 'self' https://sentry.io; img-src 'self' https:";
      const view = await mount({
        view: "minimal",
        viewsRoot: VIEWS_ROOT,
        openBrowser: false,
        silent: true,
        port: 0,
        csp: customCsp,
      });
      try {
        const resp = await fetch(view.url);
        expect(resp.headers.get("content-security-policy")).toBe(customCsp);
      } finally {
        await view.close();
      }
    },
    30_000,
  );
});
