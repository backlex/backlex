/**
 * Test preload: a Bun loader plugin that runs the Lingui macro on client
 * `.ts`/`.tsx` files, mirroring the `linguiMacro()` vite plugin in
 * `vite.config.ts`.
 *
 * Lingui v6 macros (`t`, `Trans`, `useLingui`, …) are COMPILE-TIME: without the
 * babel pass they survive to runtime and throw ("executed outside the context
 * of compilation"). `bun test` doesn't run vite, so any client component that
 * imports `@lingui/*` would crash when rendered. This plugin transforms those
 * files with the macro plugin ONLY (leaving TS/JSX for Bun's own transpiler),
 * so React render tests can mount real admin components.
 *
 * Scope: the loader only fires for files actually imported under `src/client/`
 * that reference `@lingui/`. The ~600 backend specs never import those, so they
 * pay nothing.
 */
import * as babel from "@babel/core";

Bun.plugin({
  name: "lingui-macro",
  setup(build) {
    build.onLoad({ filter: /\/src\/client\/.*\.[cm]?tsx?$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const loader = args.path.endsWith("x") ? "tsx" : "ts";
      if (!code.includes("@lingui/")) {
        // Not a macro file — hand the original source back for Bun to transpile.
        return { contents: code, loader };
      }
      const result = await babel.transformAsync(code, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        sourceMaps: "inline",
        // Parse TS (+ JSX for .tsx); apply ONLY the macro plugin — types and
        // JSX are left intact for Bun's transpiler to handle next.
        parserOpts: {
          plugins: args.path.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
        },
        plugins: ["@lingui/babel-plugin-lingui-macro"],
      });
      return { contents: result?.code ?? code, loader };
    });
  },
});
