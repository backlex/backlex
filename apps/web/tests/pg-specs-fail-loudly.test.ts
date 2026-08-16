/**
 * A Postgres spec may not swallow its own harness failure.
 *
 * These files used to open with `try { harness = await makeHarnessPg() } catch
 * { console.warn("skipping"); return }`, seventeen times over, and the effect
 * was that a broken harness turned fifty-one Postgres tests into fifty-one
 * PASSES. bun has no notion of "returned early" — a test that registers and
 * does nothing is reported as a pass — so a run in which the whole pg dialect
 * went untested was indistinguishable, in the summary line and in CI, from one
 * where every assertion held. That is not a gate.
 *
 * Nothing external is missing on such a run, either. `@electric-sql/pglite` is
 * a WASM Postgres in the dependency tree and ships pgvector in the same
 * package: no Docker, no server, and the `DATABASE_URL` the harness writes is a
 * placeholder that is never dialled. So a boot failure is a defect — a driver
 * call, a migration pglite cannot take, a dependency bump — and it has already
 * been one: the beta-22 positional `drizzle(pg)` call silently ran every query
 * against an empty database, and the skip is why nobody noticed.
 *
 * This is a source scan rather than a behavioural test because the failure it
 * guards is a SHAPE. There is no input that makes a hand-rolled catch visible;
 * the only way to catch one is to read for it, which is what the seventeenth
 * copy would otherwise escape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const TESTS = resolve(import.meta.dir);

/** Every Postgres spec. `pg-smoke` carries the same harness under a different
 *  name, so it is matched by content rather than by suffix — a rule keyed only
 *  on `-pg.test.ts` would have missed the one file that started all this. */
const SELF = "pg-specs-fail-loudly.test.ts";

const pgSpecs = (): { name: string; source: string }[] =>
  readdirSync(TESTS)
    // This file names every pattern it forbids, so it matches its own census.
    .filter((n) => n.endsWith(".test.ts") && n !== SELF)
    .map((name) => ({ name, source: readFileSync(resolve(TESTS, name), "utf8") }))
    .filter(
      (f) =>
        f.name.endsWith("-pg.test.ts") ||
        /makeHarnessPg(OrFail)?\s*\(/.test(f.source) ||
        /@electric-sql\/pglite/.test(f.source),
    );

describe("pg specs fail loudly", () => {
  test("the census is not empty, or this whole file is theatre", () => {
    const names = pgSpecs().map((f) => f.name);
    // A rule that scans nothing passes forever. Seventeen today; the floor is
    // deliberately below that so adding or merging a spec is not a chore, and
    // deliberately above zero so a rename that breaks the glob is caught.
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).toContain("pg-smoke.test.ts");
    expect(names).toContain("auto-migrate-pg.test.ts");
  });

  test("no spec calls the raw harness builder in a catch of its own", () => {
    const offenders = pgSpecs()
      .filter((f) => /\bmakeHarnessPg\s*\(/.test(f.source))
      .map((f) => f.name);
    // `makeHarnessPgOrFail` is the door. Calling `makeHarnessPg` directly is
    // only safe if the caller rethrows, and "only safe if" is precisely the
    // condition seventeen files failed to meet.
    expect(offenders).toEqual([]);
  });

  test("no spec swallows a boot failure into a warning", () => {
    const offenders: string[] = [];
    for (const { name, source } of pgSpecs()) {
      // The exact shape that made a broken harness look green: a caught error
      // reported to the console and then dropped.
      const swallows =
        /catch\s*\([^)]*\)\s*\{[^}]*console\.warn[^}]*\}/s.test(source) &&
        !/throw new Error\(/.test(source);
      if (swallows) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test("no spec keeps the sentinel assertion that existed to fake an assertion", () => {
    // `expect(setupError).toBeDefined()` was added because bun was believed to
    // exit 100 on a test with zero `expect()` calls. Measured on bun 1.4: it
    // does not — a test with no assertions passes and the run exits 0. So the
    // sentinel bought nothing and cost the appearance of coverage. (The real
    // exit-100 hazard is an unclosed PGlite handle, which `makeHarnessPg`
    // guards by closing before it rethrows.)
    const offenders = pgSpecs()
      .filter((f) => /expect\(\s*setupErr(or)?\s*(\?\?[^)]*)?\)\s*\.toBeDefined\(\)/.test(f.source))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  test("the escape hatch is opt-in, loud, and named in one place", async () => {
    const setup = readFileSync(resolve(TESTS, "setup-pg.ts"), "utf8");
    expect(setup).toContain("BACKLEX_PG_TESTS");
    expect(setup).toContain("optional");
    // It has to say that the spec asserted nothing — a warning that only says
    // "skipping" is what the old ones said, and it read as routine.
    expect(setup).toContain("asserted NOTHING");
    // And CI must not be the thing that sets it.
    const ci = readFileSync(resolve(TESTS, "..", "..", "..", ".github/workflows/test.yml"), "utf8");
    expect(ci).not.toContain("BACKLEX_PG_TESTS");
  });
});
