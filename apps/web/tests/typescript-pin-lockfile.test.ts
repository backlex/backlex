/**
 * Lockfile guard: the TypeScript a workspace DECLARES must be the TypeScript it
 * RESOLVES, and the three workspaces that deliberately stay behind must stay
 * behind for the reason they were left there.
 *
 * The repo runs `typescript` 7.0.2 — the Go port. 7.0 ships **no compiler API**:
 * its package `exports` map resolves `.` to a version stub, so
 * `require("typescript")` succeeds and the first `ts.…` call is what throws.
 * Three workspaces therefore hold an older, real TypeScript in their own
 * `devDependencies`, and each one breaks differently if that is "tidied":
 *
 *   - `packages/client` — `tsup`'s declaration step runs `rollup-plugin-dts`,
 *     which dies on `ts.sys.useCaseSensitiveFileNames`. Bumping this pin makes
 *     the published SDK unbuildable.
 *   - `apps/docs` / `apps/site` — `astro check` imports the API outright.
 *
 * `packages/cli` is NOT in that list and must not be added to it: its
 * `tsup.config.ts` never sets `dts: true`, so no declaration step runs and it
 * moved to 7.0 cleanly.
 *
 * Why a lockfile test rather than trust in the declarations: this repo has
 * already been bitten by a declared pin failing to constrain what actually got
 * installed (see `vite-pin-lockfile.test.ts` — `apps/site` named vite 8.0.13
 * for weeks while astro resolved its own nested copy straight past it). A
 * nested `typescript` is exactly that shape, so the assertions below read what
 * `bun.lock` RESOLVED, not what a package.json asked for.
 *
 * No version is hardcoded. A deliberate bump passes. Two things fail: a silent
 * divergence, and lifting one of the three pins — which is intentional, because
 * 7.1 restores an API and lifting them then means deleting the entry here and
 * re-reading why it existed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoPath = (rel: string): string =>
  fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

const read = (rel: string): string => readFileSync(repoPath(rel), "utf8");

const lockfile = read("bun.lock");

type Pkg = {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const readPkg = (workspace: string): Pkg =>
  JSON.parse(read(`${workspace}/package.json`)) as Pkg;

const declaredTypescript = (workspace: string): string | undefined => {
  const pkg = readPkg(workspace);
  return pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
};

/**
 * Every workspace directory the root package.json globs in.
 *
 * A workspace is a directory with a `package.json` — the glob's own definition.
 * Filtering on that rather than on "is a directory" is not cosmetic: switching
 * away from a branch that carried an example leaves `examples/<name>/` behind
 * holding nothing but its gitignored `node_modules`, git reports the tree as
 * clean, and this file then died with a bare
 * `ENOENT: examples/perfops-react/package.json` — a crash, in a test about
 * TypeScript versions, caused by a branch checkout. Seen 2026-08-30.
 */
const workspaces = (): string[] =>
  ["apps", "packages", "examples"].flatMap((dir) =>
    readdirSync(repoPath(dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`)
      .filter((w) => existsSync(repoPath(`${w}/package.json`))),
  );

/** Every distinct version the lockfile resolved for a package. */
const resolvedVersions = (pkg: string): string[] => {
  const re = new RegExp(`"${pkg.replace("/", "\\/")}@(\\d+\\.\\d+\\.\\d+)"`, "g");
  return [...new Set([...lockfile.matchAll(re)].map((m) => m[1] as string))].sort();
};

const major = (v: string): number => Number(v.split(".")[0]);

/**
 * The workspaces that deliberately hold a pre-7.0 TypeScript, and what breaks
 * if they don't. Deleting an entry here is how a pin gets lifted — on purpose,
 * with the reason in front of you.
 */
const API_PINNED: ReadonlyArray<readonly [string, string]> = [
  ["packages/client", "tsup's rollup-plugin-dts calls ts.sys — the published SDK stops building"],
  ["apps/docs", "astro check imports the compiler API"],
  ["apps/site", "astro check imports the compiler API"],
];

const ROOT = ".";

describe("typescript lockfile resolution", () => {
  test("the workspace census is not empty, or every rule below is vacuous", () => {
    // The filter above drops any directory without a package.json, which is
    // correct and is also exactly how this file could quietly stop checking
    // anything — a moved `examples/` or a renamed glob root would leave an
    // empty list and every `offenders` assertion would pass over it. The floor
    // sits well under the ~20 workspaces here so adding one is not a chore.
    const found = workspaces();
    expect(`workspaces found: ${found.length > 10}`).toBe("workspaces found: true");
    expect(found).toContain("apps/web");
    expect(found).toContain("packages/client");
  });

  test("the root declares an exact version, not a range", () => {
    // A range is how a transitive copy drifts upward unnoticed; every
    // assertion below rests on the declaration being a single answerable value.
    const root = declaredTypescript(ROOT);
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the root is on the Go port (7.x or later)", () => {
    expect(major(declaredTypescript(ROOT) as string)).toBeGreaterThanOrEqual(7);
  });

  test("every workspace that is not API-pinned declares exactly the root version", () => {
    const root = declaredTypescript(ROOT) as string;
    const pinned = new Set(API_PINNED.map(([w]) => w));
    const offenders = workspaces()
      .filter((w) => !pinned.has(w))
      .map((w) => [w, declaredTypescript(w)] as const)
      .filter(([, v]) => v !== undefined && v !== root);
    // Reported as pairs so a failure names the workspace and its version
    // rather than just a count.
    expect(offenders).toEqual([]);
  });

  for (const [workspace, why] of API_PINNED) {
    test(`${workspace} stays on a TypeScript that HAS a compiler API — ${why}`, () => {
      const declared = declaredTypescript(workspace);
      expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
      // 7.0 is the version with no API. 7.1 restores one; when this repo moves
      // there, delete the entry from API_PINNED rather than loosening this.
      expect(major(declared as string)).toBeLessThan(7);
    });

    test(`${workspace}'s pin is actually resolved, not just declared`, () => {
      expect(resolvedVersions("typescript")).toContain(declaredTypescript(workspace) as string);
    });
  }

  test("packages/cli is not API-pinned — its tsup config runs no declaration step", () => {
    // The inverse guard. `packages/cli` looks like `packages/client` from the
    // outside (same bundler, same publish shape) and the temptation is to pin
    // it "for symmetry". It does not set `dts: true`, so it does not need to.
    expect(API_PINNED.map(([w]) => w)).not.toContain("packages/cli");
    expect(declaredTypescript("packages/cli")).toBe(declaredTypescript(ROOT));
    expect(read("packages/cli/tsup.config.ts")).not.toMatch(/dts\s*:\s*true/);
  });

  test("packages/client typechecks with the ROOT compiler, not its nested pin", () => {
    // The nested 6.x copy exists for tsup only. If the script were plain `tsc`
    // it would pick up `packages/client/node_modules/.bin/tsc` instead, and the
    // SDK's source would quietly stop being held to the compiler the rest of
    // the repo uses.
    const script = readPkg("packages/client").scripts?.typecheck;
    expect(script).toContain("../../node_modules/.bin/tsc");
  });

  test("no unexplained TypeScript versions are resolved", () => {
    // The only versions that may exist are the root's and the API pins'.
    // Anything else is a nested copy nobody asked for.
    const allowed = new Set(
      [ROOT, ...API_PINNED.map(([w]) => w)].map((w) => declaredTypescript(w) as string),
    );
    expect(resolvedVersions("typescript").filter((v) => !allowed.has(v))).toEqual([]);
  });

  test("the platform binaries CI needs are in the lockfile", () => {
    // 7.0's `tsc` is a native binary delivered as platform-specific optional
    // dependencies. A lockfile that carries only the dev machine's would leave
    // CI with no compiler at all under --frozen-lockfile, and the failure would
    // land at "tsc: not found" rather than anywhere near this change.
    for (const platform of ["linux-x64", "linux-arm64", "darwin-arm64"]) {
      expect(lockfile).toContain(`@typescript/typescript-${platform}@`);
    }
  });

  test("the guard reads resolutions, so a declaration alone cannot satisfy it", () => {
    // Guards the guard: if the lockfile format ever stops carrying
    // `typescript@x.y.z` entries, the assertions above would pass vacuously.
    expect(resolvedVersions("typescript").length).toBeGreaterThan(1);
  });
});
