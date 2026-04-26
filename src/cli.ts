#!/usr/bin/env node
// ui-leaf CLI — language-neutral entry point for non-Node consumers.

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(
    [
      "ui-leaf — Customizable browser views, on demand, for any CLI.",
      "",
      "Usage:",
      "  ui-leaf mount --view <name> [options]",
      "",
      "Status: pre-v0.1.0, not yet functional.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write("0.0.0\n");
  process.exit(0);
}

process.stderr.write(`ui-leaf: command "${args[0]}" not yet implemented\n`);
process.exit(1);
