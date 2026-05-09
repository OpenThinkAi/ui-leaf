// ui-leaf wrapper-js — public mount() facade.
//
// Wraps spawnUiLeaf() (AGT-134) with the full View handle API: mutation
// dispatch, event subscriptions, setView/patch serialisation, signal-abort,
// and the closed promise. AC refs per the AGT-135 ticket.

import { PROTOCOL_VERSION } from "./protocol.js";
import type { OutboundMessage, SpawnConfig } from "./protocol.js";
import { spawnUiLeaf } from "./spawn.js";

// ---------------------------------------------------------------------------
// Public types (AC #7)
// ---------------------------------------------------------------------------

export type MutationHandler = (args: unknown) => Promise<unknown>;

/** Options accepted by mount(). Protocol fields mirror InboundConfig. */
export type MountOptions = {
  // Required protocol fields
  view: string;
  viewsRoot: string;
  // Optional protocol fields
  data?: unknown;
  /** Mutation handlers keyed by name. Keys become the declared mutations list. */
  mutations?: Record<string, MutationHandler>;
  title?: string;
  port?: number;
  openBrowser?: boolean;
  shell?: "tab" | "app";
  csp?: string;
  heartbeatTimeoutMs?: number;
  startupGraceMs?: number;
  allowedHosts?: string[];
  // Wrapper-only fields
  /** AbortSignal: pre-ready abort kills the child; post-ready sends close then SIGKILL after 5s. */
  signal?: AbortSignal;
  /** Suppress binary stderr forwarding to the parent process. */
  silent?: boolean;
  /** Override the postinstall-resolved binary path. Valid as a power-user escape
   *  hatch (e.g. a local build); the mock binary used by tests is injected here. */
  binaryPath?: string;
};

/** Live handle returned by mount() once the binary is ready. */
export interface View {
  /** Full URL including the #token=… fragment (AC #4). */
  readonly url: string;
  /** Wrapper-synthetic per-spawn UUID (AC #4). */
  readonly id: string;
  /** TCP port the server bound to (AC #4). */
  readonly port: number;

  /**
   * Replace the view's data props and push a data-updated SSE event to
   * connected browsers. Fire-and-forget (resolves immediately, AC #4).
   */
  update(opts: { data: unknown }): Promise<void>;

  /**
   * Swap the view source. Sends {type:"view"}, resolves on the next
   * view-swapped event, rejects if the compile fails. Takes raw TSX —
   * NOT the `view` name from MountOptions (which is a viewsRoot-relative
   * path/name).
   */
  setSource(source: string): Promise<void>;

  /**
   * Alias for `setSource(source)` — identical behaviour. Retained as a
   * non-breaking alias because `setView` was the original v1.0.x name;
   * `setSource` is the canonical name going forward (the `view`
   * vocabulary is overloaded — `MountOptions.view` is a viewsRoot
   * name/path, but the argument here is raw TSX).
   */
  setView(source: string): Promise<void>;

  /**
   * Atomic data + view swap. `source` is raw TSX (same as setView's arg, not
   * the `view` name from MountOptions). Translates to the narrowest wire message:
   *   both fields   → patch   (awaits view-swapped / build error)
   *   source only   → view    (awaits view-swapped / build error)
   *   data only     → update  (fire-and-forget)
   *   neither       → no-op   (resolves immediately)
   * (AC #4)
   */
  patch(opts: { data?: unknown; source?: string }): Promise<void>;

  /** Re-invoke open(url) to launch a fresh browser tab (AC #4). */
  reopen(): void;

  /** Register a handler that fires when the browser tab closes (AC #4). */
  onDisconnect(handler: () => void): void;

  /** Register a handler that fires when the browser tab reconnects (AC #4). */
  onReconnect(handler: () => void): void;

  /** Register a handler for structured error events (AC #4). */
  onError(handler: (err: { phase?: string; message: string }) => void): void;

  /** Resolves when the binary closes (any reason). Never rejects (AC #4). */
  readonly closed: Promise<{ reason: string }>;

  /** Send {type:"close"} and await the closed event (AC #4). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// mount()
// ---------------------------------------------------------------------------

/** Spawn a ui-leaf mount and return a live View handle. */
export async function mount(options: MountOptions): Promise<View> {
  const {
    mutations: mutationMap = {},
    signal,
    silent,
    binaryPath,
    ...protocolOptions
  } = options;

  const mutationNames = Object.keys(mutationMap);

  const spawnConfig: SpawnConfig = {
    ...protocolOptions,
    mutations: mutationNames.length > 0 ? mutationNames : undefined,
    silent,
    binaryPath,
  };

  const handle = spawnUiLeaf(spawnConfig);

  // Dispatch inbound mutate events into the mutations map.
  handle.onMutate(async (_id, name, args) => {
    const handler = Object.hasOwn(mutationMap, name) ? mutationMap[name] : undefined;
    if (!handler)
      throw new Error(
        `ui-leaf: no mutation handler registered for "${name}". Add it to the mutations map passed to mount().`,
      );
    return handler(args);
  });

  // ---- Closed promise -------------------------------------------------------

  let closedSettled = false;
  let resolveClosedPromise!: (info: { reason: string }) => void;
  const closedPromise = new Promise<{ reason: string }>((res) => {
    resolveClosedPromise = (info) => {
      if (closedSettled) return;
      closedSettled = true;
      res(info);
    };
  });

  // ---- Event handler arrays -------------------------------------------------

  const disconnectHandlers: Array<() => void> = [];
  const reconnectHandlers: Array<() => void> = [];
  const errorHandlers: Array<(err: { phase?: string; message: string }) => void> = [];

  // ---- View-op queue --------------------------------------------------------
  // setView / patch (when it involves a view change) are serialised through a
  // FIFO queue so the "next view-swapped event wins" rule is deterministic
  // under concurrent calls. Each enqueued op awaits its predecessor, then
  // sends its wire message and awaits the resulting view-swapped or build error.

  const viewOpWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  let viewOpChain: Promise<void> = Promise.resolve();

  function enqueueViewOp(send: () => void): Promise<void> {
    const step = viewOpChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          viewOpWaiters.push({ resolve, reject });
          send();
        }),
    );
    // Keep the chain alive even when an op rejects (build errors are non-fatal).
    viewOpChain = step.then(
      () => {},
      () => {},
    );
    return step;
  }

  // ---- Signal tracking ------------------------------------------------------

  let abortedBySignal = false;

  // ---- Wire up the single SpawnedHandle event slot --------------------------

  handle.onEvent((event: OutboundMessage) => {
    if (event.type === "view-swapped") {
      viewOpWaiters.shift()?.resolve();
      return;
    }
    if (event.type === "disconnected") {
      for (const h of disconnectHandlers) h();
      return;
    }
    if (event.type === "reconnected") {
      for (const h of reconnectHandlers) h();
      return;
    }
    if (event.type === "closed") {
      const reason = abortedBySignal ? "signal" : event.reason;
      resolveClosedPromise({ reason });
      return;
    }
    if (event.type === "error") {
      // Non-fatal build errors resolve (i.e., reject) the pending view op.
      if (event.phase === "build" && viewOpWaiters.length > 0) {
        viewOpWaiters.shift()!.reject(new Error(event.message));
        return;
      }
      for (const h of errorHandlers) h({ phase: event.phase, message: event.message });
      return;
    }
    // ready / unknown types are forwarded from spawn.ts to onEvent; no action
    // needed here beyond what the spawn layer already does.
  });

  // Settle closed and drain the view-op queue if the process exits without
  // emitting a closed event (crash, SIGKILL, etc.).
  handle.exited.then((exitInfo) => {
    resolveClosedPromise({
      reason: abortedBySignal ? "signal" : exitInfo.reason,
    });
    const unexpectedExit = new Error("ui-leaf: process exited unexpectedly");
    let waiter: (typeof viewOpWaiters)[0] | undefined;
    while ((waiter = viewOpWaiters.shift())) waiter.reject(unexpectedExit);
  });

  // ---- Pre-ready abort check ------------------------------------------------

  if (signal?.aborted) {
    handle.kill();
    throw new DOMException("mount() aborted by signal", "AbortError");
  }

  // ---- Await ready (racing signal abort if provided) ------------------------

  let readyInfo: Awaited<typeof handle.ready>;

  if (signal) {
    const abortError = new DOMException(
      "mount() aborted by signal",
      "AbortError",
    );
    const abortRace = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(abortError), {
        once: true,
      });
    });
    try {
      readyInfo = await Promise.race([handle.ready, abortRace]);
    } catch (err) {
      // Could be either the abort error or a binary startup failure.
      if (signal.aborted) {
        abortedBySignal = true;
        handle.kill();
      }
      throw err;
    }
  } else {
    readyInfo = await handle.ready;
  }

  // ---- Post-ready signal abort wiring --------------------------------------

  if (signal && !signal.aborted) {
    signal.addEventListener(
      "abort",
      () => {
        abortedBySignal = true;
        handle.send({ version: PROTOCOL_VERSION, type: "close" });
        const graceTimer = setTimeout(() => handle.kill(), 5_000);
        handle.exited.then(() => clearTimeout(graceTimer));
      },
      { once: true },
    );
  }

  // ---- Build and return the View handle ------------------------------------

  const setSourceImpl = (source: string): Promise<void> =>
    enqueueViewOp(() => {
      handle.send({ version: PROTOCOL_VERSION, type: "view", source });
    });

  const view: View = {
    url: readyInfo.url,
    id: readyInfo.id,
    port: readyInfo.port,

    async update(opts: { data: unknown }): Promise<void> {
      handle.send({ version: PROTOCOL_VERSION, type: "update", data: opts.data });
    },

    setSource: setSourceImpl,
    // setView is a non-breaking alias of setSource. Defined as the same
    // function reference (not `this.setSource(...)`) so destructured
    // usage like `const { setView } = view` keeps working.
    setView: setSourceImpl,

    patch(opts: { data?: unknown; source?: string }): Promise<void> {
      const hasData = opts.data !== undefined;
      const hasSource = opts.source !== undefined;

      if (hasData && hasSource) {
        return enqueueViewOp(() => {
          handle.send({
            version: PROTOCOL_VERSION,
            type: "patch",
            data: opts.data,
            view: { source: opts.source as string },
          });
        });
      }
      if (hasSource) {
        return enqueueViewOp(() => {
          handle.send({
            version: PROTOCOL_VERSION,
            type: "view",
            source: opts.source as string,
          });
        });
      }
      if (hasData) {
        handle.send({
          version: PROTOCOL_VERSION,
          type: "update",
          data: opts.data,
        });
      }
      return Promise.resolve();
    },

    reopen(): void {
      handle.send({ version: PROTOCOL_VERSION, type: "reopen" });
    },

    onDisconnect(handler: () => void): void {
      disconnectHandlers.push(handler);
    },

    onReconnect(handler: () => void): void {
      reconnectHandlers.push(handler);
    },

    onError(handler: (err: { phase?: string; message: string }) => void): void {
      errorHandlers.push(handler);
    },

    closed: closedPromise,

    async close(): Promise<void> {
      handle.send({ version: PROTOCOL_VERSION, type: "close" });
      await closedPromise;
    },
  };

  return view;
}
