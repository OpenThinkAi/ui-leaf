#!/usr/bin/env node
// Counter example — ui-leaf via @openthink/ui-leaf JS wrapper.
//
// Run (from the repo root, after bun install):
//   bun run examples/node/counter.js
//   node examples/node/counter.js
//
// Smoke mode (no browser, exits after one round-trip):
//   UI_LEAF_SMOKE=1 bun run examples/node/counter.js
//
// Environment variables:
//   UI_LEAF_SMOKE=1        Headless mode — no browser, exits cleanly after one update.
//   UI_LEAF_BIN=<path>     Override the resolved binary path (e.g. a local dist build).
//   UI_LEAF_VIEWS_ROOT=<p> Override the views directory.

import { mount } from "@openthink/ui-leaf";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const viewsRoot = process.env.UI_LEAF_VIEWS_ROOT ?? resolve(here, "..", "views");
const smoke = process.env.UI_LEAF_SMOKE === "1";
const binaryPath = process.env.UI_LEAF_BIN; // undefined → postinstall-resolved path

let count = 0;

// mount() spawns the ui-leaf binary, sends the config, and resolves once the
// HTTP server is ready. The mutations map wires CLI-side handlers for every
// mutation name the view is allowed to call.
const view = await mount({
  view: "counter",
  viewsRoot,
  data: { initialCount: count },
  openBrowser: !smoke,
  silent: smoke,
  ...(binaryPath ? { binaryPath } : {}),
  mutations: {
    // The view calls mutate("increment", { by: 1 }) on each button click.
    // The return value becomes the result the view's `mutate()` call resolves with.
    increment: async ({ by = 1 } = {}) => {
      count += by;
      console.error(`[node] mutation 'increment' by=${by} → count=${count}`);
      return { count };
    },
  },
});

console.error(`[node] view ready at ${view.url}`);

if (smoke) {
  // Headless round-trip: push a data update to demonstrate view.update(),
  // then close the mount cleanly and exit 0.
  await view.update({ data: { initialCount: 42 } });
  await view.close();
  console.error("[node] done.");
  process.exit(0);
}

// Normal interactive mode — keep running until the browser tab closes or
// the process receives SIGTERM/SIGINT.

view.onDisconnect(() => console.error("[node] browser tab disconnected"));
view.onReconnect(() => console.error("[node] browser tab reconnected"));

// view.reopen() re-launches the browser tab after a disconnect. Call it from
// an onDisconnect handler if you want automatic re-open:
//   view.onDisconnect(() => view.reopen());

// view.setView(source) hot-swaps the view source at runtime. Supply a TSX
// string to try it:
//   await view.setView(`
//     export default function Updated() {
//       return <div style={{padding:"2rem"}}>View swapped!</div>;
//     }
//   `);

process.once("SIGTERM", () => void view.close());
process.once("SIGINT", () => void view.close());

const { reason } = await view.closed;
console.error(`[node] view closed (${reason})`);
