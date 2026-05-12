#!/usr/bin/env bun
/**
 * Pre-bundles React packages into packages/cli/src/embedded/ as production ESM.
 *
 * Why: the bun-compiled binary has no node_modules/ on the user's machine.
 * compile.ts imports these outputs with { type: "text" } so Bun embeds the
 * source strings into the binary's data section at compile time. The onLoad
 * plugin in compile.ts then serves them for any bare react/react-dom import.
 *
 * Run order: this must complete before `bun build --compile` runs.
 * build-binaries.ts calls this explicitly; the root `prepare` lifecycle hook
 * covers `bun install` on fresh checkouts and CI.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "packages/cli/src/embedded");

interface Entry {
  /** Output filename (without .js). */
  readonly id: string;
  /** Bare module specifier to resolve and bundle. */
  readonly specifier: string;
  /** Packages to keep as bare ESM imports (not inlined) — single-React-instance invariant. */
  readonly external: readonly string[];
}

// react: self-contained — bundles only its own code, no deps.
// react/jsx-runtime: also self-contained in React 19 (no internal react import),
//   so no external flag needed either.
// react-dom: requires react internally, so external: ["react"] keeps it as a
//   bare ESM import that our onLoad chain re-routes to the embedded react bundle.
// react-dom/client: requires react + react-dom; scheduler is inlined because
//   it is not a separate embedded entry (it has no direct user imports).
const ENTRIES: readonly Entry[] = [
  { id: "react", specifier: "react", external: [] },
  { id: "react-jsx-runtime", specifier: "react/jsx-runtime", external: [] },
  { id: "react-dom", specifier: "react-dom", external: ["react"] },
  { id: "react-dom-client", specifier: "react-dom/client", external: ["react", "react-dom"] },
];

/**
 * Bun.build wraps CJS packages in a commonJS shim and emits only
 * `export default require_X()`. Named imports (`import { useState }`) fail
 * because there are no named exports. This post-processor finds the top-level
 * CJS exports object and appends an explicit named export for each key.
 *
 * The identifiers in Bun's generated shim are stable when `minify.identifiers`
 * is false: __commonJS, __export, exports_<pkg>_production, require_<entry>.
 *
 * Each regex assumption is load-bearing — a silent fallthrough produces a
 * bundle with only `export default require_X()` and no named exports, which
 * then breaks view compilation at runtime ("No matching export ... for
 * import 'createElement'"). To avoid that, every match-failure throws with
 * the entry id, the regex that failed, and a tail of the bundled source so
 * the divergence is visible in CI logs (see issue #49 for the Windows
 * occurrence that motivated this).
 */
function addNamedExports(bundledEsm: string, id: string): string {
  const failMsg = (which: string, extra = ""): string =>
    `addNamedExports[${id}]: ${which} regex did not match.${extra ? " " + extra : ""}\n--- bundle tail (last 500 bytes) ---\n${bundledEsm.slice(-500)}\n--- end tail ---`;

  // Find `export default require_X()` at the end of the bundle.
  const defaultMatch = bundledEsm.match(/export default (\w+)\(\);?\s*$/);
  if (!defaultMatch?.[1]) throw new Error(failMsg("default-export-tail"));
  const requireFnName = defaultMatch[1];

  // Find which exports_Y variable the wrapper assigns to module.exports.
  const requireFnPattern = new RegExp(
    `var ${requireFnName}=__commonJS[\\s\\S]*?module\\.exports=(\\w+)[\\s\\S]*?\\}\\);`,
  );
  const requireFnMatch = bundledEsm.match(requireFnPattern);
  if (!requireFnMatch?.[1]) {
    throw new Error(failMsg("commonjs-shim", `requireFnName=${requireFnName}`));
  }
  const exportsVarName = requireFnMatch[1];

  // Harvest the set of names exported by the CJS module. Bun emits two
  // distinct output shapes for the same React source:
  //
  //   "getter" shape (macOS/Linux):
  //     __export(exports_react_production, { useState: () => $useState, ... })
  //
  //   "assignment" shape (Windows, per issue #49):
  //     exports.useState = function (...) { ... };
  //     exports.version = "19.2.5";
  //
  // Try the getter shape first; if not present, fall back to scanning direct
  // `exports.NAME =` assignments. Both produce the same public name set —
  // they're just different lowerings of the same CJS module-record. The
  // downstream destructure+re-export below only cares about the names.
  const names: string[] = [];
  const exportCallPattern = new RegExp(
    `__export\\(${exportsVarName},\\{([^}]+)\\}`,
  );
  const exportCallMatch = bundledEsm.match(exportCallPattern);
  if (exportCallMatch?.[1]) {
    const exportGroup = exportCallMatch[1];
    const keyRe = /\b(\w+):/g;
    let k;
    while ((k = keyRe.exec(exportGroup)) !== null) {
      names.push(k[1]!);
    }
  } else {
    // Assignment shape. On Windows the `exportsVarName` captured above is
    // an inner `require_X_production` function name (because the outer
    // wrapper does `module.exports = require_X_production()` rather than
    // `module.exports = exports_X`). Scope the `exports.NAME =` scan to
    // *that* inner `__commonJS` callback body so a multi-module bundle
    // (e.g. react-dom + scheduler) doesn't bleed unrelated `exports.NAME`
    // assignments into the harvested list. If we can't find the inner
    // body for any reason, fall back to a whole-bundle scan — extra
    // harmless `undefined` re-exports beats throwing on the contained
    // failure mode.
    const innerBodyRe = new RegExp(
      `var ${exportsVarName}=__commonJS\\(\\([^)]*\\)=>\\{([\\s\\S]*?)\\}\\);`,
    );
    const innerBodyMatch = bundledEsm.match(innerBodyRe);
    const scanRegion = innerBodyMatch?.[1] ?? bundledEsm;
    const seen = new Set<string>();
    const assignRe = /\bexports\.([A-Za-z_$][\w$]*)\s*=/g;
    let m;
    while ((m = assignRe.exec(scanRegion)) !== null) {
      seen.add(m[1]!);
    }
    for (const n of seen) names.push(n);
  }
  if (names.length === 0) {
    throw new Error(
      failMsg(
        "no-export-names",
        `exportsVarName=${exportsVarName}; neither __export(...) nor exports.NAME= shape matched`,
      ),
    );
  }

  // Replace `export default require_X()` with:
  //   var __cjs_exports = require_X();       — call once, cache
  //   export { __cjs_exports as default };   — preserve default export
  //   var { a: _ne_a, ... } = __cjs_exports; — destructure into prefixed locals
  //   export { _ne_a as a, ... };            — re-export under original names
  //
  // The `_ne_` prefix avoids collision with top-level identifiers Bun's CJS
  // shim hoists out of the bundled module body. React's source declares
  // names like `function isValidElement(object) { ... }` at module scope;
  // a plain `var {isValidElement} = __cjs_exports` then re-declares the
  // same identifier in the same scope, which is a SyntaxError under
  // strict mode (and `<script type="module">` is always strict). Renaming
  // the destructured locals sidesteps the collision while preserving the
  // public named-export contract consumers depend on.
  const destructured = names.map((n) => `${n}:_ne_${n}`).join(",");
  const exported = names.map((n) => `_ne_${n} as ${n}`).join(",");
  const replacement =
    `var __cjs_exports=${requireFnName}();` +
    `export{__cjs_exports as default};` +
    `var{${destructured}}=__cjs_exports;` +
    `export{${exported}};`;

  return bundledEsm.replace(
    /export default \w+\(\);?\s*$/,
    replacement + "\n",
  );
}

await mkdir(OUT_DIR, { recursive: true });

let totalBytes = 0;
for (const { id, specifier, external } of ENTRIES) {
  process.stdout.write(`  bundling ${specifier} … `);

  // Resolve the specifier to an absolute path. Bun.build requires file-system
  // paths as entrypoints, not bare specifiers.
  const entryPath = Bun.resolveSync(specifier, REPO_ROOT);

  const result = await Bun.build({
    entrypoints: [entryPath],
    target: "browser",
    format: "esm",
    // Preserve identifiers so addNamedExports can pattern-match __commonJS
    // and __export by name. Whitespace+syntax minification still applies.
    minify: { whitespace: true, identifiers: false, syntax: false },
    sourcemap: "none",
    external: external as string[],
    define: { "process.env.NODE_ENV": '"production"' },
  });

  if (!result.success || result.outputs.length === 0) {
    const msgs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`Failed to bundle ${specifier}:\n${msgs}`);
  }

  const raw = await result.outputs[0]!.text();
  const content = addNamedExports(raw, id);

  // Belt-and-suspenders: every entry must end with an `export{...}` named-
  // exports clause appended by addNamedExports. If a future Bun output shape
  // sneaks past the regexes (returning an unchanged bundle without throwing),
  // catch it here before the broken bytes get written.
  if (!/export\{[^}]+\};?\s*$/.test(content.slice(-2000))) {
    throw new Error(
      `addNamedExports[${id}]: post-process produced no named-export clause. ` +
        `Tail (last 500 bytes):\n${content.slice(-500)}`,
    );
  }

  // Assert that external packages survive as bare ESM imports (not inlined).
  // If Bun ever inlines despite the external flag, we'd have duplicate React
  // instances and the onLoad chain would break with hook errors.
  for (const ext of external) {
    const quoted = [`"${ext}"`, `'${ext}'`];
    if (!quoted.some((q) => content.includes(q))) {
      throw new Error(
        `Bundle ${id} does not preserve bare import of "${ext}". ` +
          `Single-React-instance invariant violated — check Bun.build external handling.`,
      );
    }
  }

  const outPath = join(OUT_DIR, `${id}.js`);
  await writeFile(outPath, content, "utf8");

  const kb = (content.length / 1024).toFixed(1);
  totalBytes += content.length;
  console.log(`ok (${kb} KB) → ${id}.js`);
}

console.log(
  `\nReact bundles written to packages/cli/src/embedded/  (${(totalBytes / 1024).toFixed(1)} KB total)`,
);
