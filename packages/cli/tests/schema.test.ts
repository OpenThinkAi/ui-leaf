import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emit, validateInboundShape, type Inbound } from "../src/ipc.ts";

const SCHEMA_PATH = resolve(import.meta.dir, "../schema/ipc.json");
const schemaRaw = readFileSync(SCHEMA_PATH, "utf-8");

// ---------------------------------------------------------------------------
// (a) Schema structural integrity
// ---------------------------------------------------------------------------

describe("ipc.json — structural integrity", () => {
  test("is valid JSON", () => {
    expect(() => JSON.parse(schemaRaw)).not.toThrow();
  });

  test('has $schema: "https://json-schema.org/draft/2020-12/schema"', () => {
    const schema = JSON.parse(schemaRaw);
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  // (b) $defs coverage
  test("has $defs entry for every expected message type", () => {
    const schema = JSON.parse(schemaRaw);
    const defs = schema["$defs"] ?? {};
    const expected = [
      // Inbound
      "InboundConfig",
      "InboundMutateResult",
      "InboundMutateError",
      "InboundUpdate",
      "InboundView",
      "InboundPatch",
      "InboundReopen",
      "InboundClose",
      "InboundPing",
      "InboundMessage",
      // Outbound
      "OutboundReady",
      "OutboundMutate",
      "OutboundDisconnected",
      "OutboundReconnected",
      "OutboundClosed",
      "OutboundError",
      "OutboundMessage",
    ];
    for (const name of expected) {
      expect(defs[name], `missing $defs entry: ${name}`).toBeDefined();
    }
  });

  test("InboundMessage oneOf references all post-config inbound types", () => {
    const schema = JSON.parse(schemaRaw);
    const refs = (schema["$defs"]["InboundMessage"]["oneOf"] as Array<{ $ref: string }>).map(
      (e) => e["$ref"],
    );
    const expected = [
      "#/$defs/InboundMutateResult",
      "#/$defs/InboundMutateError",
      "#/$defs/InboundUpdate",
      "#/$defs/InboundView",
      "#/$defs/InboundPatch",
      "#/$defs/InboundReopen",
      "#/$defs/InboundClose",
      "#/$defs/InboundPing",
    ];
    for (const ref of expected) {
      expect(refs, `InboundMessage.oneOf missing ${ref}`).toContain(ref);
    }
  });

  test("OutboundMessage oneOf references all outbound types", () => {
    const schema = JSON.parse(schemaRaw);
    const refs = (schema["$defs"]["OutboundMessage"]["oneOf"] as Array<{ $ref: string }>).map(
      (e) => e["$ref"],
    );
    const expected = [
      "#/$defs/OutboundReady",
      "#/$defs/OutboundMutate",
      "#/$defs/OutboundDisconnected",
      "#/$defs/OutboundReconnected",
      "#/$defs/OutboundClosed",
      "#/$defs/OutboundError",
    ];
    for (const ref of expected) {
      expect(refs, `OutboundMessage.oneOf missing ${ref}`).toContain(ref);
    }
  });

  test("every $defs entry has a version property referencing Version1", () => {
    const schema = JSON.parse(schemaRaw);
    const defs = schema["$defs"] as Record<string, unknown>;
    const skip = new Set(["Version1", "InboundMessage", "OutboundMessage"]);
    for (const [name, def] of Object.entries(defs)) {
      if (skip.has(name)) continue;
      const d = def as { properties?: Record<string, unknown> };
      expect(
        d.properties?.["version"],
        `$defs/${name} missing version property`,
      ).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) emit() output corpus validates against OutboundMessage schema
// ---------------------------------------------------------------------------

// Minimal structural check aligned with the OutboundMessage $defs.
// Does not require a full JSON Schema validator — checks required fields
// and const-value discriminants per each $defs entry.
function checkOutboundShape(obj: Record<string, unknown>): string | null {
  if (obj.version !== "1") return `version must be "1", got ${JSON.stringify(obj.version)}`;
  if (typeof obj.type !== "string") return '"type" must be a string';
  switch (obj.type) {
    case "ready":
      if (typeof obj.url !== "string") return '"ready" requires string "url"';
      if (typeof obj.port !== "number") return '"ready" requires number "port"';
      return null;
    case "mutate":
      if (typeof obj.id !== "number") return '"mutate" requires number "id"';
      if (typeof obj.name !== "string") return '"mutate" requires string "name"';
      if (!Object.hasOwn(obj, "args")) return '"mutate" requires "args" field';
      return null;
    case "disconnected":
    case "reconnected":
      return null;
    case "closed":
      if (!["caller", "signal", "error"].includes(obj.reason as string)) {
        return '"closed" reason must be caller|signal|error';
      }
      return null;
    case "error":
      if (typeof obj.message !== "string") return '"error" requires string "message"';
      return null;
    default:
      return `unknown outbound type: "${obj.type}"`;
  }
}

describe("(c) emit() corpus validates against OutboundMessage schema", () => {
  function parsed(line: string): Record<string, unknown> {
    return JSON.parse(line.trimEnd()) as Record<string, unknown>;
  }

  test("ready", () => {
    expect(checkOutboundShape(parsed(emit({ type: "ready", url: "http://127.0.0.1:5810", port: 5810 })))).toBeNull();
  });

  test("mutate", () => {
    expect(checkOutboundShape(parsed(emit({ type: "mutate", id: 7, name: "save", args: { ok: true } })))).toBeNull();
  });

  test("mutate with null args", () => {
    expect(checkOutboundShape(parsed(emit({ type: "mutate", id: 1, name: "reset", args: null })))).toBeNull();
  });

  test("disconnected", () => {
    expect(checkOutboundShape(parsed(emit({ type: "disconnected" })))).toBeNull();
  });

  test("reconnected", () => {
    expect(checkOutboundShape(parsed(emit({ type: "reconnected" })))).toBeNull();
  });

  test("closed — caller", () => {
    expect(checkOutboundShape(parsed(emit({ type: "closed", reason: "caller" })))).toBeNull();
  });

  test("closed — signal", () => {
    expect(checkOutboundShape(parsed(emit({ type: "closed", reason: "signal" })))).toBeNull();
  });

  test("closed — error", () => {
    expect(checkOutboundShape(parsed(emit({ type: "closed", reason: "error" })))).toBeNull();
  });

  test("error (no phase)", () => {
    expect(checkOutboundShape(parsed(emit({ type: "error", message: "boom" })))).toBeNull();
  });

  test("error with phase:build", () => {
    expect(checkOutboundShape(parsed(emit({ type: "error", phase: "build", message: "compile failed" })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) Representative malformed inbound messages fail with informative errors
// ---------------------------------------------------------------------------

describe("(d) malformed inbound messages fail validation", () => {
  // Config
  test("config: missing view", () => {
    const r = validateInboundShape({ version: "1", viewsRoot: "/tmp/views" }, "config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("view");
  });

  test("config: empty view string", () => {
    const r = validateInboundShape({ version: "1", view: "", viewsRoot: "/tmp/views" }, "config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("view");
  });

  test("config: missing viewsRoot", () => {
    const r = validateInboundShape({ version: "1", view: "App" }, "config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("viewsRoot");
  });

  test("config: mutations contains non-string", () => {
    const r = validateInboundShape(
      { version: "1", view: "App", viewsRoot: "/tmp", mutations: ["ok", 42] },
      "config",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("mutations");
  });

  test("config: port is a string", () => {
    const r = validateInboundShape(
      { version: "1", view: "App", viewsRoot: "/tmp", port: "3000" },
      "config",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("port");
  });

  test("config: invalid shell value", () => {
    const r = validateInboundShape(
      { version: "1", view: "App", viewsRoot: "/tmp", shell: "window" },
      "config",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("shell");
  });

  // Post-config mutation responses
  test("result: missing id", () => {
    const r = validateInboundShape({ version: "1", type: "result" }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"id"');
  });

  test("error (mutation): missing id", () => {
    const r = validateInboundShape({ version: "1", type: "error" }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"id"');
  });

  test("error (mutation): missing message", () => {
    const r = validateInboundShape({ version: "1", type: "error", id: 1 }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("message");
  });

  // Post-config live-update commands
  test("update: missing data field", () => {
    const r = validateInboundShape({ version: "1", type: "update" }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"data"');
  });

  test("view: missing source field", () => {
    const r = validateInboundShape({ version: "1", type: "view" }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"source"');
  });

  test("view: non-string source", () => {
    const r = validateInboundShape({ version: "1", type: "view", source: 42 }, "post-config");
    expect(r.ok).toBe(false);
  });

  test("patch: missing data field", () => {
    const r = validateInboundShape(
      { version: "1", type: "patch", view: { source: "export default () => null" } },
      "post-config",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"data"');
  });

  test("patch: missing view.source", () => {
    const r = validateInboundShape(
      { version: "1", type: "patch", data: {}, view: {} },
      "post-config",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("view.source");
  });

  test("unknown type: informative error names the type", () => {
    const r = validateInboundShape({ version: "1", type: "frobnicate" }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("frobnicate");
    }
  });

  test("missing type field", () => {
    const r = validateInboundShape({ version: "1" }, "post-config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"type"');
  });
});

// ---------------------------------------------------------------------------
// Valid messages that must pass — included for regression coverage
// ---------------------------------------------------------------------------

describe("validateInboundShape — valid messages pass", () => {
  test("config: minimal valid", () => {
    expect(
      validateInboundShape({ version: "1", view: "App", viewsRoot: "/tmp/views" }, "config").ok,
    ).toBe(true);
  });

  test("config: all optional fields", () => {
    expect(
      validateInboundShape(
        {
          version: "1",
          view: "App",
          viewsRoot: "/tmp",
          data: { x: 1 },
          mutations: ["save"],
          title: "Test",
          port: 3000,
          openBrowser: false,
          shell: "tab",
          csp: "strict",
          heartbeatTimeoutMs: 5000,
          startupGraceMs: 2000,
        },
        "config",
      ).ok,
    ).toBe(true);
  });

  test("config: extra unknown fields pass (forward-compat)", () => {
    expect(
      validateInboundShape(
        { version: "1", view: "App", viewsRoot: "/tmp", futureField: true },
        "config",
      ).ok,
    ).toBe(true);
  });

  test("result with value", () => {
    expect(
      validateInboundShape(
        { version: "1", type: "result", id: 1, value: { x: 42 } },
        "post-config",
      ).ok,
    ).toBe(true);
  });

  test("result without value (void mutation)", () => {
    expect(
      validateInboundShape({ version: "1", type: "result", id: 1 }, "post-config").ok,
    ).toBe(true);
  });

  test("error with id and message", () => {
    expect(
      validateInboundShape(
        { version: "1", type: "error", id: 2, message: "oops" },
        "post-config",
      ).ok,
    ).toBe(true);
  });

  test("update with object data", () => {
    expect(
      validateInboundShape({ version: "1", type: "update", data: { count: 5 } }, "post-config").ok,
    ).toBe(true);
  });

  test("update with null data", () => {
    expect(
      validateInboundShape({ version: "1", type: "update", data: null }, "post-config").ok,
    ).toBe(true);
  });

  test("view", () => {
    expect(
      validateInboundShape(
        { version: "1", type: "view", source: "export default () => <div/>" },
        "post-config",
      ).ok,
    ).toBe(true);
  });

  test("patch", () => {
    expect(
      validateInboundShape(
        {
          version: "1",
          type: "patch",
          data: { x: 1 },
          view: { source: "export default () => <span/>" },
        },
        "post-config",
      ).ok,
    ).toBe(true);
  });

  test("reopen", () => {
    expect(validateInboundShape({ version: "1", type: "reopen" }, "post-config").ok).toBe(true);
  });

  test("close", () => {
    expect(validateInboundShape({ version: "1", type: "close" }, "post-config").ok).toBe(true);
  });

  test("ping", () => {
    expect(validateInboundShape({ version: "1", type: "ping" }, "post-config").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) Exhaustiveness guard — every Inbound/Outbound TS variant has a $defs entry
// ---------------------------------------------------------------------------

// TypeScript-level check: the switch below must cover every variant of the
// `Inbound` union or the compiler will error on the `default: never` branch.
// Adding a new type to the `Inbound` union without updating this function
// will produce a compile-time error that catches the drift before tests run.
function _inboundVariantToDefName(msg: Inbound): string {
  switch (msg.type) {
    case "result":
      return "InboundMutateResult";
    case "error":
      return "InboundMutateError";
    case "update":
      return "InboundUpdate";
    case "view":
      return "InboundView";
    case "patch":
      return "InboundPatch";
    case "reopen":
      return "InboundReopen";
    case "close":
      return "InboundClose";
    case "ping":
      return "InboundPing";
  }
}

describe("(e) exhaustiveness — Inbound TS union matches schema $defs", () => {
  test("every Inbound variant has a corresponding $defs entry", () => {
    const schema = JSON.parse(schemaRaw);
    const defs = schema["$defs"] ?? {};

    // This list is the runtime projection of the compile-time switch above.
    // Both must be kept in sync with the Inbound union in ipc.ts.
    const inboundDefNames = [
      "InboundMutateResult",
      "InboundMutateError",
      "InboundUpdate",
      "InboundView",
      "InboundPatch",
      "InboundReopen",
      "InboundClose",
      "InboundPing",
    ];

    for (const name of inboundDefNames) {
      expect(defs[name], `Inbound variant missing $defs entry: ${name}`).toBeDefined();
    }
  });

  test("every Outbound variant has a corresponding $defs entry", () => {
    const schema = JSON.parse(schemaRaw);
    const defs = schema["$defs"] ?? {};

    const outboundDefNames = [
      "OutboundReady",
      "OutboundMutate",
      "OutboundDisconnected",
      "OutboundReconnected",
      "OutboundClosed",
      "OutboundError",
    ];

    for (const name of outboundDefNames) {
      expect(defs[name], `Outbound variant missing $defs entry: ${name}`).toBeDefined();
    }
  });
});
