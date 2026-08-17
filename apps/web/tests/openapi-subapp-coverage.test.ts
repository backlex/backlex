/**
 * `SUBAPPS` (routes/openapi.ts) is a hand-maintained allowlist of which mounted
 * sub-apps appear in the OpenAPI document. A route group can be fully annotated
 * with `createRoute` + schemas and still be invisible to `/api/openapi`, the API
 * explorer, the docs and SDK codegen simply because nobody added a line to that
 * array.
 *
 * This file used to say, in its own header, that it "cannot know about a group
 * nobody wrote" — and that sentence turned out to be the whole problem. When
 * the set was finally derived from `app.ts` rather than read off `SUBAPPS`,
 * **27 groups were missing**: `/api/messaging`, `/api/jobs`, `/api/extensions`,
 * `/api/admin/dashboards`, `/api/admin/kpis`, `/api/admin/usage`,
 * `/api/flags`, `/api/device-tokens`, `/api/phone-numbers` and eighteen more,
 * every one of them annotated and none of them published. Adding them took the
 * static spec from 271 documented paths to 346.
 *
 * So the derivation IS the test now. Every mount in `app.ts` whose route module
 * builds an `OpenAPIHono` must be in `SUBAPPS`, or in `UNDOCUMENTED` with a
 * reason — the same shape `sdk-surfaces.test.ts` uses for a surface that
 * deliberately has no client.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SUBAPPS } from "../src/server/routes/openapi";
import staticSpec from "../src/server/lib/openapi-static.generated.json";

const SERVER = join(import.meta.dir, "..", "src", "server");
const read = (p: string) => readFileSync(p, "utf8");

/**
 * Mounts declared in `app.ts` that resolve to an OpenAPI-capable route module.
 *
 * Source-scanned rather than imported: importing every route module to read its
 * `openAPIRegistry` would build half the server inside a unit test, and the
 * question here is a spelling one — is there a line in `SUBAPPS` — not a
 * runtime one.
 */
const openApiCapableMounts = (): Map<string, string> => {
  const app = read(join(SERVER, "app.ts"));
  const bySymbol = new Map<string, string>();
  for (const m of app.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/routes\/[^"]+)"/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name) bySymbol.set(name, m[2]!.replace("./routes/", ""));
    }
  }
  const out = new Map<string, string>();
  for (const m of app.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*(\w+)/g)) {
    const [, mount, ident] = m as unknown as [string, string, string];
    const file = bySymbol.get(ident);
    if (!file) continue; // built inline, or imported from outside routes/
    const path = join(SERVER, "routes", `${file}.ts`);
    if (!existsSync(path)) continue;
    if (!/new OpenAPIHono/.test(read(path))) continue;
    out.set(mount, ident);
  }
  return out;
};

/**
 * Annotated groups deliberately left out of the published document. Each needs
 * a real reason: "not yet" is a reason to add the line, not to write an entry.
 */
const UNDOCUMENTED: Record<string, string> = {};

describe("OpenAPI sub-app coverage", () => {
  const capable = openApiCapableMounts();
  const documented = new Set(SUBAPPS.map(([m]) => m));

  test("the derivation finds the app — a scan that matches nothing would pass everything", () => {
    // Every assertion below is vacuous if the regexes stop matching (a
    // refactor to `app.route(...)` spread over lines, an import style change).
    // This is the tripwire for that.
    expect(capable.size).toBeGreaterThan(50);
  });

  test("every OpenAPI-capable mount is documented, or says why not", () => {
    const missing = [...capable.keys()].filter((m) => !documented.has(m) && !UNDOCUMENTED[m]);
    expect(missing.sort()).toEqual([]);
  });

  test("an `UNDOCUMENTED` entry has real reasoning and is still needed", () => {
    for (const [mount, why] of Object.entries(UNDOCUMENTED)) {
      // Still mounted and still capable — an exclusion for a group that was
      // deleted or converted to a plain Hono is a stale excuse.
      expect(`${mount}: capable=${capable.has(mount)}`).toBe(`${mount}: capable=true`);
      // And not in SUBAPPS, or the entry contradicts itself.
      expect(`${mount}: documented=${documented.has(mount)}`).toBe(`${mount}: documented=false`);
      expect(why.length).toBeGreaterThan(80);
    }
  });

  test("every SUBAPPS entry is mounted at the path it claims", () => {
    // The other direction: an entry whose mount was renamed contributes
    // nothing and looks like coverage. `/api/collections` and
    // `/api/admin/adopt` are mounted too — they just have no registry.
    const app = read(join(SERVER, "app.ts"));
    for (const [mount] of SUBAPPS) {
      expect(`${mount}: mounted=${app.includes(`"${mount}"`)}`).toBe(`${mount}: mounted=true`);
    }
  });

  test("only the two known groups lack an openAPIRegistry", () => {
    // A sub-app without a registry contributes nothing — the generator logs
    // "skipping" and moves on. Two do this on purpose: their paths come from
    // dedicated `collections.openapi.ts` / `adopt.openapi.ts` modules instead.
    // Pinning the set exactly means a NEW group that quietly turns out to be a
    // plain Hono (and therefore documents nothing) fails here instead of just
    // printing a line nobody reads.
    const EXPECTED_SKIPS = ["/api/admin/adopt", "/api/collections"];
    const skipped = SUBAPPS.filter(
      ([, app]) => (app as { openAPIRegistry?: unknown }).openAPIRegistry === undefined,
    ).map(([mount]) => mount);
    expect(skipped.sort()).toEqual(EXPECTED_SKIPS);
  });

  test("SUBAPPS mounts are unique", () => {
    const mounts = SUBAPPS.map(([m]) => m);
    expect(new Set(mounts).size).toBe(mounts.length);
  });

  test("the generated spec covers the route groups most easily forgotten", () => {
    const paths = Object.keys((staticSpec as { paths: Record<string, unknown> }).paths);
    // These all had annotated routes that never reached the document. Keep
    // them named explicitly: a regression means the SUBAPPS entry was dropped,
    // and the derivation above would catch it only if `app.ts` still mounts it.
    for (const prefix of [
      "/api/admin/integrations",
      "/api/admin/oidc",
      "/api/admin/saml",
      "/api/messaging",
      "/api/jobs",
      "/api/phone-numbers",
      "/api/admin/dashboards",
    ]) {
      expect(
        paths.some((p) => p.startsWith(prefix)),
        `${prefix} has no documented paths — check its SUBAPPS entry`,
      ).toBe(true);
    }
  });

  test("the generated spec is not truncated", () => {
    const paths = Object.keys((staticSpec as { paths: Record<string, unknown> }).paths);
    // A generation run that half-failed used to write a valid-looking but tiny
    // document. Anything far below the current count means regeneration broke.
    expect(paths.length).toBeGreaterThan(300);
  });
});
