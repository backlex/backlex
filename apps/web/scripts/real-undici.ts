/**
 * Bun preload: make the bare specifier `undici` resolve to the real npm package.
 *
 * Why this exists — `bun run dev` dies at startup without it:
 *
 *     TypeError: this.#runtimeDispatcher?.close is not a function
 *       at #assembleAndUpdateConfig (miniflare/dist/src/index.js)
 *       at startOrUpdateMiniflare   (@cloudflare/vite-plugin)
 *
 * `#runtimeDispatcher` is an undici `Pool` — miniflare's transport into workerd.
 * Bun ships a BUILT-IN `undici` shim that wins over the installed package for the
 * bare specifier, and that shim implements only `request()`. `close()`, `destroy()`
 * and `dispatch()` are all missing, so miniflare trips on the first one it touches
 * (`close`, when it tears down the previous dispatcher to re-assemble the config)
 * and would trip on `dispatch` immediately after — that one is how every request
 * reaches workerd. Patching a single method would not be enough.
 *
 * Bun loads the real package fine when pointed at an absolute path; only the bare
 * specifier loses. So we resolve it the way Node would — from miniflare's own
 * directory, so we pick the exact copy miniflare depends on rather than guessing
 * between the several `undici` versions the workspace has installed — and re-point
 * the specifier at it.
 *
 * Self-disabling: if Bun ever drops the shim, `Bun.resolveSync("undici", …)` starts
 * returning a real absolute path instead of the bare string `"undici"`, and this
 * becomes a no-op. Delete it once that ships everywhere we build.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { plugin } from "bun";

function findRealUndici(): string | undefined {
  try {
    // Bun's built-in shim answers the bare specifier with the bare string. An
    // absolute path means the shim is gone and there is nothing left to fix.
    const current = Bun.resolveSync("undici", import.meta.dir);
    if (current.startsWith("/")) return undefined;
  } catch {
    // Not resolvable at all — no shim to shadow anything, so also nothing to fix.
    return undefined;
  }

  // miniflare is a transitive dep of the CF vite plugin, not hoisted to apps/web,
  // so walk the chain rather than resolving it directly.
  const cfPlugin = Bun.resolveSync("@cloudflare/vite-plugin", import.meta.dir);
  const miniflare = Bun.resolveSync("miniflare", dirname(cfPlugin));

  let pkgRoot = dirname(miniflare);
  while (pkgRoot !== "/" && !pkgRoot.endsWith("/node_modules/miniflare")) {
    pkgRoot = dirname(pkgRoot);
  }
  if (pkgRoot === "/") return undefined;

  // Bun's isolated layout puts miniflare's own deps beside it.
  const entry = join(dirname(pkgRoot), "undici", "index.js");
  return existsSync(entry) ? entry : undefined;
}

let real: string | undefined;
try {
  real = findRealUndici();
} catch (err) {
  // Never take the dev server down from here. If this fails, the caller gets the
  // original miniflare crash, which is at least a documented symptom.
  console.warn(`[real-undici] could not locate the real undici: ${(err as Error).message}`);
}

if (real) {
  plugin({
    name: "real-undici",
    setup(build) {
      build.onResolve({ filter: /^undici$/ }, () => ({ path: real }));
    },
  });
}
