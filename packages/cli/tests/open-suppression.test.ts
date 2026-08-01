import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import {
  startDevServer,
  resolveOpenSuppression,
  type DevServer,
} from "../src/server.ts";

const VIEWS_ROOT = join(import.meta.dir, "fixtures/views");

let server: DevServer | null = null;
let restoreStderr: (() => void) | null = null;

afterEach(async () => {
  restoreStderr?.();
  restoreStderr = null;
  if (server) {
    await server.close();
    server = null;
  }
});

// Capture process.stderr.write output for the lifetime of one test.
// The suppression notice is written directly to process.stderr.
function captureStderr(): { output: () => string } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    // Swallow the write in tests; pass-through would interleave with the
    // bun test reporter. Callbacks (if any) still fire via the original
    // signature contract — none of our writes pass one.
    void rest;
    return true;
  }) as typeof process.stderr.write;
  restoreStderr = () => {
    process.stderr.write = original;
  };
  return { output: () => chunks.join("") };
}

// ── resolveOpenSuppression — pure resolution table ──────────────────────────

describe("resolveOpenSuppression", () => {
  test("empty env → no suppression", () => {
    expect(resolveOpenSuppression({})).toBeNull();
  });

  test("UI_LEAF_NO_OPEN=1 → env suppression", () => {
    expect(resolveOpenSuppression({ UI_LEAF_NO_OPEN: "1" })).toBe("env");
  });

  test("UI_LEAF_NO_OPEN=true (any truthy spelling) → env suppression", () => {
    expect(resolveOpenSuppression({ UI_LEAF_NO_OPEN: "true" })).toBe("env");
    expect(resolveOpenSuppression({ UI_LEAF_NO_OPEN: "yes" })).toBe("env");
    expect(resolveOpenSuppression({ UI_LEAF_NO_OPEN: " TRUE " })).toBe("env");
  });

  test("falsy spellings force-open, even under SSH", () => {
    for (const v of ["0", "false", "no", "FALSE", " No "]) {
      expect(
        resolveOpenSuppression({ UI_LEAF_NO_OPEN: v, SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }),
      ).toBeNull();
    }
  });

  test("empty-string UI_LEAF_NO_OPEN is treated as unset (falls through to SSH check)", () => {
    expect(resolveOpenSuppression({ UI_LEAF_NO_OPEN: "" })).toBeNull();
    expect(
      resolveOpenSuppression({ UI_LEAF_NO_OPEN: "", SSH_TTY: "/dev/ttys002" }),
    ).toBe("ssh");
  });

  test("SSH_CONNECTION or SSH_TTY → ssh suppression", () => {
    expect(resolveOpenSuppression({ SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" })).toBe("ssh");
    expect(resolveOpenSuppression({ SSH_TTY: "/dev/ttys002" })).toBe("ssh");
  });

  test("explicit UI_LEAF_NO_OPEN wins over SSH for the reason label", () => {
    expect(
      resolveOpenSuppression({ UI_LEAF_NO_OPEN: "1", SSH_TTY: "/dev/ttys002" }),
    ).toBe("env");
  });
});

// ── startDevServer integration — launch vs stderr notice ────────────────────

describe("environment-level launch suppression", () => {
  test(
    "UI_LEAF_NO_OPEN suppresses the launch and prints the tokened URL to stderr",
    async () => {
      let openerCalls = 0;
      const stderr = captureStderr();
      server = await startDevServer({
        _env: { UI_LEAF_NO_OPEN: "1" },
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async () => {
          openerCalls += 1;
        },
      });

      expect(openerCalls).toBe(0);
      const out = stderr.output();
      expect(out).toContain("UI_LEAF_NO_OPEN is set");
      // The printed URL must carry the token fragment — without it the page
      // renders but every authed endpoint 401s.
      expect(out).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}/);
      expect(out).toContain(`ssh -L ${server.port}:127.0.0.1:${server.port}`);
    },
    30_000,
  );

  test(
    "SSH session auto-suppresses with its own reason",
    async () => {
      let openerCalls = 0;
      const stderr = captureStderr();
      server = await startDevServer({
        _env: { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" },
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async () => {
          openerCalls += 1;
        },
      });

      expect(openerCalls).toBe(0);
      expect(stderr.output()).toContain("SSH session detected");
    },
    30_000,
  );

  test(
    "UI_LEAF_NO_OPEN=0 overrides SSH auto-detection and launches",
    async () => {
      let capturedUrl = "";
      server = await startDevServer({
        _env: { UI_LEAF_NO_OPEN: "0", SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" },
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async (u) => {
          capturedUrl = u;
        },
      });

      expect(capturedUrl).toMatch(/#token=[0-9a-f]{64}$/);
    },
    30_000,
  );

  test(
    "openBrowser: false stays silent — no launch, no notice",
    async () => {
      let openerCalls = 0;
      const stderr = captureStderr();
      server = await startDevServer({
        _env: { UI_LEAF_NO_OPEN: "1" },
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: false,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async () => {
          openerCalls += 1;
        },
      });

      expect(openerCalls).toBe(0);
      expect(stderr.output()).not.toContain("UI_LEAF_NO_OPEN");
    },
    30_000,
  );

  test(
    "reopen() under suppression re-prints the notice instead of launching",
    async () => {
      let openerCalls = 0;
      const stderr = captureStderr();
      server = await startDevServer({
        _env: { SSH_TTY: "/dev/ttys002" },
        view: "trivial",
        viewsRoot: VIEWS_ROOT,
        data: {},
        port: 0,
        openBrowser: true,
        heartbeatTimeoutMs: 75_000,
        startupGraceMs: 0,
        silent: true,
        _opener: async () => {
          openerCalls += 1;
        },
      });

      await server.reopen();
      expect(openerCalls).toBe(0);
      const notices = stderr.output().match(/SSH session detected/g) ?? [];
      expect(notices.length).toBe(2);
    },
    30_000,
  );
});
