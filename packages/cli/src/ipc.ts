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

export type CloseReason = "caller" | "signal" | "error";

export type OutboundDisconnected = {
  version: ProtocolVersion;
  type: "disconnected";
};

export type OutboundReconnected = {
  version: ProtocolVersion;
  type: "reconnected";
};

export type OutboundClosed = {
  version: ProtocolVersion;
  type: "closed";
  reason: CloseReason;
};

export type OutboundError = {
  version: ProtocolVersion;
  type: "error";
  /** Optional phase tag, e.g. "build" for view/patch compile failures. */
  phase?: string;
  message: string;
};

export type OutboundViewSwapped = {
  version: ProtocolVersion;
  type: "view-swapped";
};

export type Outbound =
  | OutboundReady
  | OutboundMutate
  | OutboundClosed
  | OutboundDisconnected
  | OutboundReconnected
  | OutboundError
  | OutboundViewSwapped;

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
  /** Initial Chrome window size in CSS pixels for shell:"app". Ignored in tab mode. */
  windowSize?: { width: number; height: number };
  /** Initial Chrome window position in screen CSS pixels for shell:"app". Ignored in tab mode. */
  windowPosition?: { x: number; y: number };
  /** Unpacked Chrome extension dirs to load for shell:"app". Ignored in tab mode. */
  extensions?: string[];
  /** Opt-in remote-debugging port (CDP, 127.0.0.1) for shell:"app". Ignored in tab mode. */
  debugPort?: number;
  /** Opt-in persistent browser profile dir for shell:"app". Ignored in tab mode. */
  profile?: { dir: string };
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

// New inbound message types (v1.0.0): live-update handlers.

/**
 * Replace in-memory data. The served page HTML is re-assembled with the new
 * data and a data-updated SSE event is broadcast, so both a tab that is
 * already connected and one that loads (or reloads / reopens) later render
 * the latest data. If sent before `ready`, the message is buffered — last
 * write wins, since update is whole-data replacement — and applied to the
 * mount just before `ready` is emitted (issue #72).
 */
export type InboundUpdate = {
  version: ProtocolVersion;
  type: "update";
  data: unknown;
};

/**
 * Swap the view source on-the-fly; triggers a recompile and view-swapped SSE
 * event. Not deferrable: sent before `ready` it is dropped with a non-fatal
 * error line (see classifyPreReadyMessage).
 */
export type InboundView = {
  version: ProtocolVersion;
  type: "view";
  source: string;
};

/**
 * Atomically replace both data and view source. If the compile fails, neither
 * takes effect and the previous state is preserved. Not deferrable: sent
 * before `ready` it is dropped with a non-fatal error line.
 */
export type InboundPatch = {
  version: ProtocolVersion;
  type: "patch";
  data: unknown;
  view: { source: string };
};

/**
 * Re-invoke open(url) to launch a fresh browser tab at the same URL. Not
 * deferrable: sent before `ready` it is dropped with a non-fatal error line
 * (the initial open is already in flight).
 */
export type InboundReopen = {
  version: ProtocolVersion;
  type: "reopen";
};

/**
 * Terminate the mount cleanly (caller-initiated close). Honored even before
 * `ready`: the mount is torn down as soon as it comes up.
 */
export type InboundClose = {
  version: ProtocolVersion;
  type: "close";
};

/** Caller heartbeat. The binary silently acknowledges; no reply is emitted. */
export type InboundPing = {
  version: ProtocolVersion;
  type: "ping";
};

/**
 * Discriminated union of all valid post-config inbound messages. Discriminate
 * on `type`; mutation responses are identified by the presence of an `id` field.
 */
export type Inbound =
  | InboundMutateResponse
  | InboundUpdate
  | InboundView
  | InboundPatch
  | InboundReopen
  | InboundClose
  | InboundPing;

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

export type ValidateOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Structural validator for inbound messages. Called after parseInbound() confirms
 * version and JSON shape; this function checks per-type required fields.
 *
 * kind="config"      → validates InboundConfig required fields (view, viewsRoot).
 * kind="post-config" → validates InboundMessage variants by type discriminant.
 *
 * On failure the caller should emit {type:"error",message:reason} and continue
 * (or exit 1 for config failures, per the protocol spec).
 */
export function validateInboundShape(
  msg: unknown,
  kind: "config" | "post-config",
): ValidateOutcome {
  if (typeof msg !== "object" || msg === null) {
    return { ok: false, reason: "message is not an object" };
  }
  const m = msg as Record<string, unknown>;

  if (kind === "config") {
    if (typeof m.view !== "string" || m.view === "") {
      return { ok: false, reason: 'config requires a non-empty string "view"' };
    }
    if (typeof m.viewsRoot !== "string" || m.viewsRoot === "") {
      return { ok: false, reason: 'config requires a non-empty string "viewsRoot"' };
    }
    if ("mutations" in m && m.mutations !== undefined) {
      if (
        !Array.isArray(m.mutations) ||
        !(m.mutations as unknown[]).every((x) => typeof x === "string")
      ) {
        return { ok: false, reason: "config.mutations must be an array of strings" };
      }
    }
    if ("port" in m && m.port !== undefined && typeof m.port !== "number") {
      return { ok: false, reason: "config.port must be a number" };
    }
    if (
      "openBrowser" in m &&
      m.openBrowser !== undefined &&
      typeof m.openBrowser !== "boolean"
    ) {
      return { ok: false, reason: "config.openBrowser must be a boolean" };
    }
    if (
      "shell" in m &&
      m.shell !== undefined &&
      m.shell !== "tab" &&
      m.shell !== "app"
    ) {
      return { ok: false, reason: 'config.shell must be "tab" or "app"' };
    }
    if (
      "heartbeatTimeoutMs" in m &&
      m.heartbeatTimeoutMs !== undefined &&
      typeof m.heartbeatTimeoutMs !== "number"
    ) {
      return { ok: false, reason: "config.heartbeatTimeoutMs must be a number" };
    }
    if (
      "startupGraceMs" in m &&
      m.startupGraceMs !== undefined &&
      typeof m.startupGraceMs !== "number"
    ) {
      return { ok: false, reason: "config.startupGraceMs must be a number" };
    }
    if ("profile" in m && m.profile !== undefined) {
      const p = m.profile;
      if (
        typeof p !== "object" ||
        p === null ||
        typeof (p as Record<string, unknown>).dir !== "string" ||
        (p as Record<string, unknown>).dir === ""
      ) {
        return {
          ok: false,
          reason: 'config.profile must be an object with a non-empty string "dir"',
        };
      }
    }
    if ("windowPosition" in m && m.windowPosition !== undefined) {
      const wp = m.windowPosition;
      if (
        typeof wp !== "object" ||
        wp === null ||
        typeof (wp as Record<string, unknown>).x !== "number" ||
        typeof (wp as Record<string, unknown>).y !== "number"
      ) {
        return {
          ok: false,
          reason: 'config.windowPosition must be an object with numeric "x" and "y"',
        };
      }
    }
    if ("extensions" in m && m.extensions !== undefined) {
      if (
        !Array.isArray(m.extensions) ||
        // Reject commas inside a path: Chrome parses --load-extension as a
        // comma-separated dir list, so a comma would inject extra extension
        // dirs (and bypass --disable-extensions-except). Each array element
        // must be exactly one dir.
        !(m.extensions as unknown[]).every(
          (x) => typeof x === "string" && x !== "" && !x.includes(","),
        )
      ) {
        return {
          ok: false,
          reason:
            "config.extensions must be an array of non-empty path strings, none containing a comma",
        };
      }
    }
    if (
      "debugPort" in m &&
      m.debugPort !== undefined &&
      (typeof m.debugPort !== "number" ||
        !Number.isInteger(m.debugPort) ||
        m.debugPort < 1 ||
        m.debugPort > 65535)
    ) {
      return { ok: false, reason: "config.debugPort must be an integer in 1–65535" };
    }
    return { ok: true };
  }

  // post-config: discriminate on type first for result/error (which also carry id),
  // then on type alone for live-update commands.
  const type = m.type;
  if (typeof type !== "string") {
    return { ok: false, reason: '"type" field must be a string' };
  }

  // Mutation responses: type is "result" or "error", always carry a numeric id.
  if (type === "result" || type === "error") {
    if (typeof m.id !== "number") {
      return { ok: false, reason: `"${type}" requires a numeric "id" field` };
    }
    if (type === "error" && typeof m.message !== "string") {
      return { ok: false, reason: '"error" requires a string "message" field' };
    }
    return { ok: true };
  }

  // Live-update commands.
  switch (type) {
    case "update":
      if (!Object.hasOwn(m, "data")) {
        return { ok: false, reason: '"update" requires a "data" field' };
      }
      return { ok: true };
    case "view":
      if (typeof m.source !== "string") {
        return { ok: false, reason: '"view" requires a string "source" field' };
      }
      return { ok: true };
    case "patch":
      if (!Object.hasOwn(m, "data")) {
        return { ok: false, reason: '"patch" requires a "data" field' };
      }
      if (
        typeof m.view !== "object" ||
        m.view === null ||
        typeof (m.view as Record<string, unknown>).source !== "string"
      ) {
        return { ok: false, reason: '"patch" requires a string "view.source" field' };
      }
      return { ok: true };
    case "reopen":
    case "close":
    case "ping":
      return { ok: true };
    default:
      return { ok: false, reason: `unknown message type: "${type}"` };
  }
}

/**
 * Policy for live-update messages that arrive before the mount is ready
 * (issue #72). Between the config line and the `ready` event the mount is
 * compiling, starting its server, and spawning the browser — a multi-second
 * window in which raw-stdio callers may already be streaming commands.
 * Nothing in that window may be dropped silently.
 *
 *   buffer-update — `update` is whole-data replacement, so the latest
 *                   pre-ready payload is buffered (last write wins) and
 *                   applied just before `ready` is emitted.
 *   close         — the caller wants the mount gone; honored as soon as
 *                   the mount comes up (same path as stdin close).
 *   ignore        — `ping` is contractually a silent acknowledgement.
 *   reject        — everything else (`view`, `patch`, `reopen`) cannot be
 *                   safely deferred; the caller gets a non-fatal error line
 *                   and should re-send after `ready`.
 *
 * Mutation responses (`result`/`error`, identified by `id`) never reach this
 * classification — they are correlated to pending mutations upstream (and no
 * mutation can be outstanding before the mount exists).
 */
export type PreReadyAction =
  | { action: "buffer-update"; data: unknown }
  | { action: "close" }
  | { action: "ignore" }
  | { action: "reject"; reason: string };

export function classifyPreReadyMessage(msg: Inbound): PreReadyAction {
  switch (msg.type) {
    case "update":
      return { action: "buffer-update", data: msg.data };
    case "close":
      return { action: "close" };
    case "ping":
      return { action: "ignore" };
    // Mutation responses are handled before this point; treat defensively
    // as ignorable rather than erroring on a message we asked for.
    case "result":
    case "error":
      return { action: "ignore" };
    case "view":
    case "patch":
    case "reopen":
      return {
        action: "reject",
        reason: `cannot handle "${msg.type}" before ready; re-send after the ready event`,
      };
  }
}

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
