// Spike test: full mount() flow with mutation handlers.
// Run with: bun run examples/hello.ts

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const viewsRoot = resolve(here, "../views");

let counter = 0;

console.log("Starting ui-leaf — close the browser tab to exit.");

const view = await mount({
  view: "demo",
  viewsRoot,
  data: {
    message: "Hello from ui-leaf",
    timestamp: new Date().toISOString(),
    items: ["foo", "bar", "baz"],
    initialCount: counter,
  },
  mutations: {
    increment: (args) => {
      const { by = 1 } = (args as { by?: number } | undefined) ?? {};
      counter += by;
      console.log(`[CLI] increment by ${by} → count=${counter}`);
      return { count: counter };
    },
  },
});

console.log(`ui-leaf running at ${view.url} — close the tab to exit.`);
await view.closed;
console.log("Browser tab closed; ui-leaf shut down.");
