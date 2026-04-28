#!/usr/bin/env node
// ui-leaf CLI — language-neutral entry point for non-Node consumers.
//
// Protocol (stdio, line-delimited JSON):
//
//   STDIN
//     Line 1: config object (view, viewsRoot, data, mutations: [names], …)
//     Line 2+: mutation responses, one per line:
//       {"type":"result","id":<n>,"value":<any>}
//       {"type":"error","id":<n>,"message":"<text>"}
//
//   STDOUT
//     {"type":"ready","url":"<url>","port":<n>}        emitted once when the dev server is up
//     {"type":"mutate","id":<n>,"name":"<s>","args":<any>}  emitted when a view triggers a mutation
//     {"type":"closed"}                                 emitted on natural close
//     {"type":"error","message":"<text>"}              emitted on internal error
//
//   Lifecycle
//     Exits 0 on natural close (view closed).
//     Exits 1 on internal error.
//     Closing stdin from the parent triggers shutdown (any pending
//     mutations are rejected).

import { createInterface } from "node:readline";
import { mount, type MountOptions } from "./index.js";

// Capture the real stdout write BEFORE anything (especially mount() with
// silent: true) gets a chance to redirect process.stdout. The binary's
// protocol output uses this directly; rsbuild's noise (which goes
// through process.stdout.write) gets redirected to stderr by silent mode
// without affecting our protocol channel.
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

interface ConfigRequest {
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
}

interface MutateResult {
  type: "result";
  id: number;
  value?: unknown;
}

interface MutateError {
  type: "error";
  id: number;
  message: string;
}

type MutateResponse = MutateResult | MutateError;

function emit(event: unknown): void {
  realStdoutWrite(`${JSON.stringify(event)}\n`);
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
      try {
        const config = JSON.parse(trimmed) as ConfigRequest;
        configResolve(config);
      } catch (err) {
        emit({
          type: "error",
          message: `failed to parse config JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exit(1);
      }
      return;
    }

    // Mutation response.
    let msg: MutateResponse;
    try {
      msg = JSON.parse(trimmed) as MutateResponse;
    } catch {
      // Malformed line; ignore (consumer should be using the protocol).
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "result") p.resolve(msg.value);
    else if (msg.type === "error") p.reject(new Error(msg.message));
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
    silent: true, // bridge owns stdout; rsbuild output must stay silent
  };

  try {
    const view = await mount(mountOpts);
    mountedView = view;
    // If stdin closed while we were waiting on mount(), tear down right
    // away rather than hold the dev server open.
    if (stdinClosed) {
      void view.close();
    }
    emit({ type: "ready", url: view.url, port: view.port });
    await view.closed;
    emit({ type: "closed" });
    process.exit(0);
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
