// AGT-163 — drift guard between the hand-authored wrapper-js IPC types and the
// canonical schema.
//
// `packages/wrapper-js/src/protocol.ts` hand-mirrors the stdio message types
// defined in `packages/cli/schema/ipc.json` (authored by AGT-127). There is no
// codegen (Approach B, chosen at plan review): instead this test asserts the two
// stay in sync, so a schema change merged without a matching protocol.ts edit —
// or vice-versa — fails CI via the existing `bun test` run.
//
// Scope: the *stdio* message types only — the `Inbound*` / `Outbound*` $defs the
// binary reads on stdin / writes on stdout. Excluded by design:
//   - `Version1`              — a shared primitive, surfaced as ProtocolVersion.
//   - `*Message` unions       — checked separately (membership), not as objects.
//   - `Sse*`                  — browser-facing SSE channel, not the wrapper-js
//                               stdio protocol, so intentionally absent here.
//
// Field-level rule: every schema-`required` field must be present on the TS type
// (extra *optional* TS fields are allowed — `InboundConfig` is
// `additionalProperties: true` and carries forward-compat fields like
// `windowSize`/`allowedHosts` that postdate the schema). Discriminant `const`s
// must match exactly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const schemaPath = resolve(repoRoot, "packages/cli/schema/ipc.json");
const protocolPath = resolve(repoRoot, "packages/wrapper-js/src/protocol.ts");

// ── schema side ────────────────────────────────────────────────────────────

type SchemaDef = {
  required?: string[];
  properties?: Record<string, { const?: string }>;
  oneOf?: Array<{ $ref?: string }>;
};

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  $defs: Record<string, SchemaDef>;
};

const refName = (ref: string): string => ref.replace(/^#\/\$defs\//, "");

const isStdioMessageDef = (name: string): boolean =>
  (name.startsWith("Inbound") || name.startsWith("Outbound")) &&
  !name.endsWith("Message");

const schemaStdioDefs = Object.keys(schema.$defs).filter(isStdioMessageDef);

const schemaDiscriminant = (def: SchemaDef): string | null =>
  def.properties?.type?.const ?? null;

// ── protocol.ts side (dependency-free parse of the hand-authored source) ─────
//
// protocol.ts is a stable, consistently 2-space-indented file, so a small parser
// over its text is sufficient and keeps this test dep-free. Top-level fields are
// matched at exactly two leading spaces (`^  name:`), which excludes inline
// nested members (e.g. `windowSize?: { width: number }`) by construction. A
// reformat that breaks these patterns fails the test loudly rather than silently
// passing — acceptable for a drift guard.

type TsObjectType = { members: Set<string>; discriminant: string | null };

const sourceText = readFileSync(protocolPath, "utf8");

const tsObjectTypes = new Map<string, TsObjectType>();
const tsUnionMembers = new Map<string, Set<string>>();

// Object types: `export type Name = { ... };`
for (const m of sourceText.matchAll(/export type (\w+) = \{\n([\s\S]*?)\n\};/g)) {
  const [, name, body] = m;
  const members = new Set<string>();
  // top-level fields: exactly two leading spaces, then `name:` or `name?:`
  for (const f of body.matchAll(/^ {2}(\w+)\??:/gm)) members.add(f[1]!);
  // discriminant: the `type` field's string-literal value
  const disc = body.match(/^ {2}type\??:\s*"([^"]+)"/m);
  tsObjectTypes.set(name!, { members, discriminant: disc ? disc[1]! : null });
}

// Union types: `export type Name =\n  | A\n  | B;`
for (const m of sourceText.matchAll(/export type (\w+) =\s*\n((?:\s*\|\s*\w+\s*\n?)+);/g)) {
  const [, name, arms] = m;
  const refs = new Set<string>();
  for (const a of arms!.matchAll(/\|\s*(\w+)/g)) refs.add(a[1]!);
  tsUnionMembers.set(name!, refs);
}

// Sanity: parsing actually found types (guards against a silent regex/AST miss
// that would make every assertion below vacuously pass).
test("parsed protocol.ts and ipc.json are non-empty", () => {
  expect(schemaStdioDefs.length).toBeGreaterThan(0);
  expect(tsObjectTypes.size).toBeGreaterThan(0);
});

// ── 1. every schema stdio def is mirrored in protocol.ts ─────────────────────

describe("schema → protocol.ts: each stdio $def has a matching type", () => {
  for (const defName of schemaStdioDefs) {
    test(defName, () => {
      const tsType = tsObjectTypes.get(defName);
      expect(
        tsType,
        `ipc.json $defs.${defName} has no matching 'export type ${defName}' in protocol.ts`,
      ).toBeDefined();

      // every schema-required field is present on the TS type
      for (const field of schema.$defs[defName].required ?? []) {
        expect(
          tsType!.members.has(field),
          `protocol.ts type ${defName} is missing schema-required field '${field}'`,
        ).toBe(true);
      }

      // discriminant const matches (where the schema pins one)
      const disc = schemaDiscriminant(schema.$defs[defName]);
      if (disc !== null) {
        expect(
          tsType!.discriminant,
          `protocol.ts type ${defName} discriminant should be type: "${disc}"`,
        ).toBe(disc);
      }
    });
  }
});

// ── 2. reverse: no protocol.ts message type without a schema $def ─────────────

test("protocol.ts → schema: every Inbound*/Outbound* type has a $def", () => {
  const orphans = [...tsObjectTypes.keys()]
    .filter(isStdioMessageDef)
    .filter((name) => !(name in schema.$defs));
  expect(
    orphans,
    `protocol.ts declares message type(s) with no ipc.json $def: ${orphans.join(", ")}`,
  ).toEqual([]);
});

// ── 3. union membership matches the schema oneOf, both directions ────────────

describe("message-union membership matches schema oneOf", () => {
  for (const unionName of ["InboundMessage", "OutboundMessage"] as const) {
    test(unionName, () => {
      // Guard the $def access so a union missing from the schema fails with a
      // readable message instead of a cryptic "cannot read .oneOf of undefined"
      // — that absence is itself the drift this test exists to catch.
      expect(
        schema.$defs[unionName],
        `ipc.json has no $defs.${unionName}`,
      ).toBeDefined();
      const schemaMembers = new Set(
        (schema.$defs[unionName].oneOf ?? []).map((o) => refName(o.$ref!)),
      );
      const tsMembers = tsUnionMembers.get(unionName);
      expect(
        tsMembers,
        `protocol.ts has no '${unionName}' union`,
      ).toBeDefined();
      const onlySchema = [...schemaMembers].filter((m) => !tsMembers!.has(m));
      const onlyTs = [...tsMembers!].filter((m) => !schemaMembers.has(m));
      expect(
        [...tsMembers!].sort(),
        `${unionName} drift — in ipc.json only: [${onlySchema.join(", ")}]; in protocol.ts only: [${onlyTs.join(", ")}]`,
      ).toEqual([...schemaMembers].sort());
    });
  }
});
