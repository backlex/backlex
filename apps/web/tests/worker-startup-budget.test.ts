import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * What the worker pays for before it can answer anything.
 *
 * Cloudflare rejects a deploy whose script spends too long starting up — error
 * 10021, `Script startup exceeded CPU time limit`. That budget covers V8
 * compiling the EAGER module graph and running every module's top-level code,
 * and this worker has been close enough to the line to fail intermittently: the
 * same bundle measured 635 ms, 803 ms and 928 ms across three builds, one of
 * which was rejected. A retry passed, which is exactly what makes it dangerous
 * — nothing about the code changed between the failure and the success.
 *
 * So the graph itself is the thing to hold. Every static `import` from the
 * worker entry is startup cost; every `import()` is not. The three modules
 * asserted below are the ones that were found in the eager graph and moved out
 * (roughly 3.1 MB of the 11.3 MB total), and each is only ever needed by one
 * narrow surface:
 *
 * | module | ~size | who actually needs it |
 * |---|---|---|
 * | `templates/catalog` | 900 KB | the template picker + apply + first-user seeding |
 * | `openapi-static.generated.json` | 900 KB | `GET /api/openapi.json` |
 * | `@backlex/auth` (better-auth + kysely) | 1.3 MB | the first request that resolves a session |
 *
 * This walks SOURCE, not the built bundle, so it runs in the ordinary suite
 * with nothing built. It is therefore blind to what the bundler does with the
 * graph afterwards — and that half matters just as much, because
 * `vite.config.ts::workerManualChunks` pins un-listed `node_modules` into the
 * eager `vendor` chunk regardless of how they were imported. A dynamic import
 * of a package with no branch there buys nothing. Measure the built article
 * with `node apps/web/scripts/measure-startup.mjs`.
 */

const WEB = resolve(import.meta.dir, "..");
const ENTRY = join(WEB, "src/server/entries/worker.ts");

/** Resolve a specifier the way the bundler will, or `null` if it leaves the
 *  workspace source we can walk (a real `node_modules` package). */
const resolveSpec = (spec: string, fromFile: string): string | null => {
  let base: string;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith("@backlex/")) {
    const [, pkg, ...rest] = spec.split("/");
    const root = join(WEB, "../../packages", pkg!);
    if (!existsSync(root)) return null;
    base = rest.length ? join(root, "src", ...rest) : join(root, "src/index");
  } else return null;

  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
};

/**
 * Every module reachable from the entry through STATIC imports.
 *
 * `import type` and inline `import { type X }` are erased before the bundler
 * sees them, so they create no runtime edge and are skipped — that is what lets
 * a service keep its catalog TYPES while reaching the catalog's VALUES lazily.
 */
const walkEager = (): Map<string, string> => {
  const seen = new Map<string, string>(); // file → the file that pulled it in
  const stack: Array<[string, string]> = [[ENTRY, "(entry)"]];
  while (stack.length) {
    const [file, importer] = stack.pop()!;
    if (seen.has(file)) continue;
    seen.set(file, importer);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // `import … from "x"` / `export … from "x"` / bare `import "x"`, minus
    // whole-clause type imports. A clause whose specifiers are ALL `type`-marked
    // is erased too, but leaving those in only ever over-reports, never under-.
    const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g;
    for (const m of src.matchAll(re)) {
      const target = resolveSpec(m[1]!, file);
      if (target) stack.push([target, file]);
    }
  }
  return seen;
};

describe("worker startup budget", () => {
  const eager = walkEager();
  const chain = (needle: string) => {
    const hit = [...eager.keys()].find((f) => f.includes(needle));
    return hit ? `${hit.replace(WEB, "apps/web")}\n  pulled in by: ${eager.get(hit)!.replace(WEB, "apps/web")}` : null;
  };

  test("the graph the entry actually reaches is non-trivial (else every assertion below is vacuous)", () => {
    // Without this, a resolver bug that returns null for everything would make
    // the whole file pass while checking nothing.
    expect(eager.size).toBeGreaterThan(500);
    expect([...eager.keys()].some((f) => f.endsWith("src/server/app.ts"))).toBe(true);
  });

  test("the schema-template catalog is not on the startup path", () => {
    // Reach it through `templates/lazy.ts`. Types are free; values are not.
    expect(chain("templates/catalog.ts")).toBeNull();
    expect(chain("templates/defs/")).toBeNull();
  });

  test("the precomputed OpenAPI document is not on the startup path", () => {
    // ~900 KB the bundler emits as a top-level `JSON.parse`, for a route most
    // deploys never receive a request for. `lib/openapi.ts` loads it on demand.
    const openapi = [...eager.keys()].find((f) => f.includes("openapi-static.generated"));
    expect(openapi ?? null).toBeNull();
  });

  test("better-auth is not on the startup path", () => {
    // Both auth instances are built behind `import()` — `context.ts` for the
    // admin plane, `services/tenant-auth.ts` for the app plane. Hot-path
    // hashing reaches the leaf module (`@backlex/auth/secret-hash`) instead of
    // the index, which is what re-exports better-auth.
    expect(chain("packages/auth/src/index.ts")).toBeNull();
    expect(chain("packages/auth/src/tenant.ts")).toBeNull();
  });

  test("the eager source graph stays inside its recorded budget", () => {
    let bytes = 0;
    for (const f of eager.keys()) bytes += statSync(f).size;
    const kib = Math.round(bytes / 1024);
    // Recorded 2026-08-29 at 8205 KiB of workspace source across 880 modules —
    // `apps/web/src/server` plus the `packages/*` it reaches, with everything
    // in `node_modules` excluded (this walks source, and stops where source
    // stops). The built bundle those become measures 8179 KiB; the two numbers
    // being close is a coincidence of what each side counts, not a check.
    //
    // Headroom is for ordinary growth. A jump means something large became
    // reachable eagerly, and the fix is a dynamic import at the seam — not a
    // bigger number here. Re-record deliberately, in the commit that earns it.
    expect(kib).toBeLessThan(9000);
  });
});
