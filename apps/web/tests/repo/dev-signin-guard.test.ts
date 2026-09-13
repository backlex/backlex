/**
 * The sign-in pre-fill must not survive a build.
 *
 * `src/client/lib/dev-signin.ts` exists so nobody retypes the local admin's
 * credentials every session. What makes that acceptable rather than reckless is
 * one expression — `import.meta.env.DEV`, which Vite replaces with the literal
 * `false` in every build, so the branch and its strings are dropped. Delete
 * that expression and the same file becomes a production admin bundle that
 * offers credentials to whoever opens the login page, with no type error, no
 * lint error, and a sign-in screen that looks completely normal in dev.
 *
 * A source scan rather than a behavioural test, for the same reason
 * `examples-shape.test.ts` is one: the thing being prevented is an edit, and no
 * runtime assertion ever sees an edit. The build-output check that would be
 * stronger costs a full `vite build`, which this suite cannot afford per-run —
 * it belongs to `bun run build`, which CI runs anyway.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLIENT = join(ROOT, "src", "client");
const GATE = join(CLIENT, "lib", "dev-signin.ts");
const EXAMPLES_ENV = join(ROOT, "..", "..", "examples", "shared", "src", "env.ts");

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((entry) => {
    const full = join(d, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const clientSources = (): { path: string; src: string }[] =>
  walk(CLIENT)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((path) => ({ path: path.slice(ROOT.length + 1), src: readFileSync(path, "utf8") }));

describe("sign-in pre-fill stays out of every build", () => {
  // Without this, every assertion below passes by matching nothing — which is
  // exactly how a guard reports success while guarding an empty set.
  test("sanity: the scan found the gate and the client tree", () => {
    expect(`gate exists: ${existsSync(GATE)}`).toBe("gate exists: true");
    expect(clientSources().length).toBeGreaterThan(50);
  });

  test("the admin's dev credentials are behind import.meta.env.DEV", () => {
    const src = readFileSync(GATE, "utf8");
    // The gate must be the FIRST operand: `A && import.meta.env.DEV` would also
    // contain the string, and would also be correct, but `import.meta.env.DEV &&`
    // is the form Vite can fold away without evaluating the rest.
    expect(src).toContain("import.meta.env.DEV &&");
  });

  test("nothing else in the admin reads the dev credentials", () => {
    const readers = clientSources()
      .filter((f) => /VITE_DEV_(EMAIL|PASSWORD)/.test(f.src))
      .map((f) => f.path)
      .sort();
    expect(readers).toEqual(["src/client/lib/dev-signin.ts"]);
  });

  test("no admin source carries a literal credential for the pre-fill", () => {
    // The values live in `.env.development.local` (gitignored, dev-mode only).
    // A hardcoded fallback would defeat both guards at once: it would survive
    // `import.meta.env.DEV` being wrong AND a clone that never opted in.
    const offenders = clientSources()
      .filter((f) => f.src.includes("correct-horse-battery"))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("an example pre-fills only when BOTH vars are set", () => {
    const src = readFileSync(EXAMPLES_ENV, "utf8");
    // Either var alone yields a half-filled form that fails to submit, which is
    // worse than an empty one — and `email ?? ""` would do exactly that.
    expect(src).toContain(
      "import.meta.env.VITE_DEMO_EMAIL && import.meta.env.VITE_DEMO_PASSWORD",
    );
  });
});
