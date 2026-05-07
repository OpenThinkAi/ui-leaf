#!/usr/bin/env bun
/**
 * Generates docs/ipc-protocol.md from packages/cli/schema/ipc.json.
 *
 * Run:   bun run generate:protocol-doc
 * Check: bun run check:protocol-doc   (exits 1 if committed file differs)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const schemaPath = resolve(root, "packages/cli/schema/ipc.json");
const outPath = resolve(root, "docs/ipc-protocol.md");

// ---------------------------------------------------------------------------
// Types (subset of JSON Schema we care about)
// ---------------------------------------------------------------------------

interface SchemaDef {
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  required?: string[];
  properties?: Record<string, SchemaDef>;
  additionalProperties?: boolean | SchemaDef;
  oneOf?: Array<{ $ref: string }>;
  $ref?: string;
}

interface IpcSchema {
  description: string;
  $defs: Record<string, SchemaDef>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refName(ref: string): string {
  return ref.replace(/^#\/\$defs\//, "");
}

/** Render a short type string for the field table. */
function renderType(prop: SchemaDef): string {
  if (prop.const !== undefined) return `\`${JSON.stringify(prop.const)}\` (const)`;
  if (prop.enum) return prop.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (!prop.type) return "any";
  const t = Array.isArray(prop.type) ? prop.type.join(" \\| ") : prop.type;
  return t;
}

/** Render constraints column: enum/const/min/max/pattern summary. */
function renderConstraints(prop: SchemaDef): string {
  const parts: string[] = [];
  if (prop.minimum !== undefined) parts.push(`min: ${prop.minimum}`);
  if (prop.maximum !== undefined) parts.push(`max: ${prop.maximum}`);
  if (prop.pattern) parts.push(`pattern: \`${prop.pattern}\``);
  return parts.join(", ") || "—";
}

/** Build a one-line JSON example for a def. Discriminants resolve to their
 *  const; typed scalars get a sensible placeholder; free-form any-JSON fields
 *  show `<any JSON value>`. */
function buildExample(
  def: SchemaDef,
  defs: Record<string, SchemaDef>,
  isSse = false,
): Record<string, unknown> {
  const props = def.properties ?? {};
  const required = new Set(def.required ?? []);
  const ex: Record<string, unknown> = {};

  if (!isSse) {
    ex["version"] = "1";
  }

  for (const [key, prop] of Object.entries(props)) {
    if (key === "version" && !isSse) continue; // already added first

    let resolved = prop;
    if (prop.$ref) {
      const name = refName(prop.$ref);
      resolved = defs[name] ?? prop;
    }

    if (!required.has(key) && key !== "type") {
      // Skip optional fields in example unless it's important
      if (!["id", "name", "args", "value", "url", "port", "reason", "message", "data", "source", "view"].includes(key)) continue;
    }

    if (resolved.const !== undefined) {
      ex[key] = resolved.const;
      continue;
    }

    // enum: use first enum value as example
    if (resolved.enum && resolved.enum.length > 0) {
      ex[key] = resolved.enum[0];
      continue;
    }

    switch (resolved.type) {
      case "string":
        if (key === "url") { ex[key] = "http://127.0.0.1:5810"; break; }
        if (key === "name") { ex[key] = "saveFile"; break; }
        if (key === "message") { ex[key] = "handler threw: file not found"; break; }
        if (key === "source") { ex[key] = "export default function View({name}){return <h1>{name}</h1>}"; break; }
        ex[key] = `<string>`; break;
      case "integer":
        if (key === "port") { ex[key] = 5810; break; }
        if (key === "id") { ex[key] = 1; break; }
        ex[key] = 0; break;
      case "boolean":
        ex[key] = true; break;
      case "array":
        ex[key] = ["<string>"]; break;
      case "object":
        // Recurse into nested objects using their own properties
        if (resolved.properties) {
          ex[key] = buildExample(resolved, defs, isSse);
          // Remove spurious "version" key injected by recursive call for nested objects
          if (typeof ex[key] === "object" && ex[key] !== null) {
            delete (ex[key] as Record<string, unknown>)["version"];
          }
        } else {
          ex[key] = {};
        }
        break;
      default:
        // any JSON
        if (key === "data") { ex[key] = { count: 42 }; break; }
        if (key === "args") { ex[key] = ["./report.csv"]; break; }
        if (key === "value") { ex[key] = { ok: true }; break; }
        ex[key] = "<any JSON value>";
    }
  }
  return ex;
}

/** Build a markdown field table for a def. */
function buildFieldTable(
  def: SchemaDef,
  defs: Record<string, SchemaDef>,
  isSse = false,
): string {
  const props = def.properties ?? {};
  const required = new Set(def.required ?? []);

  if (Object.keys(props).length === 0) return "_No properties._\n";

  const rows: string[] = [];
  rows.push("| Field | Type | Req | Description | Constraints |");
  rows.push("|---|---|:---:|---|---|");

  for (const [key, prop] of Object.entries(props)) {
    let resolved = prop;
    if (prop.$ref) {
      const name = refName(prop.$ref);
      resolved = defs[name] ?? prop;
    }

    // Merge description: prefer the property-level desc, fall back to resolved
    const desc = prop.description ?? resolved.description ?? "—";
    const isReq = required.has(key) ? "✓" : "";
    const typeStr = renderType(resolved);
    const constraints = renderConstraints(resolved);

    rows.push(`| \`${key}\` | ${typeStr} | ${isReq} | ${desc} | ${constraints} |`);
  }

  return rows.join("\n") + "\n";
}

/** Render a full section for one message def. */
function renderSection(
  name: string,
  def: SchemaDef,
  defs: Record<string, SchemaDef>,
  level: number,
  isSse = false,
): string {
  const heading = "#".repeat(level);
  const lines: string[] = [];

  lines.push(`${heading} \`${def.properties?.type?.const ?? name}\``);
  lines.push("");

  if (def.description) {
    lines.push(def.description);
    lines.push("");
  }

  // Example
  lines.push("**Example**");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(buildExample(def, defs, isSse), null, 2));
  lines.push("```");
  lines.push("");

  // Field table
  lines.push("**Fields**");
  lines.push("");
  lines.push(buildFieldTable(def, defs, isSse));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

function generate(schema: IpcSchema): string {
  const defs = schema.$defs;

  // Resolve which defs belong to which group
  const inboundRefs = (defs["InboundMessage"]?.oneOf ?? []).map((r) => refName(r.$ref));
  const outboundRefs = (defs["OutboundMessage"]?.oneOf ?? []).map((r) => refName(r.$ref));
  const sseRefs = (defs["SseMessage"]?.oneOf ?? []).map((r) => refName(r.$ref));

  const lines: string[] = [];

  // Banner
  lines.push("<!-- DO NOT EDIT — generated by scripts/generate-protocol-doc.ts -->");
  lines.push("<!-- Run `bun run generate:protocol-doc` to regenerate. -->");
  lines.push("");

  // Title + top-level overview
  lines.push("# ui-leaf IPC Protocol Reference");
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(
    "ui-leaf communicates with its caller over **line-delimited JSON** on stdin/stdout. " +
    "Each message is a single JSON object followed by `\\n`. " +
    "Every message (both directions) carries `\"version\":\"1\"` as a top-level field. " +
    "The binary rejects any message without a valid `version` field and emits an `error` outbound message."
  );
  lines.push("");
  lines.push("**Stream shape:**");
  lines.push("");
  lines.push("```");
  lines.push("stdin  → line 1: InboundConfig (spawn config)");
  lines.push("       → lines 2+: InboundMessage (runtime commands)");
  lines.push("stdout ← OutboundMessage (events and responses)");
  lines.push("GET /events ← SseMessage (server-sent events to the browser)");
  lines.push("```");
  lines.push("");

  // Error semantics
  lines.push("**Error semantics:**");
  lines.push("");
  lines.push(
    "- `OutboundError` without a `phase` tag is **fatal**: the binary exits 1 after emitting it."
  );
  lines.push(
    '- `OutboundError` with `phase:"build"` is **non-fatal**: the previous view is preserved and the mount stays alive.'
  );
  lines.push(
    '- `OutboundError` with `phase:"runtime"` is **fatal**: the binary exits 1.'
  );
  lines.push("");

  // Versioning policy
  lines.push("## Versioning Policy");
  lines.push("");
  lines.push(
    "The current protocol version is **`\"1\"`**. Version is a string const, not a number, " +
    "to allow future alphanumeric identifiers."
  );
  lines.push("");
  lines.push("**Additive changes (minor / non-breaking):** New optional fields on existing message types, " +
    "new message types added to a `oneOf`, new SSE event types. " +
    "Callers that ignore unknown fields continue to work without modification.");
  lines.push("");
  lines.push("**Breaking changes (new major version):** Removing or renaming required fields, " +
    "changing the meaning of an existing `type` discriminant, changing the version literal itself. " +
    "A breaking change increments `version` (e.g. `\"2\"`) and is hosted at a new `$id` URI in the schema.");
  lines.push("");
  lines.push("**SSE channel versioning:** SSE event payloads (`GET /events`) are unversioned — " +
    "no `version` field appears on the SSE frame. This is a known asymmetry: the SSE channel is " +
    "a server-push side channel for the browser, not part of the stdin/stdout IPC contract. " +
    "Breaking SSE changes follow the same semver rules as the rest of the protocol.");
  lines.push("");

  // Config
  lines.push("---");
  lines.push("");
  lines.push("## Inbound: Config (spawn config, stdin line 1)");
  lines.push("");
  lines.push(
    "The **first** line of stdin is always an `InboundConfig` object. " +
    "It has no `type` discriminant — it is identified purely by position in the stream."
  );
  lines.push("");

  const configDef = defs["InboundConfig"];
  if (configDef) {
    lines.push("### InboundConfig");
    lines.push("");
    if (configDef.description) { lines.push(configDef.description); lines.push(""); }

    lines.push("**Example**");
    lines.push("");
    lines.push("```json");
    const configEx = {
      version: "1",
      view: "Dashboard",
      viewsRoot: "/home/user/myapp/views",
      data: { count: 0, label: "start" },
      mutations: ["increment", "reset"],
      title: "My App Dashboard",
      port: 0,
      openBrowser: true,
    };
    lines.push(JSON.stringify(configEx, null, 2));
    lines.push("```");
    lines.push("");

    lines.push("**Fields**");
    lines.push("");
    lines.push(buildFieldTable(configDef, defs));
  }

  // Inbound messages
  lines.push("---");
  lines.push("");
  lines.push("## Inbound Messages (stdin lines 2+)");
  lines.push("");
  lines.push(
    "All subsequent stdin lines after the config are `InboundMessage` objects. " +
    "Each carries `\"version\":\"1\"` and a `type` discriminant."
  );
  lines.push("");

  for (const ref of inboundRefs) {
    const def = defs[ref];
    if (!def) continue;
    lines.push(renderSection(ref, def, defs, 3));
    lines.push("");
  }

  // Outbound messages
  lines.push("---");
  lines.push("");
  lines.push("## Outbound Messages (stdout)");
  lines.push("");
  lines.push(
    "The binary writes `OutboundMessage` objects to stdout, one per line. " +
    "Each carries `\"version\":\"1\"` and a `type` discriminant."
  );
  lines.push("");

  for (const ref of outboundRefs) {
    const def = defs[ref];
    if (!def) continue;
    lines.push(renderSection(ref, def, defs, 3));
    lines.push("");
  }

  // SSE events
  lines.push("---");
  lines.push("");
  lines.push("## SSE Events (`GET /events`)");
  lines.push("");
  lines.push(
    "The browser subscribes to `GET /events` (requires `X-UI-Leaf-Token` header). " +
    "Each event is a standard SSE frame: `data: <JSON>\\n\\n`. " +
    "SSE events are **not** versioned — no `version` field appears in the payload. " +
    "See the versioning policy section for details."
  );
  lines.push("");

  for (const ref of sseRefs) {
    const def = defs[ref];
    if (!def) continue;
    lines.push(renderSection(ref, def, defs, 3, true));
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? "generate";

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as IpcSchema;
const output = generate(schema);

if (mode === "check") {
  const tmp = outPath + ".tmp";
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, output, "utf8");
  try {
    execSync(`diff -u "${outPath}" "${tmp}"`, { stdio: "inherit" });
    console.log("docs/ipc-protocol.md is up to date.");
  } catch {
    console.error(
      "\n[31mdocs/ipc-protocol.md is out of date.[0m\n" +
      "Run `bun run generate:protocol-doc` to regenerate it, then commit the result.\n"
    );
    process.exit(1);
  } finally {
    try { require("node:fs").unlinkSync(tmp); } catch { /* ignore */ }
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output, "utf8");
  console.log("Generated docs/ipc-protocol.md");
}
