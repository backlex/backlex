import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The SDK is one module per domain, and stays that way.
 *
 * `packages/client/src/index.ts` was 5586 lines — every shape and every
 * endpoint of twenty-eight domains in one file, with a single 1900-line
 * `createClient` closure at the bottom. Adding a `payments` method meant
 * editing the same file as adding a `booking` one, and the only thing keeping
 * a domain from reaching into another domain's internals was that nobody had.
 *
 * The shape now: `core.ts` owns the transport handle (`ClientCore`), each
 * `clients/<domain>.ts` owns one domain's types AND its `make<Domain>(core)`
 * factory, and `index.ts` builds the transport and assembles them.
 *
 * These three rules are what make that hold. Without the first, a new domain
 * gets inlined back into `index.ts` because that is where the neighbouring
 * declaration already is. Without the third, a domain module imports the
 * transport directly and stops being isolated — and it would still typecheck,
 * because the cycle is resolvable.
 */
describe("sdk — one module per domain", () => {
  const SRC = join(import.meta.dir, "../../../packages/client/src");
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const domains = readdirSync(join(SRC, "clients"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3));

  test("`index.ts` declares no domain client of its own", () => {
    // `BacklexClient` is the assembled surface and belongs here; anything else
    // named `…Client` is a domain that was written in the wrong file.
    const declared = [...index.matchAll(/^export interface (\w*Client)\b/gm)].map((m) => m[1]);
    expect(declared).toEqual(["BacklexClient"]);
  });

  test("every client on `BacklexClient` is built by a domain module", () => {
    const fields = [...index.matchAll(/^  (\w+): (\w+Client);$/gm)].map((m) => ({
      field: m[1]!,
      type: m[2]!,
    }));
    // Sanity: the assembled surface really is broad, so a regex that silently
    // stopped matching would fail here rather than pass with an empty list.
    expect(fields.length).toBeGreaterThanOrEqual(25);

    for (const { type } of fields) {
      const owner = domains.find((d) =>
        new RegExp(`^export interface ${type}\\b`, "m").test(
          readFileSync(join(SRC, "clients", `${d}.ts`), "utf8"),
        ),
      );
      expect(owner, `${type} is declared by no clients/*.ts`).toBeDefined();
      const factory = `make${owner!.replace(/(^|-)(.)/g, (_, __, c: string) => c.toUpperCase())}`;
      expect(index).toContain(`import { ${factory} } from "./clients/${owner}";`);
      expect(index).toMatch(new RegExp(`= ${factory}\\(core\\);`));
    }
  });

  for (const domain of domains) {
    test(`clients/${domain}.ts reaches the API only through its \`core\``, () => {
      const src = readFileSync(join(SRC, "clients", `${domain}.ts`), "utf8");
      // Importing the barrel would make the module depend on every other
      // domain, and re-introduce the coupling the split removed.
      expect(src).not.toMatch(/from "\.\.\/index"/);
      // The transport is `core.request` / `core.requestRaw` / `core.fetch`. A
      // bare `fetch(` here means the module built its own request and skipped
      // the auth, tenant, org and trace headers with it.
      expect(src).not.toMatch(/(?<![.\w])fetch\(/);
      expect(src).toMatch(new RegExp(`^export const make\\w+ = \\(core: ClientCore\\)`, "m"));
    });
  }
});
