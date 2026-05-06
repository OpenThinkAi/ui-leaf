// ui-leaf stdio IPC protocol — single source of truth for the line-delimited
// JSON shape exchanged between the binary and its caller.
//
// Versioning policy (design.md §8.2): every message carries a `version`
// literal. Additive changes (new optional fields, new message types) keep
// the same version; only contract breaks bump it. v1.0.0 ships "1".

export const PROTOCOL_VERSION = "1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// Outbound: messages the binary writes on stdout.
export type OutboundReady = {
  version: ProtocolVersion;
  type: "ready";
  url: string;
  port: number;
};

export type OutboundMutate = {
  version: ProtocolVersion;
  type: "mutate";
  id: number;
  name: string;
  args: unknown;
};

export type OutboundClosed = {
  version: ProtocolVersion;
  type: "closed";
};

export type OutboundError = {
  version: ProtocolVersion;
  type: "error";
  message: string;
};

export type Outbound =
  | OutboundReady
  | OutboundMutate
  | OutboundClosed
  | OutboundError;

// Inbound: messages the binary reads on stdin (line 1 = config, lines 2+ =
// mutation responses). Both shapes carry the version field.
export type InboundConfig = {
  version: ProtocolVersion;
  view: string;
  viewsRoot: string;
  data?: unknown;
  mutations?: string[];
  title?: string;
  port?: number;
  openBrowser?: boolean;
  shell?: "tab" | "app";
  csp?: string;
  heartbeatTimeoutMs?: number;
  startupGraceMs?: number;
};

export type InboundMutateResult = {
  version: ProtocolVersion;
  type: "result";
  id: number;
  value?: unknown;
};

export type InboundMutateError = {
  version: ProtocolVersion;
  type: "error";
  id: number;
  message: string;
};

export type InboundMutateResponse = InboundMutateResult | InboundMutateError;

// `Omit<U, K>` collapses a discriminated union by intersecting the
// remaining keys; the distributive form preserves the variants so the
// `emit()` argument can be {type:"ready",url,port} OR {type:"error",message}
// etc., not the (impossible) intersection.
export type OutboundEvent = Outbound extends infer T
  ? T extends Outbound
    ? Omit<T, "version">
    : never
  : never;

// Serialise an outbound event with `version` as the first key. The
// `version` field is added here so call sites can't forget — the helper's
// argument type strips it. JSON.stringify preserves insertion order for
// non-integer string keys (ES2015+), so the resulting line begins
// `{"version":"1",…`.
export function emit(event: OutboundEvent): string {
  const stamped = { version: PROTOCOL_VERSION, ...event };
  return `${JSON.stringify(stamped)}\n`;
}

// Parse a stdin line. Returns a discriminated outcome so the caller can
// route version violations to the spec'd error reply (AC #2) rather than
// silently dropping or crashing.
export type ParseOutcome<T> =
  | { ok: true; msg: T }
  | { ok: false; kind: "json"; reason: string }
  | { ok: false; kind: "missing-version" }
  | { ok: false; kind: "unsupported-version"; got: unknown };

export function parseInbound<T extends { version: ProtocolVersion }>(
  line: string,
): ParseOutcome<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return {
      ok: false,
      kind: "json",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, kind: "missing-version" };
  }
  if (!Object.hasOwn(parsed, "version")) {
    return { ok: false, kind: "missing-version" };
  }
  const version = (parsed as { version: unknown }).version;
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, kind: "unsupported-version", got: version };
  }
  return { ok: true, msg: parsed as T };
}
