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
   * This repo tags four packages off one history (`backlex-v*`, `cli-v*`,
   * `ui-v*`, `worker-v*`). A bare `git describe --tags` answers with whichever
   * tag came last, which on 1037d0fc was `integrations-v0.2.1-59-g…` — a
   * version of something this bundle is not. Without the match the define is
   * dynamic and still wrong, which is the harder bug to see.
   */
  it("__APP_VERSION__ describes the worker tag, not the newest tag", () => {
    const src = readFileSync(VITE_CONFIG, "utf8");
    const describeCall = src.match(/git\("describe[^"]*"/)?.[0];
    expect(describeCall).toBeDefined();
    expect(describeCall).toContain("--match 'worker-v*'");
  });
});
