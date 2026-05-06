// ui-leaf wrapper-js — IPC protocol types.
//
// Hand-written for v1.0.0 to mirror packages/cli/src/ipc.ts exactly. AGT-127
// generates this file from packages/cli/schema/ipc.json in a follow-up; until
// then, any change to the cli's ipc.ts must be mirrored here.

export const PROTOCOL_VERSION = "1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Outbound: messages the binary writes on stdout.
// ---------------------------------------------------------------------------

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
  phase?: string;
  message: string;
};

export type OutboundMessage =
  | OutboundReady
  | OutboundMutate
  | OutboundDisconnected
  | OutboundReconnected
  | OutboundClosed
  | OutboundError;

// ---------------------------------------------------------------------------
// Inbound: messages the binary reads on stdin.
// ---------------------------------------------------------------------------

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
  // Forward-compatible: schema accepts additional fields. Listed in AC #2 but
  // not yet enumerated in ipc.json; passed through verbatim.
  allowedHosts?: string[];
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

export type InboundUpdate = {
  version: ProtocolVersion;
  type: "update";
  data: unknown;
};

export type InboundView = {
  version: ProtocolVersion;
  type: "view";
  source: string;
};

export type InboundPatch = {
  version: ProtocolVersion;
  type: "patch";
  data: unknown;
  view: { source: string };
};

export type InboundReopen = {
  version: ProtocolVersion;
  type: "reopen";
};

export type InboundClose = {
  version: ProtocolVersion;
  type: "close";
};

export type InboundPing = {
  version: ProtocolVersion;
  type: "ping";
};

export type InboundMessage =
  | InboundMutateResult
  | InboundMutateError
  | InboundUpdate
  | InboundView
  | InboundPatch
  | InboundReopen
  | InboundClose
  | InboundPing;

// ---------------------------------------------------------------------------
// Wrapper-side spawn API
// ---------------------------------------------------------------------------

/**
 * Inputs to spawnUiLeaf(). Protocol fields mirror InboundConfig (sans version,
 * which the wrapper stamps). `silent` and `binaryPath` are wrapper-only.
 */
export type SpawnConfig = {
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
  allowedHosts?: string[];

  /** Suppress forwarding of the binary's stderr to the parent process. */
  silent?: boolean;
  /** Override the resolved binary path. Tests use this for the mock binary. */
  binaryPath?: string;
};

/** Resolved by `.ready` once the binary emits its `ready` event. */
export type ReadyInfo = {
  url: string;
  port: number;
  /** Wrapper-synthetic per-spawn id; stable across the mount's lifetime. */
  id: string;
};

/** Resolved by `.exited` once the child process exits. */
export type ExitInfo = {
  /** Process exit code; null if the child was killed by a signal. */
  code: number | null;
  /**
   * `caller` / `signal` / `error` come from the binary's `closed` event when
   * one was observed. `killed` means the wrapper sent SIGTERM/SIGKILL via
   * `.kill()`. `unknown` covers exits without a `closed` event (crash, etc).
   */
  reason: CloseReason | "killed" | "unknown";
};

export type MutateHandler = (
  id: number,
  name: string,
  args: unknown,
) => Promise<unknown>;

export type EventHandler = (event: OutboundMessage) => void;

export interface SpawnedHandle {
  readonly ready: Promise<ReadyInfo>;
  readonly exited: Promise<ExitInfo>;
  /** Write a JSON line to the binary's stdin. Caller stamps `version:"1"`. */
  send(message: InboundMessage): void;
  /**
   * Register the handler that dispatches incoming `mutate` events. The
   * wrapper writes the paired `result` (on resolve) or `error` (on reject)
   * back to the binary automatically. Replaces any prior handler.
   */
  onMutate(handler: MutateHandler): void;
  /**
   * Register a handler that fires for every non-mutate outbound event
   * (ready, disconnected, reconnected, closed, error, plus unknown types).
   * Replaces any prior handler.
   */
  onEvent(handler: EventHandler): void;
  /** SIGTERM, escalating to SIGKILL after 5s if the child has not exited. */
  kill(): void;
}
