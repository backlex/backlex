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
    //
    // Raised 8200 → 8250 on 2026-09-05, measured at 8214. What crossed the line
    // was realtime workspace namespacing: one new ~2.5 KiB module
    // (`services/realtime-topic.ts`) and ~11 KiB of comment across the transport
    // files. Nothing new became REACHABLE — the eager module count is unchanged
    // but for the one addition — so a dynamic import has nothing to bite on
    // here; this is the ordinary growth the headroom is for.
    //
    // Raised 8250 → 8300 on 2026-09-05, measured at 8252 across 627 modules.
    // Row-level permission on the read paths added two modules — 6.0 KiB
    // `services/items/row-access.ts` and 5.5 KiB `services/vector-access.ts` —
    // and the rest is comment on the sites they clamp. Both import only what
    // the graph already reached (`permissions`, `collection-loader`,
    // `sql-helpers`, `vectorize`), so nothing new became REACHABLE and there
    // is again no seam a dynamic import would help.
    //
    // Raised 8300 → 8350 on 2026-09-06, measured at 8306 across 632 modules.
    // Four new modules totalling 17.5 KiB — `mcp/mounts.ts` (1.7 KiB),
    // `middleware/credential-scope.ts` (5.9 KiB), `services/saml-binding.ts`
    // (4.9 KiB), `lib/client-address.ts` (4.9 KiB) — and the remaining ~36 KiB
    // is comment on the eager files those two phases touched. Every one of the
    // four imports only what the graph already reached (`mcp/internal-fetch`,
    // `lib/runtime`, `@backlex/core`), so again nothing new became REACHABLE
    // and there is no seam.
    //
    // Worth its own note: **neither phase crossed this line alone.** Phase 6
    // and phase 7 were written in parallel worktrees, each ran the full suite
    // against its own branch, and each was green. 8306 exists only in the
    // merge. A per-branch budget check does not compose, so a stack of green
    // branches still owes one gate on the tree that actually ships.
    //
    // Raised 8350 → 8450 on 2026-09-06, measured at 8402. Phase 10 — the audit's
    // medium/low sweep — added THREE modules totalling 11.4 KiB:
    // `lib/security-headers.ts` (7.4 KiB, the CSP/XFO/HSTS constants the Hono
    // middleware, `public/_headers` and the Vercel build config now all read
    // from one place), `services/storage/limit-stream.ts` (2.4 KiB) and
    // `services/integrations-fetch.ts` (1.6 KiB). The remaining ~40 KiB is
    // comment: 1,803 net lines across the eager files the sweep touched, and
    // this walk counts source bytes, so a paragraph explaining a fail-open
    // compiler weighs the same as the code that closed it.
    //
    // Nothing new became REACHABLE. All three import only what the graph already
    // reached (`@backlex/core`, `services/storage/hosts`, `../env`), so there is
    // no seam a dynamic import would bite on — this is the ordinary growth the
    // headroom is for. The one thing that WOULD move the number materially is
    // `security-headers.ts` growing a runtime dependency; it deliberately has
    // none.
    // Raised 8450 → 8465 on 2026-09-08, measured at 8455. ONE module:
    // `services/revocation-epoch.ts` (#319), the shared signal that lets an
    // isolate which never served a revoke stop honouring the revoked cookie.
    // ~5 KiB, and most of it is the comment explaining why it is an
    // `app_settings` row and not a Durable Object — this walk counts source
    // bytes, so that paragraph weighs what the code does.
    //
    // Nothing new became REACHABLE, which is the test that matters here:
    // `middleware/session.ts` is the importer and it already pulled in both
    // `@backlex/db/pg` and `@backlex/db/sqlite` on line 1-2. There is no seam a
    // dynamic import would bite on.
    //
    // Raised 8465 → 8480 on 2026-09-10, measured at 8471 across 638 modules.
    // ZERO new modules: #345's method granularity edited three files that were
    // already eager — `lib/route-planes.ts`, `middleware/plane-firewall.ts`,
    // `services/app-orgs.ts` — and the ~6 KiB is almost entirely the comment
    // arguing why a qualified entry can only narrow, and why an org slugged
    // `invites` had to be refused at write time. This walk counts source bytes,
    // so that argument weighs what the three lines of matcher do.
    //
    // A count with no new module is the cheapest kind of raise to grant and the
    // easiest to grant carelessly, so the check that matters is the one above:
    // `eager.size` moved by nothing, and there is no seam a dynamic import
    // would bite on.
    //
    // Raised 8465 → 8480 on 2026-09-10, measured at 8469. ZERO new modules:
    // #315 added the polymorphic-reference sweep to two files that were already
    // eager (`packages/db/src/field-types.ts`, `services/items/on-delete.ts`)
    // plus one line of zod in `routes/collections.ts`. The ecommerce template
    // itself is NOT counted — `templates/catalog.ts` is behind `templates/lazy`
    // and this file asserts that two tests up, which is why 68 lines of
    // commerce schema move this number by nothing.
    //
    // Most of the ~4 KiB is the argument for why `cascade` is the only action a
    // polymorphic ref supports and why the read side re-checks the sibling
    // column. This walk counts source bytes, so that weighs what the DELETE
    // does.
    //
    // MERGE NOTE, 2026-09-10: the two raises above were measured on separate
    // branches (8471 and 8469) and BOTH landed on 8480. Together they measure
    // **8479** — one KiB under, which is the composition failure this file
    // already records once (`8306 exists only in the merge`) arriving again and
    // being caught this time. Two more branches raising this line are in flight
    // (#335, #317); each has to re-measure on ITS merge rather than take the
    // largest of the four, and the number stays 8480 here because 8479 is what
    // this tree actually costs.
    //
    // Raised 8480 → 8500 on 2026-09-10, measured at 8492 ON THE MERGE. ZERO new modules:
    // #335 edited files already on the eager path — `env.ts`,
    // `routes/functions.ts`, `services/sandbox/{index,types,host-bridge}.ts`,
    // `services/{functions,flows,jobs,settings}.ts` — and the two SQL migration
    // files it adds are text the bundle already excludes.
    //
    // Note what did NOT move it. `services/scheduler.ts` is off the startup
    // path (asserted three tests up, because `cron-parser` → `luxon` is 260 KB
    // behind a `scheduled()` trigger), so the runner edits there are free. The
    // ~9 KiB is the argument for why NULL keeps the soft sandbox, and why the
    // per-workspace fetch list can only narrow — this walk counts source bytes,
    // so those weigh what the two decision functions do.
    //
    // 8485 was this branch's own number, measured at 8474 in isolation. The
    // MERGE measures 8492 — the third time in one day that a per-branch figure
    // did not survive contact with the others, which is the thing the note
    // above is about. One branch (#317) is still in flight and will have to do
    // this again.
    //
    // Raised 8465 → 8475 on 2026-09-10, measured at 8466. ONE new module:
    // `services/schema-reapply.ts` (#317), the daily sweep that brings every
    // workspace's physical tables forward. Net +1 KiB, because the loop MOVED
    // there out of `routes/db-admin.ts` rather than being added beside it.
    //
    // It is eager through `routes/db-admin.ts`, not through the scheduler —
    // `services/scheduler.ts` is off the startup path (asserted three tests up)
    // and its import of this module costs nothing. What it pulls in,
    // `@backlex/db`'s `applyCollection` and `services/collections-cache`, the
    // graph already reached, so there is no seam a dynamic import would bite
    // on.
    //
    // A note for whoever merges next, because this file has been bitten by it
    // before: FOUR branches raised this line in parallel (#345, #315, #335,
    // #317), each measured and green against its own tree. A per-branch budget
    // check does not compose — re-measure on the merge rather than taking the
    // largest of the four.
    //
    // FINAL of the four, 2026-09-10. This branch measured 8466 alone and set
    // 8475; the merged tree measures **8497 across 639 modules** — the one new
    // module (`services/schema-reapply.ts`) plus the three branches that landed
    // ahead of it. Ceiling stays 8500, which is 3 KiB of headroom, so the next
    // change to an eager file will trip this and should.
    //
    // ONE THING THIS NUMBER IS NOT, and it cost a red deploy to establish:
    // `Workers Builds` rejected PR #367 with CF 10021 (`Script startup exceeded
    // CPU time limit`) and a RETRIGGER OF THE SAME COMMIT succeeded. The only
    // delta against main there was comment, which the bundler strips. So this
    // source-byte figure is a proxy for reachability, NOT for the limit CF
    // enforces — measured on that tree, the BUILT eager graph was 29 modules /
    // 6128 KiB / 240.5 ms compile + top-level on this machine's V8, which
    // `measure-startup.mjs` puts at roughly 2-3x that on Cloudflare. That is
    // the band this file's header already records as intermittently rejected.
    // Raising this line does not buy startup headroom and never did.
    //
    // The millisecond half now has its own guard: `bun run startup:budget`
    // (`scripts/check-startup-budget.ts`), which runs in the pre-push gate and
    // in CI's `build` job because it reads the BUILT bundle rather than source.
    // Keep both. This one catches something becoming REACHABLE; that one
    // catches it becoming EXPENSIVE, and the two are not the same event — a
    // 404 KiB module that only declares object literals costs 1.5 ms.
    // Raised 8500 → 8515 on 2026-09-13, measured at 8504 — and this is the
    // "next change to an eager file" the note above predicted would trip it.
    // #377: `?expand=` into a collection with a `localized` field was an
    // unconditional 500 (`no such column: rel_category.name`), because the
    // expand builder read every target field off the join alias and a localized
    // field has no column there. The growth is `buildLocalizedRefs` in
    // `services/items/i18n-sidecar.ts` plus the locale plumbing in
    // `services/items/expand.ts`.
    //
    // Nothing new became REACHABLE, which is the only thing this line measures
    // (see the paragraph above on why it is not a startup-time proxy):
    // `i18n-sidecar.ts` was already imported by both `routes/items/list.ts` and
    // `routes/items/read.ts`, and the nine "not on the startup path" guards are
    // green. `bun run startup:budget` — the half that reads the BUILT bundle —
    // is the one to watch if this ever stops being true.
    expect(kib).toBeLessThan(8515);
  });
});
