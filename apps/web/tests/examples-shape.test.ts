/**
 * The examples are a claim about how the product is used, so what they do NOT
 * contain is part of the claim.
 *
 * Four SPAs each carried a byte-identical `SetupCheck.tsx`, a near-identical
 * `env.ts`, an 86-line sign-in form differing by about four lines, and a
 * hand-rolled `persistToken()` that each screen had to remember to call. None
 * of that was wrong exactly — it was what the SDK made necessary, which is why
 * the fix was to change the SDK rather than to tidy the copies.
 *
 * This turns "we deleted them" into "they stay deleted". A source scan rather
 * than a behavioural test, because the failure being prevented is someone
 * adding a fifth example by copying the fourth — which no runtime assertion
 * would ever see. Same shape as `client/admin-ui-conventions.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "examples");

/** The SPA examples — the ones that share a session and a setup screen.
 *  `shared` is the package they share; `nextjs-app` and `react-router-app`
 *  are server-rendered and answer these questions differently. */
const SPAS = ["blog-react", "ecommerce-react", "showcase-react", "todo-react"];

const sourcesOf = (example: string): { path: string; src: string }[] => {
  const dir = join(EXAMPLES, example, "src");
  if (!existsSync(dir)) return [];
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((entry) => {
      const full = join(d, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return walk(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((path) => ({ path: path.slice(EXAMPLES.length + 1), src: readFileSync(path, "utf8") }));
};

describe("examples — the boilerplate stays gone", () => {
  test("sanity: the scan actually found the examples", () => {
    for (const spa of SPAS) {
      expect(`${spa}: ${sourcesOf(spa).length > 0}`).toBe(`${spa}: true`);
    }
    expect(sourcesOf("shared").length).toBeGreaterThan(0);
  });

  test("no example owns its own setup check", () => {
    for (const spa of SPAS) {
      expect(`${spa}/src/SetupCheck.tsx exists: ${existsSync(join(EXAMPLES, spa, "src", "SetupCheck.tsx"))}`).toBe(
        `${spa}/src/SetupCheck.tsx exists: false`,
      );
    }
  });

  test("no example hand-rolls token persistence", () => {
    // `persist: true` writes through `core.setToken`, which every capture path
    // already funnels into — so a helper here would be a second, partial
    // answer, and the half that gets forgotten is the sign-OUT.
    for (const spa of SPAS) {
      for (const { path, src } of sourcesOf(spa)) {
        expect(`${path}: ${src.includes("persistToken")}`).toBe(`${path}: false`);
        expect(`${path}: ${/localStorage\.(get|set|remove)Item\(\s*[`"']backlex/.test(src)}`).toBe(
          `${path}: false`,
        );
      }
    }
  });

  test("no example hand-rolls a session probe on boot", () => {
    // The `booting` flag plus a `getSession()` in a `useEffect` is what
    // `useSession()`'s `status: "unknown"` replaced. One of them being left
    // behind means an example disagrees with the others about what a session
    // is while it loads.
    for (const spa of SPAS) {
      for (const { path, src } of sourcesOf(spa)) {
        expect(`${path}: ${/setBooting|const \[booting/.test(src)}`).toBe(`${path}: false`);
      }
    }
  });

  test("every SPA reads the session through the hook", () => {
    for (const spa of SPAS) {
      const app = sourcesOf(spa).find((f) => f.path.endsWith("App.tsx"));
      expect(`${spa} has an App.tsx: ${Boolean(app)}`).toBe(`${spa} has an App.tsx: true`);
      expect(`${spa}: ${app!.src.includes("useSession(")}`).toBe(`${spa}: true`);
    }
  });

  test("every SPA gets its setup check and sign-in form from the shared package", () => {
    for (const spa of SPAS) {
      const app = sourcesOf(spa).find((f) => f.path.endsWith("App.tsx"))!;
      expect(`${spa}: ${app.src.includes("@backlex-examples/shared")}`).toBe(`${spa}: true`);
    }
  });

  test("nothing fetches an image into a blob to display it", () => {
    // `storage.url()` composes the URL directly, so the browser caches it,
    // lazy-loads it, and applies the transform. `createObjectURL` gives up all
    // three and leaks if the revoke is ever missed.
    for (const spa of SPAS) {
      for (const { path, src } of sourcesOf(spa)) {
        expect(`${path}: ${src.includes("createObjectURL")}`).toBe(`${path}: false`);
      }
    }
  });

  test("the shared package holds one copy of each shared piece", () => {
    const files = sourcesOf("shared").map((f) => f.path);
    for (const name of ["SetupCheck.tsx", "AuthForm.tsx", "env.ts"]) {
      expect(`shared has ${name}: ${files.some((f) => f.endsWith(name))}`).toBe(
        `shared has ${name}: true`,
      );
    }
  });

  test("the server-rendered examples are deliberately NOT converted", () => {
    // `nextjs-app` keeps its own `httpOnly` cookie and builds a client per
    // request. That is not boilerplate it failed to delete — a token in an
    // `httpOnly` cookie is unreachable from page script, which is strictly
    // better than anything a browser-side store can offer, and the SDK's
    // `cookieTokens` cannot set that flag because a cookie the page writes is
    // a cookie the page can read. Converting it would be a regression, so this
    // pins the reason rather than leaving the omission to look like an
    // oversight.
    const session = join(EXAMPLES, "nextjs-app", "lib", "session.ts");
    expect(existsSync(session)).toBe(true);
    const src = readFileSync(session, "utf8");
    expect(src).toContain("httpOnly: true");
  });
});
