/**
 * The competitor's name stays out of the code side.
 *
 * A standing preference, and this is the second time it has had to be applied:
 * a repo-wide scrub ran on 2026-07-03, and by 2026-08-31 the name was back in
 * two places — a test file's header comment and a CSS section rule. That is how
 * a one-time cleanup behaves. Nothing was watching, so the next person reaching
 * for design shorthand wrote it again, exactly as before.
 *
 * WHAT IS IN SCOPE, AND WHAT DELIBERATELY IS NOT
 *
 * Code: `.ts` / `.tsx` comments and strings, tests, stylesheets, and the UI
 * message catalogs. Use neutral phrasing instead — "operator-style filter" for
 * the `{field:{_eq}}` DSL, "schema editor", "permission matrix", "sidecar
 * model".
 *
 * NOT in scope, and neither is an oversight:
 *
 *  - **Docs, README and the marketing site.** Naming a competitor in a
 *    comparison page is the entire point of the page; `apps/site` ships a whole
 *    `/vs-<competitor>` route. The directive was about the code side.
 *  - **`packages/db/drizzle/**\/migration.sql`.** Two of them carry the name in
 *    a comment and they must keep it. `migrate-d1.ts` hashes each migration
 *    with `sha256(readFileSync(file))` — the RAW file text, comments included —
 *    and skips anything whose hash is already in `__drizzle_migrations`.
 *    Editing one character of a comment therefore mints a hash the ledger has
 *    never seen, and the migration REPLAYS on every deployed tenant, appending
 *    a fresh ledger row while it is at it. A tidier comment is not worth a
 *    replay across production.
 *
 * WHAT KEEPS THIS FROM BEING A DECORATION
 *
 * A scan that walks nothing reports zero violations, which reads exactly like a
 * clean tree. So the file count is asserted too, and the matcher is run against
 * a synthetic string it MUST reject — that case fails even when the real tree
 * is spotless.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Written split so this file does not trip its own rule. */
const NAME = ["direct", "us"].join("");
const PATTERN = new RegExp(NAME, "i");

const HERE = new URL(".", import.meta.url).pathname;
/** Repo root, so a hit is reported at a path a reader can paste. Derived, not
 *  matched on a substring: `indexOf` returning -1 would silently mangle the one
 *  message this guard exists to print. */
const ROOT = join(HERE, "..", "..", "..");
const ROOTS = [
  join(HERE, "..", "src"), // apps/web/src — server + admin SPA
  HERE, // apps/web/tests
  join(HERE, "..", "..", "..", "packages"), // every workspace package
];
const EXTENSIONS = [".ts", ".tsx", ".css", ".po"];
const SKIP_DIRS = new Set(["node_modules", "dist", "drizzle", ".turbo", "build"]);

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
      continue;
    }
    // Generated artifacts restate whatever their source said; the source is
    // what this rule is about.
    if (name.endsWith(".generated.json") || name.endsWith(".generated.ts")) continue;
    if (EXTENSIONS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
};

const FILES = ROOTS.flatMap((r) => walk(r));

describe("the competitor's name stays out of the code side", () => {
  test("no source, test, stylesheet or message catalog names it", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      let src: string;
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (!PATTERN.test(src)) continue;
      // This file holds the name only as two halves joined at runtime, so a
      // literal match here would be a real one.
      if (f.endsWith("competitor-name-scrub.test.ts")) continue;
      for (const [i, line] of src.split("\n").entries()) {
        if (PATTERN.test(line)) {
          hits.push(`${f.startsWith(ROOT) ? f.slice(ROOT.length) : f}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("the scan actually walked the tree — a matcher over nothing proves nothing", () => {
    // Roughly 2.5k code-side files today; the floor only has to be high enough
    // that a broken root path or an over-eager skip trips it.
    expect(FILES.length).toBeGreaterThan(800);
    expect(FILES.some((f) => f.endsWith("admin.css"))).toBe(true);
    expect(FILES.some((f) => f.endsWith("items-i18n-sidecar.test.ts"))).toBe(true);
    expect(FILES.some((f) => f.includes("/packages/"))).toBe(true);
  });

  test("the matcher rejects the name when it IS present", () => {
    // Fails even on a spotless tree, which is what keeps the test above honest.
    expect(PATTERN.test(`/* ${NAME}-style grid */`)).toBe(true);
    expect(PATTERN.test(`the ${NAME.toUpperCase()} model`)).toBe(true);
    expect(PATTERN.test("/* permission matrix */")).toBe(false);
  });
});
