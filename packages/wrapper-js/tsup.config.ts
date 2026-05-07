import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/postinstall.ts", "src/spawn.ts", "src/index.ts"],
  format: ["esm"],
  target: "node22",
  // composite:true in the package tsconfig conflicts with tsup's temp DTS tsconfig;
  // override to false so the DTS pass can resolve all source files.
  dts: { compilerOptions: { composite: false, declarationMap: false } },
  sourcemap: false, // omitted intentionally — supply-chain code should be plainly readable
  clean: true,
  splitting: false,
  minify: false,
  shims: false,
});
