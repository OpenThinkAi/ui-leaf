// Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`
// (ui-leaf#101).
//
// With `--remote-debugging-pipe`, Chrome reads CDP requests from fd 3 and
// writes responses/events to fd 4, each message a JSON object terminated by a
// NUL byte. Unlike `--remote-debugging-port`, nothing is exposed on the
// network: only the process holding the other end of the pipe (us) can drive
// the browser. Chrome also shuts itself down when the pipe disconnects, so a
// ui-leaf process that dies — even by SIGKILL — takes its app-mode Chrome with
// it instead of leaving an orphan window.
//
// Scope is deliberately tiny: request/response correlation by id, a per-call
// timeout, and close detection. Events are ignored.

import type { Readable, Writable } from "node:stream";

export interface CdpPipeClient {
  /**
   * Send a CDP command and resolve with its `result`. Rejects on a CDP error
   * response, on timeout, or when the pipe is (or becomes) closed.
   */
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** True once either end of the pipe has closed or errored. */
  readonly closed: boolean;
  /** Release the pipe from our side. Chrome treats this as a disconnect. */
  close(): void;
}

const DEFAULT_CALL_TIMEOUT_MS = 2000;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createCdpPipeClient(writable: Writable, readable: Readable): CdpPipeClient {
  let nextId = 0;
  let closed = false;
  let buffer = "";
  const pending = new Map<number, Pending>();

  const failAll = (err: Error): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    failAll(new Error("ui-leaf: CDP pipe closed"));
  };

  readable.setEncoding?.("utf8");
  readable.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nul: number;
    while ((nul = buffer.indexOf("\0")) !== -1) {
      const frame = buffer.slice(0, nul);
      buffer = buffer.slice(nul + 1);
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        msg = JSON.parse(frame);
      } catch {
        continue; // Malformed frame: skip it, keep the stream usable.
      }
      if (typeof msg.id !== "number") continue; // CDP event, not a reply.
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`ui-leaf: CDP error: ${String(msg.error.message ?? "unknown")}`));
      } else {
        p.resolve(msg.result);
      }
    }
  });
  // 'error' (EPIPE once Chrome is gone) must be handled or the runtime
  // promotes it to an uncaught exception and takes the host down.
  readable.on("error", markClosed);
  readable.on("end", markClosed);
  readable.on("close", markClosed);
  writable.on("error", markClosed);
  writable.on("close", markClosed);

  return {
    get closed() {
      return closed;
    },
    call(method, params = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error("ui-leaf: CDP pipe closed"));
      const id = ++nextId;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ui-leaf: CDP ${method} timed out`));
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          writable.write(`${JSON.stringify({ id, method, params })}\0`);
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          markClosed();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    close() {
      markClosed();
      try {
        writable.destroy();
      } catch {
        /* already gone */
      }
      try {
        readable.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Count `page` targets (app windows / tabs) via `Target.getTargets`.
 * Resolves `null` when the probe fails — callers treat that as "unknown",
 * never as "zero windows", so a slow or wedged browser is not torn down.
 */
export async function countPageTargets(client: CdpPipeClient): Promise<number | null> {
  try {
    const result = (await client.call("Target.getTargets")) as {
      targetInfos?: Array<{ type?: unknown }>;
    };
    if (!result || !Array.isArray(result.targetInfos)) return null;
    return result.targetInfos.filter((t) => t.type === "page").length;
  } catch {
    return null;
  }
}
