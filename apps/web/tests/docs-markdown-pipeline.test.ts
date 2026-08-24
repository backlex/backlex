/**
 * Starlight's Markdown transforms actually reach the docs.
 *
 * The canonical docs live at the repo root in `docs/`, not in
 * `apps/docs/src/content/docs/`, and Starlight only runs its own Markdown
 * transforms on paths it has been told about: the `docs` collection directory,
 * plus whatever `starlight({ markdown: { processedDirs } })` names. Everything
 * else is skipped by `shouldTransformPath`.
 *
 * That skip is silent and the build stays green, which is how it went unnoticed
 * across the astro 7 / starlight 0.41 upgrade. Measured on the built site
 * before the fix: 16 `:::note` / `:::caution` blocks in the sources and **zero**
 * `starlight-aside` elements in 94 pages, **zero** `sl-anchor-link` heading
 * anchors, and **zero** `dir="auto"` on inline code. The directives were still
 * consumed by `remark-directive`, so the pages did not show a stray `:::` that
 * anyone would have spotted — the asides just rendered as bare, unstyled
 * `<div>`s. After the fix: 16 / 1260 / 10828.
 *
 * So the coupling this file guards is: **`processedDirs` must name the same
 * directory the content loader globs.** Change one without the other and three
 * transforms die quietly.
 *
 * ── Why a source scan and not a build assertion ───────────────────────────
 * Asserting on `apps/docs/dist` needs an astro build, which `bun test` does not
 * run and CI's `paths-ignore` skips for `apps/docs/**` anyway. This reads the
 * two config files that have to agree, offline — the same trade
 * `docs-links.test.ts` makes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const DOCS_APP = resolve(ROOT, "apps", "docs");

const read = (p: string) => readFileSync(p, "utf8");

const astroConfig = read(resolve(DOCS_APP, "astro.config.mjs"));
const contentConfig = read(resolve(DOCS_APP, "src", "content.config.ts"));

/** The `base:` the `docs` collection's `glob()` loader is pointed at. */
const loaderBase = (): string => {
  const m = /glob\(\{\s*base:\s*"([^"]+)"/.exec(contentConfig);
  if (!m?.[1]) throw new Error("could not read the docs collection glob base");
  return m[1];
};

/** The directories handed to `starlight({ markdown: { processedDirs } })`. */
const processedDirs = (): string[] => {
  const m = /processedDirs:\s*\[([^\]]*)\]/.exec(astroConfig);
  if (!m?.[1]) throw new Error("astro.config.mjs declares no markdown.processedDirs");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
};

describe("docs markdown pipeline", () => {
  test("the loader globs a directory outside the docs collection", () => {
    // The premise of the whole guard. If the docs ever move back under
    // `src/content/docs/`, Starlight covers them by default and this file can
    // go — but then it should be deleted deliberately, not left passing
    // vacuously.
    const base = resolve(DOCS_APP, loaderBase());
    expect(base).not.toBe(resolve(DOCS_APP, "src", "content", "docs"));
    expect(existsSync(base)).toBe(true);
  });

  test("processedDirs covers the directory the loader globs", () => {
    const base = resolve(DOCS_APP, loaderBase());
    const covered = processedDirs().map((d) => resolve(DOCS_APP, d));
    expect(covered).toContain(base);
  });

  test("the sources really do use directives, so the guard is not vacuous", () => {
    // A guard whose subject does not exist reports success. If nothing in the
    // docs uses `:::`, the coupling above is untested in practice and the two
    // configs could drift apart unnoticed until someone writes an aside.
    const base = resolve(DOCS_APP, loaderBase());
    const directives = readdirSync(base)
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) => read(resolve(base, f)).match(/^:::[a-z]+/gm) ?? []);
    expect(directives.length).toBeGreaterThan(0);
  });
});

describe("docs markdown processor dependencies", () => {
  const pkg = (ws: string) =>
    JSON.parse(read(resolve(ROOT, "apps", ws, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

  test("apps/docs declares @astrojs/markdown-remark itself", () => {
    // `markdown.rehypePlugins` in astro.config.mjs makes astro fall back from
    // its default Sätteri processor to the unified one, and Starlight's unified
    // integration is a lazy `import('@astrojs/markdown-remark')` that resolves
    // to `null` on failure. Both astro and Starlight list the package as an
    // OPTIONAL peer, so nothing forces it into the graph — today it is present
    // only because `@astrojs/mdx` happens to hard-depend on it, and `@astrojs/mdx`
    // is itself migrating to Sätteri. If it ever leaves the graph the transforms
    // stop running and the build still passes.
    expect(pkg("docs").dependencies?.["@astrojs/markdown-remark"]).toBeString();
  });

  test("markdown-remark matches astro exactly", () => {
    // astro declares the peer as an exact version (`"@astrojs/markdown-remark":
    // "7.2.4"`), not a range, so the two have to move together.
    const deps = pkg("docs").dependencies ?? {};
    expect(deps["@astrojs/markdown-remark"]).toBe(deps["astro"] as string);
  });

  test("both Astro workspaces run the same astro", () => {
    // They drifted (site 7.2.2, docs 7.2.4), which duplicated the whole Astro
    // toolchain — two `astro`, two `@astrojs/markdown-satteri`, two
    // `@astrojs/internal-helpers` — for no benefit.
    expect(pkg("site").dependencies?.astro).toBe(pkg("docs").dependencies?.astro as string);
  });
});
