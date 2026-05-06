import { describe, test, expect } from "bun:test";
import {
  emit,
  parseInbound,
  PROTOCOL_VERSION,
  type InboundMutateResponse,
} from "../src/ipc.ts";

describe("emit", () => {
  test("stamps version:'1' as the first key of the serialised object", () => {
    const line = emit({ type: "ready", url: "http://127.0.0.1:5810", port: 5810 });
    expect(line.startsWith(`{"version":"${PROTOCOL_VERSION}",`)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.version).toBe(PROTOCOL_VERSION);
    expect(parsed.type).toBe("ready");
  });

  test("preserves event payload alongside version", () => {
    const line = emit({ type: "mutate", id: 7, name: "save", args: { ok: true } });
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed).toEqual({
      version: "1",
      type: "mutate",
      id: 7,
      name: "save",
      args: { ok: true },
    });
  });

  test("error events round-trip with version stamped first", () => {
    const line = emit({ type: "error", message: "boom" });
    expect(line.startsWith(`{"version":"1",`)).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed).toEqual({ version: "1", type: "error", message: "boom" });
  });
});

describe("parseInbound", () => {
  test("missing version field → missing-version outcome", () => {
    const outcome = parseInbound<InboundMutateResponse>(
      JSON.stringify({ type: "result", id: 1, value: 42 }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("missing-version");
  });

  test("version:'1' → ok, message returned verbatim", () => {
    const outcome = parseInbound<InboundMutateResponse>(
      JSON.stringify({ version: "1", type: "result", id: 1, value: 42 }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.msg.type).toBe("result");
      expect(outcome.msg.id).toBe(1);
    }
  });

  test("future version:'2' → unsupported-version outcome with the rejected value", () => {
    const outcome = parseInbound<InboundMutateResponse>(
      JSON.stringify({ version: "2", type: "result", id: 1, value: 42 }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unsupported-version");
      if (outcome.kind === "unsupported-version") {
        expect(outcome.got).toBe("2");
      }
    }
  });

  test("malformed JSON → json outcome (not a version error)", () => {
    const outcome = parseInbound<InboundMutateResponse>("{not json");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("json");
  });

  test("non-object payload (number) → missing-version outcome", () => {
    const outcome = parseInbound<InboundMutateResponse>("42");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("missing-version");
  });

  test("null payload → missing-version outcome", () => {
    const outcome = parseInbound<InboundMutateResponse>("null");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("missing-version");
  });

  test("non-string version (numeric 1) → unsupported-version outcome", () => {
    const outcome = parseInbound<InboundMutateResponse>(
      JSON.stringify({ version: 1, type: "result", id: 1, value: 42 }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unsupported-version");
      if (outcome.kind === "unsupported-version") expect(outcome.got).toBe(1);
    }
  });
});
