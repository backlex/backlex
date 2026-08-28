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
 * | `ai` + `@ai-sdk/*` | 860 KB | the first AI generation, on a deploy that has a key |
 * | `@backlex/db/auto-migrate` | 338 KB | boot on a non-D1 deploy — never on Workers |
 * | `cron-parser` (→ `luxon`) | 260 KB | the `scheduled()` trigger |
 * | `better-auth/crypto` (→ `jose`, `@noble/ciphers`) | 160 KB | nothing: it only wanted scrypt |
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
const walkEager = (): { files: Map<string, string>; packages: Map<string, string> } => {
  const seen = new Map<string, string>(); // file → the file that pulled it in
  const pkgs = new Map<string, string>(); // bare specifier → first importer
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
      const spec = m[1]!;
      const target = resolveSpec(spec, file);
      if (target) {
        stack.push([target, file]);
        continue;
      }
      // Left the workspace: a real `node_modules` package (or a builtin). The
      // specifier is recorded rather than followed, because the packages that
      // dominate this budget are reached through ONE workspace file each, and
      // naming the package is a far more direct assertion than naming the file
      // that happens to import it today.
      if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue;
      if (!pkgs.has(spec)) pkgs.set(spec, file);
    }
  }
  return { files: seen, packages: pkgs };
};

describe("worker startup budget", () => {
  const { files: eager, packages } = walkEager();
  const chain = (needle: string) => {
    const hit = [...eager.keys()].find((f) => f.includes(needle));
    return hit ? `${hit.replace(WEB, "apps/web")}\n  pulled in by: ${eager.get(hit)!.replace(WEB, "apps/web")}` : null;
  };
  /** The eager importer of a bare specifier, or null. Matches the package
   *  itself and anything under it (`ai` covers `ai/foo`, `@ai-sdk/` covers the
   *  whole scope) but NOT a package that merely starts with the same letters —
   *  `pkg("ai")` must not be satisfied by `airtable`. */
  const pkg = (prefix: string) => {
    const under = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const hit = [...packages.keys()].find((p) => p === prefix || p.startsWith(under));
    return hit ? `${hit}\n  imported by: ${packages.get(hit)!.replace(WEB, "apps/web")}` : null;
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

  test("the sanity check on the specifier map is not vacuous", () => {
    // The package assertions below are all negative, and a `packages` map that
    // came back empty (a regex that stopped matching, a walker that returned
    // early) would make every one of them pass while checking nothing.
    expect(packages.size).toBeGreaterThan(5);
    expect(pkg("hono")).not.toBeNull();
    expect(pkg("drizzle-orm")).not.toBeNull();
  });

  test("the AI SDK is not on the startup path", () => {
    // ~860 KB across `ai` and four provider packages, for the two functions in
    // `mcp/ai-client.ts` that generate — both already async, both reaching
    // `mcp/ai-sdk.ts` through `import()`. A deployment with no AI configured
    // never loads any of it. `import type ... from "ai"` is erased and so is
    // invisible here, which is correct: a type costs no startup.
    expect(chain("mcp/ai-sdk.ts")).toBeNull();
    expect(pkg("ai")).toBeNull();
    expect(pkg("@ai-sdk/")).toBeNull();
  });

  test("the cron scheduler is not on the startup path", () => {
    // `services/scheduler.ts` is the only importer of `cron-parser`, which is
    // the only importer of `luxon` — 260 KB of date/timezone machinery behind a
    // `scheduled()` trigger and an opt-in HTTP endpoint. Neither is a request.
    expect(chain("services/scheduler.ts")).toBeNull();
    expect(pkg("cron-parser")).toBeNull();
  });

  test("the migration bundles are not on the startup path", () => {
    // `auto-migrate.ts` inlines both dialects' bundles — 259 `.sql` files, 338
    // KB of text the isolate compiled at boot. Its one caller is already inside
    // `if (!env.D1)`, i.e. never on Workers, where `wrangler d1 migrations
    // apply` has run during the build. `@backlex/db`'s index re-exports the
    // TYPES only; making that a value export again restores every byte.
    expect(chain("db/src/auto-migrate.ts")).toBeNull();
    expect(chain("migrations-bundle.ts")).toBeNull();
  });

  test("secret hashing does not reach better-auth's crypto index", () => {
    // `better-auth/crypto` re-exports JWT + symmetric-encryption helpers on top
    // of the scrypt `secret-hash.ts` wants, which is `jose` + `@noble/ciphers`
    // — ~160 KB — eager, for a module used only to hash a `hash`-typed field.
    // The leaf is `@better-auth/utils/password`; `tests/secret-hash.test.ts`
    // pins that the digest format did not move with it.
    expect(pkg("better-auth/crypto")).toBeNull();
  });

  test("the eager source graph stays inside its recorded budget", () => {
    let bytes = 0;
    for (const f of eager.keys()) bytes += statSync(f).size;
    const kib = Math.round(bytes / 1024);
    // Re-recorded 2026-08-29 at 7761 KiB of workspace source across 614
    // modules — `apps/web/src/server` plus the `packages/*` it reaches, with
    // everything in `node_modules` excluded (this walks source, and stops where
    // source stops). The built bundle those become measures 6062 KiB.
    //
    // The two figures move at very different rates and neither predicts the
    // other: this pass took 2117 KiB off the BUILT graph but only 444 KiB off
    // the source one, because most of what left was `node_modules` — the AI
    // SDK, luxon, jose, the migration `.sql` text — which this side never
    // counted in the first place. Read them as two independent tripwires, not
    // as one number measured twice.
    //
    // Headroom is for ordinary growth. A jump means something large became
    // reachable eagerly, and the fix is a dynamic import at the seam — not a
    // bigger number here. Re-record deliberately, in the commit that earns it.
    expect(kib).toBeLessThan(8200);
  });
});
