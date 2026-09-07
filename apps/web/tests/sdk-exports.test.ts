/**
 * The SDK declares its subpaths in FOUR places, and a subpath missing from any
 * one of them is broken for that channel only — which is why this drifted
 * unnoticed.
 *
 *   packages/client/package.json  → the monorepo + the source-consumed contract
 *   packages/client/jsr.json      → the JSR publish (@backlex/backlex)
 *   packages/client/tsup.config.ts→ what actually gets built into dist/
 *   packages/client/scripts/npm-manifest.mjs → what npm consumers can import
 *
 * `./token` was in the first three and absent from the fourth. tsup happily
 * built `dist/token.js`, and `import { createTokenVerifier } from
 * "backlex/token"` — documented in docs/auth-planes.md — failed for every npm
 * install while working in the repo and on JSR. Nothing tested it, because
 * every test imports the SDK by source path.
 *
 * Also guards the `"//comment"` hazard: a comment-shaped key anywhere in an
 * `exports` map makes Node reject the WHOLE map, taking every subpath down —
 * not just the commented one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT = join(import.meta.dir, "..", "..", "..", "packages", "client");
const read = (rel: string) => readFileSync(join(CLIENT, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;

const keysOf = (exportsMap: unknown): string[] =>
  Object.keys(exportsMap as Record<string, unknown>).sort();

/** tsup entry keys are bare names (`index`, `token`); the export maps use
 *  subpath form (`.`, `./token`). Normalize to subpath form to compare. */
const tsupSubpaths = (): string[] => {
  const src = read("tsup.config.ts");
  const open = src.indexOf("entry: {");
  // Start INSIDE the block — otherwise the `entry:` key matches its own regex.
  const block = src.slice(open + "entry: {".length, src.indexOf("}", open));
  const names = [...block.matchAll(/^\s*([A-Za-z_][\w-]*)\s*:/gm)].map((m) => m[1]!);
  return names.map((n) => (n === "index" ? "." : `./${n}`)).sort();
};

/** The `pkg.exports = { … }` literal the npm publish script installs. */
const npmManifestSubpaths = (): string[] => {
  const src = read("scripts/npm-manifest.mjs");
  const block = src.slice(src.indexOf("pkg.exports = {"), src.indexOf("};", src.indexOf("pkg.exports = {")));
  return [...block.matchAll(/"(\.[^"]*)"\s*:/g)].map((m) => m[1]!).sort();
};

describe("SDK export maps agree across all four declarations", () => {
  const pkg = keysOf(json("package.json").exports);

  test("package.json and jsr.json declare the same subpaths", () => {
    expect(keysOf(json("jsr.json").exports)).toEqual(pkg);
  });

  /**
   * The two publish channels must agree on the NUMBER, not just the subpaths.
   *
   * `bunx jsr publish` reads `jsr.json`'s version verbatim; the npm publish
   * reads `package.json`'s. Nothing connected them, and they drifted: on
   * 2026-09-07 npm was at 0.4.1 while `jsr.json` still said 0.3.3.
   *
   * The failure mode is the reason this is a test and not a note. JSR does not
   * error on a version it already has — it prints
   * `Warning: Skipping, already published @backlex/backlex@0.3.3` and **exits
   * 0**. So the `backlex-v0.4.0` and `backlex-v0.4.1` tags each ran this
   * workflow, each re-published 0.3.3, each was skipped, and each reported
   * GREEN. Two releases never reached JSR and the pipeline said they had.
   *
   * A version bump is a deliberate act, so pinning equality costs nothing:
   * whoever bumps one is told to bump the other, in the same commit, before it
   * can ship half a release.
   */
  test("package.json and jsr.json publish the same version", () => {
    const npm = json("package.json").version;
    const jsr = json("jsr.json").version;
    expect(typeof npm, "package.json has no version").toBe("string");
    expect(
      jsr,
      "jsr.json's version is what `jsr publish` uses. When it lags, JSR skips " +
        "the publish with a WARNING and exits 0 — the release silently does not " +
        "happen and the workflow stays green.",
    ).toBe(npm);
  });

  test("tsup builds an entry for every declared subpath", () => {
    // A subpath with no entry ships a package.json pointing at a file that was
    // never emitted.
    expect(tsupSubpaths()).toEqual(pkg);
  });

  test("the npm manifest exposes every declared subpath", () => {
    // The one that was actually wrong: `./token` built, declared, and
    // unreachable for npm consumers.
    expect(npmManifestSubpaths()).toEqual(pkg);
  });

  test("`backlex/token` specifically resolves on npm", () => {
    // Named on its own because it is documented in docs/auth-planes.md and was
    // the live break; a regression here is a broken public import, not a
    // cosmetic mismatch.
    expect(npmManifestSubpaths()).toContain("./token");
  });

  test("no export key is comment-shaped", () => {
    // A `"//…"` key does not annotate the map — it invalidates it, and every
    // subpath stops resolving with it.
    for (const [label, keys] of [
      ["package.json", pkg],
      ["jsr.json", keysOf(json("jsr.json").exports)],
      ["npm-manifest.mjs", npmManifestSubpaths()],
    ] as const) {
      for (const k of keys) {
        expect(`${label}:${k}`).not.toContain("//");
      }
    }
  });
});
