#!/usr/bin/env bun
// Mock ui-leaf binary used by spawn.test.ts.
//
// Reads its first stdin line as the spawn config, looks for an injected
// `__mockScript` field listing the canned protocol shape it should perform,
// and executes that script. Subsequent stdin lines are echoed to stdout as
// `mock-recv` events so the test can assert on what the wrapper sent.
//
// Why a separate file? The wrapper spawns by path; we want a real
// child-process round-trip exercised in tests.

import { createInterface } from "node:readline";

type EmitStep = {
  kind: "emit";
  /** Raw object to JSON.stringify and write on stdout (newline-terminated). */
  msg: Record<string, unknown>;
  /** Optional split: write the line in pieces with N ms delay between each. */
  splitAfter?: number;
  /** Optional delay (ms) before this emit. */
  delayMs?: number;
};

type ExitStep = {
  kind: "exit";
  code: number;
  delayMs?: number;
};

type StderrStep = {
  kind: "stderr";
  text: string;
  delayMs?: number;
};

/** Wait for an inbound message of the given type, then continue. */
type WaitStep = {
  kind: "wait-for";
  type: string;
  timeoutMs?: number;
  delayMs?: number;
};

/** Write an arbitrary raw text line to stdout (useful for emitting malformed JSON in tests). */
type RawStep = {
  kind: "raw";
  text: string;
  delayMs?: number;
};

type Step = EmitStep | ExitStep | StderrStep | WaitStep | RawStep;

type MockScript = Step[];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emitLine(obj: Record<string, unknown>, splitAfter?: number): void {
  const json = JSON.stringify(obj);
  if (splitAfter !== undefined && splitAfter > 0 && splitAfter < json.length) {
    process.stdout.write(json.slice(0, splitAfter));
    setTimeout(() => {
      process.stdout.write(`${json.slice(splitAfter)}\n`);
    }, 5);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

const inboundLog: Array<{ type: string; line: unknown }> = [];
const inboundWaiters: Array<{
  type: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

const rl = createInterface({ input: process.stdin });

let configReceived = false;
let script: MockScript = [];

rl.on("line", (line) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!configReceived) {
    configReceived = true;
    const cfg = parsed as { __mockScript?: MockScript };
    script = cfg.__mockScript ?? [];
    runScript().catch((err) => {
      process.stderr.write(`mock-binary: ${(err as Error).message}\n`);
    });
    return;
  }
  // Post-config: log the inbound line so wait-for can match by type.
  const msgType =
    typeof parsed === "object" && parsed !== null
      ? String((parsed as { type?: unknown }).type ?? "")
      : "";
  inboundLog.push({ type: msgType, line: parsed });

  // Resolve any matching waiters.
  for (let i = inboundWaiters.length - 1; i >= 0; i--) {
    const w = inboundWaiters[i]!;
    if (w.type === msgType) {
      clearTimeout(w.timer);
      w.resolve();
      inboundWaiters.splice(i, 1);
    }
  }
});

rl.on("close", () => {
  // Parent closed stdin — exit cleanly so .exited resolves.
  process.exit(0);
});

async function flushStdout(): Promise<void> {
  // process.exit() doesn't drain pipes; wait for any buffered writes.
  await new Promise<void>((resolve) => {
    if (process.stdout.write("")) resolve();
    else process.stdout.once("drain", () => resolve());
  });
  // Plus a microtask so any setTimeout(write,5) from splitAfter has a chance.
  await sleep(10);
}

async function runScript(): Promise<void> {
  for (const step of script) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.kind === "emit") {
      emitLine(step.msg, step.splitAfter);
    } else if (step.kind === "stderr") {
      process.stderr.write(step.text);
    } else if (step.kind === "raw") {
      process.stdout.write(`${step.text}\n`);
    } else if (step.kind === "exit") {
      await flushStdout();
      process.exit(step.code);
    } else if (step.kind === "wait-for") {
      // Did we already receive it?
      if (inboundLog.some((m) => m.type === step.type)) continue;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`mock: timed out waiting for ${step.type}`));
        }, step.timeoutMs ?? 2000);
        inboundWaiters.push({ type: step.type, resolve, reject, timer });
      });
    }
  }
}

// Handle SIGTERM by emitting a closed event then exiting (so the wrapper's
// kill ladder can be observed). Some tests opt out by setting the env var.
process.on("SIGTERM", () => {
  if (process.env["MOCK_IGNORE_SIGTERM"] === "1") return;
  emitLine({ version: "1", type: "closed", reason: "signal" });
  process.exit(0);
});
