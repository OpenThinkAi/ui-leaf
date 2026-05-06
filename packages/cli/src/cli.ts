#!/usr/bin/env node
// ui-leaf CLI — language-neutral entry point for non-Node consumers.
//
// Protocol (stdio, line-delimited JSON; every message carries
// `"version":"1"` as the first key):
//
//   STDIN
//     Line 1: config object {"version":"1","view":…,"viewsRoot":…,…}
//     Line 2+: one of:
//       Mutation responses (identified by the `id` field):
//         {"version":"1","type":"result","id":<n>,"value":<any>}
//         {"version":"1","type":"error","id":<n>,"message":"<text>"}
//       Live-update messages (no `id`):
//         {"version":"1","type":"update","data":<any>}
//         {"version":"1","type":"view","source":"<tsx string>"}
//         {"version":"1","type":"patch","data":<any>,"view":{"source":"<tsx>"}}
//         {"version":"1","type":"reopen"}
//         {"version":"1","type":"close"}
//
//   STDOUT
//     {"version":"1","type":"ready","url":"<url>","port":<n>}
//     {"version":"1","type":"mutate","id":<n>,"name":"<s>","args":<any>}
//     {"version":"1","type":"disconnected"}
//     {"version":"1","type":"reconnected"}
//     {"version":"1","type":"closed","reason":"caller"|"signal"|"error"}
//     {"version":"1","type":"error","message":"<text>"}
//     {"version":"1","type":"error","phase":"build","message":"<text>"}
//
//   Version handling
//     A missing version field on any inbound message produces
//       {"version":"1","type":"error","message":"missing version field"}
//     A non-"1" version produces
//       {"version":"1","type":"error","message":"unsupported protocol version: <x>"}
//     Both errors on the config message exit 1; on subsequent messages
//     the bad line is dropped and the mount keeps running.
//
//   Unknown post-config message types produce:
//     {"version":"1","type":"error","message":"unknown message type: <x>"}
//     The mount continues (non-fatal).
//
//   view / patch compile failures preserve the previous view and produce:
//     {"version":"1","type":"error","phase":"build","message":"<text>"}
//
//   Inline view.source constraint (v1.0.0): the TSX source string is
//   treated as self-contained. Relative imports are not supported —
//   the string has no filesystem context to resolve them against. Bare-
//   package imports (react, react-dom) work via the internal alias plugin.
//
//   Lifecycle
//     disconnected: browser tab heartbeat stopped; mount stays alive.
//     reconnected:  browser reconnected after a disconnect.
//     closed:       mount terminated; reason is caller|signal|error.
//     Exits 0 on closed with reason caller|signal; exits 1 on error.
//     Closing stdin from the parent triggers a caller close (exit 0).

import { createInterface } from "node:readline";
import { mount, type MountOptions } from "./index.js";
import {
  emit as serializeEvent,
  parseInbound,
  validateInboundShape,
  type Inbound,
  type InboundConfig,
  type OutboundEvent,
} from "./ipc.js";

// Capture the real stdout write BEFORE anything (especially mount() with
// silent: true) gets a chance to redirect process.stdout. The binary's
// protocol output uses this directly; bundler / dev-server noise (which
// goes through process.stdout.write) gets redirected to stderr by silent
// mode without affecting our protocol channel.
const realStdoutWrite = process.stdout.write.bind(process.stdout);

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(
    [
      "ui-leaf — Customizable browser views, on demand, for any CLI.",
      "",
      "Usage:",
      "  ui-leaf mount         Read a JSON config from stdin and mount a view.",
      "                        See https://github.com/OpenThinkAi/ui-leaf for",
      "                        the full stdio protocol spec.",
      "",
      "  ui-leaf --version     Print version.",
      "  ui-leaf --help        Print this message.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
  // Read version from package.json shipped alongside this binary.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (args[0] !== "mount") {
  process.stderr.write(`ui-leaf: unknown command "${args[0]}"\n`);
  process.exit(1);
}

// `ui-leaf mount --help` (or being run on a TTY without piped input)
// would otherwise sit silently on stdin. Print the protocol pointer and
// exit 0 so users discovering the binary land on docs, not a "broken"
// exit code.
if (args[1] === "--help" || args[1] === "-h" || process.stdin.isTTY) {
  process.stdout.write(
    [
      "ui-leaf mount — read a JSON config from stdin and mount a view.",
      "",
      "Protocol: line-delimited JSON over stdio.",
      "  stdin  line 1 = config object",
      "         lines 2+ = mutation responses {type:result|error,id,...}",
      "  stdout {type:ready,url,port}, {type:mutate,id,name,args},",
      "         {type:closed}, {type:error,message}",
      "",
      "Full spec: https://github.com/OpenThinkAi/ui-leaf#driving-ui-leaf-from-a-non-node-cli",
      "",
      "Example:",
      `  echo '{"view":"spec","viewsRoot":"/abs/path","data":{}}' | ui-leaf mount`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

try {
  await runMount();
} catch (err) {
  emit({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

type ConfigRequest = InboundConfig;

function emit(event: OutboundEvent): void {
  realStdoutWrite(serializeEvent(event));
}

function stringifyVersion(got: unknown): string {
  if (typeof got === "string") return got;
  return JSON.stringify(got);
}

async function runMount(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  let configReceived = false;
  let configResolve!: (cfg: ConfigRequest) => void;
  let configReject!: (err: Error) => void;
  const configPromise = new Promise<ConfigRequest>((res, rej) => {
    configResolve = res;
    configReject = rej;
  });

  // Track the mounted view so the stdin-close handler can shut it down.
  // Set after `mount()` resolves; null until then.
  // biome-ignore lint/suspicious/noExplicitAny: MountedView shape inferred
  let mountedView: any = null;
  let stdinClosed = false;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (!configReceived) {
      configReceived = true;
      const outcome = parseInbound<ConfigRequest>(trimmed);
      if (!outcome.ok) {
        // Config is the load-bearing first message. A bad version on the
        // config can't be recovered from, so per AC #5's optional clause
        // we emit the spec'd error and exit. Subsequent (post-config)
        // version violations are non-fatal — see below.
        if (outcome.kind === "json") {
          emit({
            type: "error",
            message: `failed to parse config JSON: ${outcome.reason}`,
          });
        } else if (outcome.kind === "missing-version") {
          emit({ type: "error", message: "missing version field" });
        } else {
          emit({
            type: "error",
            message: `unsupported protocol version: ${stringifyVersion(outcome.got)}`,
          });
        }
        process.exit(1);
      }
      const configValidation = validateInboundShape(outcome.msg, "config");
      if (!configValidation.ok) {
        emit({ type: "error", message: configValidation.reason });
        process.exit(1);
      }
      configResolve(outcome.msg);
      return;
    }

    // Post-config message: mutation response or live-update command.
    const outcome = parseInbound<Inbound>(trimmed);
    if (!outcome.ok) {
      if (outcome.kind === "missing-version") {
        emit({ type: "error", message: "missing version field" });
      } else if (outcome.kind === "unsupported-version") {
        emit({
          type: "error",
          message: `unsupported protocol version: ${stringifyVersion(outcome.got)}`,
        });
      }
      // Malformed JSON falls through silently.
      return;
    }
    const msg = outcome.msg;

    const msgValidation = validateInboundShape(msg, "post-config");
    if (!msgValidation.ok) {
      emit({ type: "error", message: msgValidation.reason });
      return;
    }

    // Mutation responses carry an `id` field — discriminate before checking `type`.
    if ("id" in msg && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === "result") p.resolve(msg.value);
      else if (msg.type === "error") p.reject(new Error(msg.message));
      return;
    }

    // Live-update commands — only dispatch if mountedView is ready.
    if (!mountedView) return;

    if (msg.type === "update") {
      mountedView.update(msg.data);
      return;
    }

    if (msg.type === "view") {
      void (async () => {
        const errors = await mountedView.swapView(msg.source);
        if (errors.length > 0) {
          emit({
            type: "error",
            phase: "build",
            message: errors.map((e: { message: string }) => e.message).join("; "),
          });
        }
      })();
      return;
    }

    if (msg.type === "patch") {
      void (async () => {
        const errors = await mountedView.patch(msg.data, msg.view.source);
        if (errors.length > 0) {
          emit({
            type: "error",
            phase: "build",
            message: errors.map((e: { message: string }) => e.message).join("; "),
          });
        }
      })();
      return;
    }

    if (msg.type === "reopen") {
      void mountedView.reopen().catch((err: unknown) => {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    if (msg.type === "close") {
      void mountedView.close();
      return;
    }

    if (msg.type === "ping") {
      // Heartbeat from caller — silently acknowledged; no reply emitted.
      return;
    }
  });

  rl.on("close", () => {
    stdinClosed = true;
    // Reject any pending mutations — the parent isn't going to respond.
    for (const { reject } of pending.values()) {
      reject(new Error("ui-leaf: stdin closed by parent before mutation responded"));
    }
    pending.clear();
    // If we never received config, the parent dropped before doing
    // anything useful. Bail out with a non-zero exit so that's visible.
    if (!configReceived) {
      configReject(new Error("ui-leaf: stdin closed before config received"));
      return;
    }
    // Otherwise, tear down the mounted view (if it exists yet) so the
    // process exits without waiting on the heartbeat timeout. The
    // view.closed promise resolves and runMount's normal exit path runs.
    if (mountedView) {
      void mountedView.close();
    }
  });

  const config = await configPromise;

  // Build mutations map: each declared name becomes a handler that emits
  // a mutate event on stdout and awaits a paired response on stdin.
  // biome-ignore lint/suspicious/noExplicitAny: handler signatures vary
  const mutations: Record<string, (args: any) => Promise<unknown>> = {};
  for (const name of config.mutations ?? []) {
    mutations[name] = (mutationArgs: unknown) => {
      const id = ++nextId;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        emit({ type: "mutate", id, name, args: mutationArgs });
      });
    };
  }

  const mountOpts: MountOptions = {
    view: config.view,
    viewsRoot: config.viewsRoot,
    data: config.data,
    mutations,
    title: config.title,
    port: config.port,
    openBrowser: config.openBrowser,
    shell: config.shell,
    csp: config.csp,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    startupGraceMs: config.startupGraceMs,
    silent: true, // bridge owns stdout; bundler / dev-server output must stay silent
  };

  try {
    const view = await mount(mountOpts);
    mountedView = view;
    // If stdin closed while we were waiting on mount(), tear down right
    // away rather than hold the dev server open.
    if (stdinClosed) {
      void view.close();
    }
    view.on("disconnected", () => emit({ type: "disconnected" }));
    view.on("reconnected", () => emit({ type: "reconnected" }));
    emit({ type: "ready", url: view.url, port: view.port });
    const closeReason = await view.closed;
    emit({ type: "closed", reason: closeReason });
    process.exit(closeReason === "error" ? 1 : 0);
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
