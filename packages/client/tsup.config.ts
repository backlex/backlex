import { defineConfig } from "tsup";

// npm build. The package is source-consumed inside the monorepo (exports → src/),
// but npm consumers get compiled ESM + bundled .d.ts from dist/. The @backlex/core
// `condition` slice is already vendored into src/, so output is small and has zero
// runtime dependencies. (JSR consumers get the raw TS via jsr.json instead.)
export default defineConfig({
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    webhook: "src/webhook.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
