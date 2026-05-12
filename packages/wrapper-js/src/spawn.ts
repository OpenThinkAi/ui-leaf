// ui-leaf wrapper-js — spawn glue.
//
// Spawns the bundled `ui-leaf` binary, writes the config as the first stdin
// line, parses line-delimited JSON events from stdout, and dispatches mutate
// requests to a caller-registered handler. AGT-135's `mount()` facade wraps a
// public API around this; `spawnUiLeaf()` is the protocol-level primitive.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LineBuffer } from "./line-buffer.js";
import {
  PROTOCOL_VERSION,
  type CloseReason,
  type EventHandler,
  type ExitInfo,
  type InboundConfig,
  type InboundMessage,
  type MutateHandler,
  type OutboundMessage,
  type OutboundMutate,
  type ReadyInfo,
  type SpawnConfig,
  type SpawnedHandle,
} from "./protocol.js";

// 5 seconds: SIGTERM → SIGKILL escalation window. Long enough for a healthy
// binary to flush its `closed` event; short enough that a stuck child doesn't
// hang the parent.
const KILL_GRACE_MS = 5_000;

/**
 * Resolve the bundled binary path. tsup outputs `dist/spawn.js`; the native
 * binary lives at `bin/ui-leaf-bin` (or `bin/ui-leaf-bin.exe` on Windows)
 * one level up. postinstall downloads and writes that file; `bin/ui-leaf` is
 * the permanent CJS shim for CLI use and is never overwritten.
 */
function defaultBinaryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filename = process.platform === "win32" ? "ui-leaf-bin.exe" : "ui-leaf-bin";
  return path.resolve(here, "..", "bin", filename);
}

/**
 * Spawn the ui-leaf binary and return a handle for driving it. Synchronous —
 * the child is starting up in the background; await `.ready` for the URL.
 */
export function spawnUiLeaf(config: SpawnConfig): SpawnedHandle {
  const binaryPath = config.binaryPath ?? defaultBinaryPath();
  const silent = config.silent === true;

  const child = spawn(binaryPath, ["mount"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const mountId = randomUUID();
  const buffer = new LineBuffer();

  let mutateHandler: MutateHandler | null = null;
  let eventHandler: EventHandler | null = null;
  let observedCloseReason: CloseReason | null = null;
  let killRequested = false;
  let terminated = false;
  let killTimer: NodeJS.Timeout | null = null;

  // ---- Promises ----------------------------------------------------------

  let readySettled = false;
  let resolveReady!: (info: ReadyInfo) => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<ReadyInfo>((res, rej) => {
    resolveReady = (info) => {
      if (readySettled) return;
      readySettled = true;
      res(info);
    };
    rejectReady = (err) => {
      if (readySettled) return;
      readySettled = true;
      rej(err);
    };
  });
  // Suppress unhandled-rejection if no one awaits .ready before .exited fires.
  readyPromise.catch(() => {});

  let resolveExited!: (info: ExitInfo) => void;
  const exitedPromise = new Promise<ExitInfo>((res) => {
    resolveExited = res;
  });

  // ---- Helpers -----------------------------------------------------------

  function writeLine(obj: unknown): void {
    if (terminated) return;
    if (!child.stdin || child.stdin.destroyed) return;
    // We ignore the .write() return value; at expected message rates (tens
    // per second) the pipe never fills. If backpressure ever surfaces, add a
    // drain queue.
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function dispatchMutate(msg: OutboundMutate): void {
    if (!mutateHandler) {
      writeLine({
        version: PROTOCOL_VERSION,
        type: "error",
        id: msg.id,
        message: `no handler for ${msg.name}`,
      });
      return;
    }
    Promise.resolve()
      .then(() => mutateHandler!(msg.id, msg.name, msg.args))
      .then(
        (value) => {
          writeLine({
            version: PROTOCOL_VERSION,
            type: "result",
            id: msg.id,
            value,
          });
        },
        (err: unknown) => {
          writeLine({
            version: PROTOCOL_VERSION,
            type: "error",
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed line — surface as a synthetic error event so the caller
      // can log it. We don't crash the wrapper.
      eventHandler?.({
        version: PROTOCOL_VERSION,
        type: "error",
        message: `wrapper: malformed JSON line from binary: ${trimmed}`,
      });
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Partial<OutboundMessage> & { type?: unknown };

    if (msg.type === "ready") {
      const ready = msg as { url: string; port: number };
      resolveReady({ url: ready.url, port: ready.port, id: mountId });
      eventHandler?.(msg as OutboundMessage);
      return;
    }

    if (msg.type === "mutate") {
      dispatchMutate(msg as OutboundMutate);
      return;
    }

    if (msg.type === "closed") {
      observedCloseReason = (msg as { reason: CloseReason }).reason;
    }

    // disconnected / reconnected / closed / error / unknown — all flow to
    // onEvent. AC #7: unknown types do not throw.
    eventHandler?.(msg as OutboundMessage);
  }

  // ---- Wire stdio --------------------------------------------------------

  // Send config (line 1) immediately; the binary's readline loop blocks on it.
  // We pass through all config fields except the wrapper-only ones, so future
  // schema additions don't require a wrapper rev. Version is stamped here —
  // the only version-stamped write the wrapper makes (everything else is
  // caller-stamped per AC).
  const { silent: _s, binaryPath: _b, ...protocolFields } = config;
  const configLine: InboundConfig = {
    version: PROTOCOL_VERSION,
    ...protocolFields,
  } as InboundConfig;
  writeLine(configLine);

  // Two-phase exit finalization. The child's 'exit' event fires the
  // moment the process ends, but Node may still have buffered stdout
  // chunks queued for delivery to the 'data' listener. Settling .exited
  // immediately on 'exit' lets pending view-op waiters be drained with
  // "ui-leaf: process exited unexpectedly" before the binary's real
  // last-second message (e.g. error/phase:build) reaches onEvent.
  //
  // Instead, capture the exit code on 'exit' and only settle .exited
  // once stdout has also drained (its 'end' event fires). A short
  // fallback timer guarantees forward progress on platforms where the
  // pipe may never reach EOF after the process dies — Windows
  // TerminateProcess leaves the pipe in an indeterminate state, and a
  // cmd.exe shim wrapping the binary can hold the handle open too.
  //
  // See issue #57 for the Windows manifestation that motivated this.
  let stdoutEnded = false;
  let exitCaptured: { code: number | null } | null = null;
  let exitFinalized = false;
  const STDOUT_DRAIN_FALLBACK_MS = 200;

  function maybeFinalizeExit(): void {
    if (exitFinalized) return;
    if (exitCaptured === null) return;
    if (!stdoutEnded) return;
    exitFinalized = true;
    const { code } = exitCaptured;
    let reason: ExitInfo["reason"];
    if (observedCloseReason !== null) reason = observedCloseReason;
    else if (killRequested) reason = "killed";
    else reason = "unknown";

    if (!readySettled) {
      rejectReady(
        new Error(
          `ui-leaf: binary exited (code=${code}, reason=${reason}) before ready`,
        ),
      );
    }
    resolveExited({ code, reason });
  }

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of buffer.feed(chunk)) handleLine(line);
  });
  child.stdout?.on("end", () => {
    for (const line of buffer.flush()) handleLine(line);
    stdoutEnded = true;
    maybeFinalizeExit();
  });

  if (!silent) {
    child.stderr?.pipe(process.stderr, { end: false });
  } else {
    // Drain stderr so the pipe buffer never fills and stalls the child.
    child.stderr?.resume();
  }

  // Failed to spawn (binary missing, ENOENT, etc.) → reject .ready and
  // resolve .exited. The user sees this when they await either.
  child.on("error", (err) => {
    terminated = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    // Bypass the drain-coordination — a spawn-time error means stdio
    // may never have been opened in the first place.
    exitFinalized = true;
    rejectReady(err);
    resolveExited({ code: null, reason: "error" });
  });

  child.on("exit", (code) => {
    terminated = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    exitCaptured = { code };
    if (stdoutEnded) {
      maybeFinalizeExit();
      return;
    }
    // Force-finalize after the fallback window in case stdout never closes.
    const drainTimer = setTimeout(() => {
      stdoutEnded = true;
      maybeFinalizeExit();
    }, STDOUT_DRAIN_FALLBACK_MS);
    drainTimer.unref?.();
  });

  // ---- Handle ------------------------------------------------------------

  return {
    ready: readyPromise,
    exited: exitedPromise,
    send(message: InboundMessage): void {
      writeLine(message);
    },
    onMutate(handler: MutateHandler): void {
      mutateHandler = handler;
    },
    onEvent(handler: EventHandler): void {
      eventHandler = handler;
    },
    kill(): void {
      if (terminated || killRequested) return;
      killRequested = true;
      tryKill(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!terminated) tryKill(child, "SIGKILL");
      }, KILL_GRACE_MS);
      // Don't let the timer keep the event loop alive.
      killTimer.unref?.();
    },
  };
}

function tryKill(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    child.kill(signal);
  } catch {
    // Already dead; ignore.
  }
}
