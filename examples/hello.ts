// Spike test: start the dev server with a hardcoded view + data.
// Run with: bun run examples/hello.ts

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDevServer } from "../src/dev-server.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const viewsRoot = resolve(here, "../views");

const server = await startDevServer({
  view: "demo",
  viewsRoot,
  data: {
    message: "Hello from ui-leaf",
    timestamp: new Date().toISOString(),
    items: ["foo", "bar", "baz"],
    nested: { a: 1, b: 2, c: { deep: true } },
  },
});

console.log(`ui-leaf dev server: ${server.url}`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
