/**
 * Lockfile guard: the vite a workspace DECLARES must be the vite it RESOLVES.
 *
 * This started life pinning vite to exactly 8.0.13, on the belief that rolldown
 * >= 1.0.3 deadlocked the Cloudflare build. That attribution turned out to be
 * wrong — measured 2026-08-15 on the playground trigger, vite 8.2.1 with
 * rolldown 1.2.4 went 7/7 green on Node and 6/6 green under `bunx --bun`, 13
 * runs with no hang. What every original hang actually shared was a build that
 * first spent ~15 minutes replaying 120 migrations; the rolldown deadlock is
 * CPU-starvation sensitive and that load is what starved it. Fixing the
 * migration ledger removed the trigger, and the version pin came off.
 *
 * The guard stayed, because the failure it caught is a different and very real
 * one: **a declared pin does not constrain a transitive copy.**
 *
 *   - `apps/site/package.json` named `vite: 8.0.13` for weeks while astro
 *     quietly resolved its OWN nested `vite@8.2.1` right past it.
 *   - Neither repair that looks obvious is needed here any more, and both were
 *     described wrongly. A scoped `resolutions` entry DOES work in Bun 1.4 when
 *     written with a slash (`"parent/child": "1.2.3"`); the repo ships two. And
 *     a blanket `"vite"` entry is no longer blocked by `apps/docs`, which moved
 *     from astro 6 to astro 7 — there is no 7.x vite left in the tree at all.
 *
 * So the assertions read what `bun.lock` RESOLVED and compare it against what
 * package.json DECLARES, because those two disagreeing silently is the entire
 * failure mode. No version is hardcoded here — a deliberate bump passes, a
 * silent divergence does not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const lockfile = read("../../../bun.lock");

/** What apps/web asks for — the workspace whose bundle the CF build compiles. */
const declaredVite = (): string => {
  const pkg = JSON.parse(read("../package.json")) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const v = pkg.devDependencies?.vite ?? pkg.dependencies?.vite;
  if (!v) throw new Error("apps/web declares no vite");
  return v;
};

/** Every distinct version the lockfile resolved for a package. */
const resolvedVersions = (pkg: string): string[] => {
  const re = new RegExp(`"${pkg}@(\\d+\\.\\d+\\.\\d+)"`, "g");
  return [...new Set([...lockfile.matchAll(re)].map((m) => m[1] as string))].sort();
};

describe("vite lockfile resolution", () => {
  test("apps/web declares an exact version, not a range", () => {
    // A range is how a transitive copy drifts upward unnoticed; the whole guard
    // rests on the declaration being a single answerable value.
    expect(declaredVite()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("every resolved vite 8.x is the version apps/web declares", () => {
    const eights = resolvedVersions("vite").filter((v) => v.startsWith("8."));
    // Filtered to 8.x because a legitimate 7.x used to coexist (astro 6 in
    // `apps/docs` required `vite ^7.3.2`). That is over — both Astro workspaces
    // run astro 7 now — so the filter is belt-and-braces, and the next test
    // asserts the stronger property: the tree holds exactly one vite, full stop.
    expect(eights).toEqual([declaredVite()]);
  });

  test("the whole tree resolves exactly one vite", () => {
    // Stronger than the 8.x check above, and the assertion that would have
    // caught `apps/site` sitting on its own astro (and so its own Astro-internal
    // toolchain) while `apps/docs` had moved on.
    expect(resolvedVersions("vite")).toEqual([declaredVite()]);
  });

  test("rolldown resolves to a single version", () => {
    // vite bundles rolldown, so two vite 8.x copies show up here as two
    // rolldowns. This is the same divergence seen from the other side, and it
    // is what having astro on its own nested vite looked like in the lockfile.
    expect(resolvedVersions("rolldown")).toHaveLength(1);
  });

  test("the guard reads resolutions, so a declaration alone cannot satisfy it", () => {
    // Guards the guard: if the lockfile format ever stops carrying
    // `vite@x.y.z` entries, the assertions above would pass vacuously.
    expect(resolvedVersions("vite").length).toBeGreaterThan(0);
    expect(resolvedVersions("rolldown").length).toBeGreaterThan(0);
  });
});
