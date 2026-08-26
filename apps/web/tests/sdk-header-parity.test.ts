/**
 * Every client must send the same request headers.
 *
 * They did not. On 2026-08-26 the TypeScript client sent `X-Backlex-Org` and
 * `traceparent`; **none** of the ten native SDKs did — organizations and
 * tracing both landed after those SDKs were published, and nothing noticed
 * because `test.yml` does not build `sdks/` at all. The only workflow that
 * touches them, `publish-sdks.yml`, has never run. So ten clients drifted for
 * two months with no signal of any kind.
 *
 * Read the other way round, the same gap ran in reverse: all ten natives sent
 * `Origin`, and the TypeScript *reference* client was the only one that did
 * not — which is why every server-side `auth.*` call through it 403'd.
 *
 * This is a source-level check on purpose. It needs no toolchain, so it runs in
 * the main suite on every push rather than in a release workflow nobody
 * triggers, and it fails on the PR that adds a header to one client and forgets
 * the other ten.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const SDKS = join(ROOT, "sdks");

/** Directories that hold build output or vendored deps, not our source. */
const SKIP = new Set([
  ".venv", "node_modules", "build", ".gradle", "target", "vendor",
  "bin", "obj", ".dart_tool", ".build", "examples", "test", "tests", "TestRunner",
]);

const SOURCE_EXT = /\.(py|go|rs|rb|php|dart|swift|cs|java|kt)$/;

const readSources = (dir: string): string => {
  let out = "";
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out += readSources(full);
    else if (SOURCE_EXT.test(entry)) out += readFileSync(full, "utf8");
  }
  return out;
};

/**
 * The wire contract every client owes. Not derived from the TS source: a
 * regex over one client's header-building code is exactly the kind of check
 * that passes for the wrong reason, and the point here is the *agreement*
 * between eleven implementations, which has to be stated somewhere.
 */
const REQUIRED = [
  { header: "Authorization", why: "the key or session token" },
  { header: "X-Backlex-Tenant", why: "explicit tenant scoping" },
  { header: "X-Backlex-Org", why: "so $org.id in permission rules resolves" },
  { header: "traceparent", why: "so the call appears in the admin Traces panel" },
];

const LANGS = ["python", "go", "rust", "ruby", "php", "dart", "swift", "dotnet", "java", "kotlin"];

describe("SDK header parity", () => {
  const sources = new Map(LANGS.map((l) => [l, readSources(join(SDKS, l))]));

  test("the ten native SDKs are all present and readable", () => {
    // A path typo would empty every source string and pass every check below.
    for (const [lang, src] of sources) {
      expect(src.length, `${lang} source looks empty — did the layout move?`).toBeGreaterThan(2000);
    }
  });

  for (const { header, why } of REQUIRED) {
    test(`every client sends ${header} — ${why}`, () => {
      const missing = LANGS.filter((l) => !(sources.get(l) ?? "").toLowerCase().includes(header.toLowerCase()));
      expect(
        missing,
        `${header} is missing from: ${missing.join(", ")}. Every client wraps the same wire ` +
          "surface, so a header added to one is owed by all eleven — see docs/client-sdks.md.",
      ).toEqual([]);
    });
  }

  test("the TypeScript reference client sends them too", () => {
    // It is the client the others are ported from, and it is not exempt: it was
    // the one that shipped without `Origin` while all ten natives had it.
    const ts = readFileSync(join(ROOT, "packages/client/src/index.ts"), "utf8").toLowerCase();
    const missing = REQUIRED.map((r) => r.header).filter((h) => !ts.includes(h.toLowerCase()));
    expect(missing).toEqual([]);
  });

  test("traceparent is built to the W3C shape in every client", () => {
    // A client that sends the header but invents its own format is worse than
    // one that sends nothing: the server parses it, and a malformed value ends
    // up as a trace nobody can follow.
    for (const lang of LANGS) {
      const src = sources.get(lang) ?? "";
      expect(src.includes('"00-') || src.includes("'00-") || src.includes("00-$"), `${lang} does not build a 00- prefixed traceparent`).toBe(true);
    }
  });
});
