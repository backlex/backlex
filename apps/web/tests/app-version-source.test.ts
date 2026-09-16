import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version an instance prints must come from the build, not from a constant
 * nobody bumps.
 *
 * Every auth page used to do `import { version } from "../../../package.json"`,
 * and `apps/web`'s version field has read `0.0.1` since the workspace existed —
 * the tenant runtime is released by `worker-v*` TAG, so npm-style version
 * bumps never happen here. Every deploy ever made therefore showed `v0.0.1` on
 * its sign-in card. The build-time `__APP_VERSION__` define is the honest
 * source; these two assertions keep the pages on it.
 */
const PAGES_DIR = join(import.meta.dir, "../src/client/pages");
const VITE_CONFIG = join(import.meta.dir, "../vite.config.ts");

describe("app version source", () => {
  it("no client page reads its version out of package.json", () => {
    const offenders = readdirSync(PAGES_DIR)
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .filter((f) => {
        const src = readFileSync(join(PAGES_DIR, f), "utf8");
        return /import\s*\{[^}]*\bversion\b[^}]*\}\s*from\s*"[^"]*package\.json"/.test(
          src,
        );
      });
    expect(offenders).toEqual([]);
  });

  /**
   * This repo tags five things off one history (`backlex-v*`, `cli-v*`,
   * `ui-v*`, `integrations-v*`, `worker-v*`). A bare `git describe --tags`
   * answers with whichever tag came last, which on 1037d0fc was
   * `integrations-v0.2.1-59-g…` — a version of something this bundle is not.
   * Without the match the define is dynamic and still wrong, which is the
   * harder bug to see.
   */
  it("__APP_VERSION__ describes the worker tag, not the newest tag", () => {
    const src = readFileSync(VITE_CONFIG, "utf8");
    const describeCall = src.match(/git\("describe[^"]*"/)?.[0];
    expect(describeCall).toBeDefined();
    expect(describeCall).toContain("--match 'worker-v*'");
  });

  /**
   * …and the match alone is not enough, which is the part only a DEPLOY
   * revealed: Cloudflare Workers Builds clones shallow and without tags, so
   * `describe` failed there and the live card read `vafaf468`.
   *
   * Proven against a real `git clone --depth=1 --no-tags` of this repo rather
   * than argued: the depth-1 tag fetch brings 131 refs and `describe` STILL
   * fails (`No tags can describe …`), because it walks history and a depth-1
   * clone has none. `git tag --list` only reads refs, so it answers. The
   * ladder resolved `v0.4.126+afaf468` there and the unchanged
   * `v0.4.126-230-g…` in a full checkout.
   *
   * That behavioural run is not re-run here — spinning a clone per suite is
   * not worth it — so this pins the two pieces it depends on. Drop either and
   * the CF build silently goes back to printing a bare sha, which looks like a
   * version and is not the one anybody asked for.
   */
  it("the version ladder survives a shallow, tagless checkout", () => {
    const src = readFileSync(VITE_CONFIG, "utf8");
    // Refs at depth 1 — the same command test.yml uses for the release guard.
    expect(src).toContain("+refs/tags/worker-v*:refs/tags/worker-v*");
    // The ref-only read `describe` cannot do.
    expect(src).toContain("tag --list 'worker-v*' --sort=-v:refname");
  });
});
