import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/postinstall.ts"],
  format: ["esm"],
  target: "node22",
  dts: false,
  sourcemap: false, // omitted intentionally — supply-chain code should be plainly readable
  clean: true,
  splitting: false,
  minify: false,
  shims: false,
});
