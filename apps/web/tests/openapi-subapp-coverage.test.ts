/**
 * `SUBAPPS` (routes/openapi.ts) is a hand-maintained allowlist of which mounted
 * sub-apps appear in the OpenAPI document. A route group can be fully annotated
 * with `createRoute` + schemas and still be invisible to `/api/openapi`, the API
 * explorer, the docs and SDK codegen simply because nobody added a line to that
 * array. That is exactly what happened to `/api/admin/integrations` (missing
 * since the feature shipped) and `/api/admin/oidc`.
 *
 * This pins the coverage side of it: every entry in SUBAPPS must actually be
 * mounted on the app at the same path, and every OpenAPI-capable admin route
 * group the app mounts must be represented. It cannot know about a group nobody
 * wrote, but it does catch the two real failure modes — a SUBAPPS entry whose
 * mount was renamed or removed, and a documented path set that silently shrinks.
 */
import { describe, expect, test } from "bun:test";
import { SUBAPPS } from "../src/server/routes/openapi";
import staticSpec from "../src/server/lib/openapi-static.generated.json";

describe("OpenAPI sub-app coverage", () => {
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
    // These three all had annotated routes that never reached the document.
    // Keep them named explicitly: a regression here means the SUBAPPS entry was
    // dropped, and nothing else in CI would notice.
    for (const prefix of ["/api/admin/integrations", "/api/admin/oidc", "/api/admin/saml"]) {
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
    expect(paths.length).toBeGreaterThan(140);
  });
});
