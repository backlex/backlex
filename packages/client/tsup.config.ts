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
    // `backlex/react` — the useLiveQuery hook. React is an optional peer, kept
    // external so it's never bundled into the (otherwise zero-dependency) SDK.
    react: "src/react.ts",
  },
  format: ["esm"],
  external: ["react"],
  dts: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
