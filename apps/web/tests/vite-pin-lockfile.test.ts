/**
 * Lockfile guard for the vite/rolldown pin.
 *
 * `vite` is held at exactly 8.0.13 because vite 8 bundles rolldown, and
 * rolldown >= 1.0.3 has an open deadlock on CPU-starved CI when a JS plugin's
 * transform hook calls a native NAPI addon (`@tailwindcss/vite` ->
 * `@tailwindcss/oxide`). It hangs with no error and the Cloudflare runner kills
 * the build at 31 minutes. See CLAUDE.md's conventions section.
 *
 * Declaring the pin is NOT enough, which is the whole reason this test exists:
 *
 *   - `apps/site/package.json` already named `vite: 8.0.13`, and astro still
 *     resolved its OWN nested `vite@8.2.1` (rolldown 1.2.4) straight past it.
 *     A direct dependency pin does not constrain a dependency's dependency.
 *   - The obvious repair — a scoped `resolutions` entry — does not work either.
 *     Bun prints `warn: Bun currently does not support nested "resolutions"`
 *     and ignores it. That warning only ever appeared in the CI build log, so
 *     locally the entry looked like it had worked.
 *   - A blanket `"vite"` resolution is not available as a fallback: `apps/docs`
 *     runs astro 6, which requires `vite ^7.3.2`, so forcing 8.x on everything
 *     is a major-version mismatch.
 *
 * What actually holds the pin today is the resolved lockfile, and CI installs
 * with `--frozen-lockfile`. That is a state rather than a declared constraint,
 * so it can drift back on any re-resolution. This test is the thing that
 * notices — it reads what `bun.lock` RESOLVED, not what a package.json asked
 * for, because those two disagreeing is the entire failure mode.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lockfile = readFileSync(
  fileURLToPath(new URL("../../../bun.lock", import.meta.url)),
  "utf8",
);

const PINNED_VITE = "8.0.13";
/** First rolldown that carries the deadlock; 8.0.13 resolves 1.0.1. */
const FIRST_BROKEN_ROLLDOWN = [1, 0, 3] as const;

const parts = (v: string): number[] => v.split(".").map((n) => Number(n));

const gte = (v: string, min: readonly number[]): boolean => {
  const a = parts(v);
  for (let i = 0; i < min.length; i++) {
    const seg = a[i] ?? 0;
    const bound = min[i] ?? 0;
    if (seg > bound) return true;
    if (seg < bound) return false;
  }
  return true;
};

/** Every distinct version the lockfile resolved for a package. */
const resolvedVersions = (pkg: string): string[] => {
  const re = new RegExp(`"${pkg}@(\\d+\\.\\d+\\.\\d+)"`, "g");
  return [...new Set([...lockfile.matchAll(re)].map((m) => m[1] as string))].sort();
};

describe("vite/rolldown lockfile pin", () => {
  test("every resolved vite 8.x is exactly the pinned version", () => {
    const eights = resolvedVersions("vite").filter((v) => v.startsWith("8."));
    // 7.x is legitimate — apps/docs runs astro 6, which requires vite ^7.3.2.
    expect(eights).toEqual([PINNED_VITE]);
  });

  test("no rolldown at or past the deadlocking version", () => {
    const broken = resolvedVersions("rolldown").filter((v) =>
      gte(v, FIRST_BROKEN_ROLLDOWN),
    );
    expect(broken).toEqual([]);
  });

  test("the guard reads resolutions, so it cannot be satisfied by a declaration alone", () => {
    // Guards the guard: if the lockfile format ever stops carrying `vite@x.y.z`
    // entries, both assertions above would pass vacuously on an empty list.
    expect(resolvedVersions("vite").length).toBeGreaterThan(0);
    expect(resolvedVersions("rolldown").length).toBeGreaterThan(0);
  });
});
