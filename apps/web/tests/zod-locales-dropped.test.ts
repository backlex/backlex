/**
 * zod's locale table must stay out of the worker bundle.
 *
 * `zod/v4/classic/external.js` ends with `export * as locales from
 * "../locales/index.js"`. An `export * as` builds a namespace object, so every
 * one of the 63 locale modules is reachable and no bundler can drop them.
 * Measured with `bun build --minify`: the zod barrel is 282,733 B, of which
 * 152,209 B is that namespace. In the real worker build removing it takes the
 * eager `vendor` chunk from 884 KB to 676 KB — 208 KB off the graph Cloudflare
 * compiles at every cold start, which is the budget behind error 10021.
 *
 * `worker-startup-budget.test.ts` cannot see this: it walks SOURCE, and says so
 * itself — "blind to what the bundler does with the graph afterwards". This is
 * that half.
 *
 * The failure mode being guarded is not "the plugin is gone". It is **the
 * plugin still being there and matching nothing**, after zod moves the file or
 * changes the import. A `resolveId` that matches nothing is silent: the bundle
 * quietly grows 208 KB and every test still passes. So the assertions below
 * check the shape in the INSTALLED zod, not just our own wiring.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const require_ = createRequire(import.meta.url);

/** The installed zod's barrel — resolved through the package rather than a
 *  guessed path, so a hoisting change does not read as a zod change. */
const zodBarrel = (): { path: string; src: string } => {
  const pkg = require_.resolve("zod/package.json");
  const path = resolve(dirname(pkg), "v4/classic/external.js");
  return { path, src: existsSync(path) ? readFileSync(path, "utf8") : "" };
};

describe("zod locales stay out of the bundle", () => {
  test("the import the plugin targets still exists in the installed zod", () => {
    // If this fails, zod restructured. The plugin is then matching nothing and
    // the locales are silently back — re-derive the path before trusting it.
    const { path, src } = zodBarrel();
    expect(`${path} exists: ${src.length > 0}`).toBe(`${path} exists: true`);
    expect(src).toContain('export * as locales from "../locales/index.js"');
  });

  test("English messages come from a SEPARATE import, so dropping the namespace keeps them", () => {
    // The whole change rests on this: `en` is its own line and is not part of
    // the namespace being removed.
    const { src } = zodBarrel();
    expect(src).toContain('import en from "../locales/en.js"');
  });

  test("the plugin is wired into the worker build", () => {
    const cfg = readFileSync(join(ROOT, "apps/web/vite.config.ts"), "utf8");
    expect(cfg).toContain("backlex:drop-zod-locales");
    // Present in the plugin ARRAY, not merely defined above it.
    expect(cfg).toMatch(/plugins:\s*\[\s*\n\s*dropZodLocales\(\),/);
  });

  test("the shim exports nothing, so `z.locales` is empty rather than half-populated", () => {
    // A partially filled namespace would be worse than an empty one: the
    // missing language would read as a zod bug rather than a deliberate cut.
    const shim = readFileSync(
      join(ROOT, "apps/web/src/server/shims/zod-locales-shim.ts"),
      "utf8",
    );
    expect(shim).toContain("export {}");
    expect(shim).not.toMatch(/export\s+(const|function|default)\s/);
  });

  test("nothing in this repo asks for a locale", () => {
    // The premise of the cut. If a caller appears, the plugin has to go before
    // the caller can work — and it should fail here rather than at runtime with
    // an empty object.
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of require_("node:fs").readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !p.includes("zod-locales")) {
          const src = readFileSync(p, "utf8");
          if (/\bz\.locales\b|from ["']zod\/(v4\/)?locales/.test(src)) hits.push(p);
        }
      }
    };
    walk(join(ROOT, "apps/web/src"));
    walk(join(ROOT, "packages"));
    expect(hits).toEqual([]);
  });
});
