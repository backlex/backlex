/**
 * Every mounted `/api` route declares which auth plane it belongs to.
 *
 * This spec asserts the declarations are COMPLETE — not that they are right,
 * and not that they are obeyed. Completeness is what makes the enforcement real
 * rather than decorative. `middleware/plane-firewall.ts` does enforce the table
 * (`PLANE_GUARD` defaults to `enforce`), but an UNKNOWN path is admitted in
 * BOTH modes, deliberately: a typo in the registry must not take the site down.
 * So a mount nobody declared is a hole in an ENFORCING guard that raises no 403
 * and writes no log line to find it by. There is nothing to notice — which is
 * the property that decays silently: a new route file gets mounted, nobody
 * thinks about the plane, and the boundary quietly acquires another hole.
 *
 * The per-route gates (`requirePlatformMw`) stay as the second, narrow layer;
 * the firewall's own docblock argues why two layers are deliberate. This file
 * guards only the broad one.
 *
 * The registry is built from the real app, not from a hand-written list of
 * paths, so it cannot drift from what is actually served.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, type TestHarness } from "./setup";
import { ROUTE_PLANES, planeFor, type RoutePlane } from "../src/server/lib/route-planes";
import { requirePermission } from "../src/server/middleware/permission";

/** Paths served by the app that are deliberately outside the /api surface. */
const NON_API = (path: string): boolean =>
  path === "/health" ||
  path === "/health/ready" ||
  path.startsWith("/embed") ||
  path.startsWith("/f/") ||
  path.startsWith("/b/") ||
  path.startsWith("/book/") ||
  path === "/*" ||
  path === "/";

describe("route-plane registry: every /api mount declares a plane", () => {
  let h: TestHarness;
  let paths: string[];

  beforeAll(() => {
    h = makeHarness();
    // Hono records one entry per registered handler, including the `use("*")`
    // middleware chain. Middleware entries are the bare wildcards, and a
    // route's own path is what we care about.
    const seen = new Set<string>();
    for (const r of (h.app as unknown as { routes: { path: string }[] }).routes) {
      if (r.path === "*" || r.path === "/*") continue;
      seen.add(r.path);
    }
    paths = [...seen].sort();
  });

  afterAll(() => h.cleanup());

  test("the app actually registered routes (a vacuous pass would look identical)", () => {
    // Without this, every assertion below is trivially true over an empty list
    // — the repo's own documented failure mode, where a matcher that matches
    // nothing reports success.
    expect(paths.length).toBeGreaterThan(200);
    expect(paths.some((p) => p.startsWith("/api/tenants"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/api/t/"))).toBe(true);
  });

  test("no /api route falls through to the catch-all entry unannounced", () => {
    // `/api` is the last-resort entry (openapiRoutes). A route that resolves to
    // it without BEING it means somebody mounted a new prefix and never said
    // which plane it serves — the exact drift this file exists to catch.
    const orphans = paths.filter((p) => {
      if (NON_API(p)) return false;
      if (!p.startsWith("/api") && !p.startsWith("/.well-known") && !p.startsWith("/mcp") && !p.startsWith("/s3")) {
        return false;
      }
      const entry = planeFor(p);
      if (!entry) return true;
      if (entry.prefix !== "/api") return false;
      // Genuinely served by openapiRoutes — a short path directly under /api.
      return p.split("/").filter(Boolean).length > 2;
    });

    expect(
      orphans,
      `these paths have no plane declaration — add them to apps/web/src/server/lib/route-planes.ts:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });

  test("every declared prefix is actually mounted (the registry has no fiction in it)", () => {
    // The reverse direction. A prefix that names nothing is a dead declaration
    // that will read as coverage forever.
    // Mirrors `planeFor`'s segment matching, wildcard included — a literal
    // `startsWith` would report `/api/t/*/auth` dead even though it covers a
    // dozen live routes.
    const covers = (prefix: string, path: string): boolean => {
      const pp = prefix.split("/");
      const sp = path.split("/");
      if (sp.length < pp.length) return false;
      return pp.every((seg, i) => (seg === "*" ? Boolean(sp[i]) : seg === sp[i]));
    };
    const dead = ROUTE_PLANES.filter((entry) => {
      if (entry.prefix === "/api") return false; // the fallback, always "live"
      return !paths.some((p) => covers(entry.prefix, p));
    }).map((e) => e.prefix);

    expect(dead, `declared but never mounted:\n${dead.join("\n")}`).toEqual([]);
  });

  test("the control-plane surfaces this audit turns on are declared platform", () => {
    const mustBePlatform = [
      "/api/tenants",
      "/api/api-keys",
      "/api/users",
      "/api/roles",
      "/api/permissions",
      "/api/activity",
      "/api/admin/settings",
      "/api/app-users",
      "/api/app-orgs",
    ];
    for (const p of mustBePlatform) {
      expect(planeFor(p)?.plane, `${p} must be declared platform`).toBe("platform" satisfies RoutePlane);
    }
  });

  test("the end-user surface is declared app, except its own sign-in, which is public", () => {
    // The split the warn window found. Everything under `/api/t` needs an
    // app-plane session EXCEPT the surface where one is acquired: sign-up,
    // sign-in, SAML ACS, magic link, invite accept. Nobody there has a session
    // yet, and their browser may be holding a platform cookie from the
    // dashboard on the same origin.
    expect(planeFor("/api/t/default/orgs")?.plane).toBe("app");
    expect(planeFor("/api/t/default/agents")?.plane).toBe("app");
    expect(planeFor("/api/t/default/auth/sign-in/email")?.plane).toBe("public");
    expect(planeFor("/api/t/default/auth/invite/accept")?.plane).toBe("public");
    // The wildcard stands for exactly one segment, so it cannot swallow the
    // slug AND the subpath: `/api/t/auth` (no slug) is not the auth surface.
    expect(planeFor("/api/t/auth")?.prefix).toBe("/api/t");
  });

  test("a lookalike prefix does not inherit a neighbour's plane", () => {
    // `/api/webhook` (inbound, public) and `/api/webhooks` (outbound registry)
    // differ by one character and by their whole threat model.
    expect(planeFor("/api/webhook/abc")?.prefix).toBe("/api/webhook");
    expect(planeFor("/api/webhooks")?.prefix).toBe("/api/webhooks");
    // Segment-boundary matching, not raw startsWith.
    expect(planeFor("/api/tenants-lookalike")?.prefix).not.toBe("/api/tenants");
  });

  test("every `either` that is only `either` by omission says what has to be decided", () => {
    // `either` is the escape hatch. One granted without a reason is how a
    // table like this stops meaning anything.
    const unexplained = ROUTE_PLANES.filter(
      (e) => e.plane === "either" && !e.note && !e.revisit,
    ).map((e) => e.prefix);
    expect(unexplained, `\`either\` with no justification:\n${unexplained.join("\n")}`).toEqual([]);
  });

  test("no prefix is declared twice", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of ROUTE_PLANES) {
      if (seen.has(e.prefix)) dupes.push(e.prefix);
      seen.add(e.prefix);
    }
    expect(dupes).toEqual([]);
  });
});

/**
 * A gate the route table cannot see is a gate no audit can count.
 *
 * Hono records every registered handler in `app.routes`, and the only thing it
 * carries about one is the function's NAME. `requireUser`, `requireAdmin` and
 * `requirePlatformMw` are plain top-level consts and show up by name;
 * `requirePermission` is a FACTORY, and the handler it returned used to be
 * anonymous — so the most-applied authorization gate in the product read as
 * `(anonymous)`, and every `/api/items/*` route looked ungated to anything
 * reading the router. Measured before the fix: 470 of 672 `/api` route entries
 * carried a recognisable gate. After: 515.
 *
 * The name is fragile in a way nothing else would report. Under Bun 1.4.2 a
 * top-level `const f: T = () => …` keeps its name while the SAME declaration
 * nested inside a function comes out as `""`; only an explicit
 * function-expression name survives both. A future tidy-up that turns it back
 * into an arrow blinds the router table and breaks nothing visible.
 */
describe("an authorization gate is visible from the route table", () => {
  let hh: TestHarness;

  beforeAll(() => {
    hh = makeHarness();
  });
  afterAll(() => hh.cleanup());

  const handlerNames = (): (string | undefined)[] =>
    (hh.app as unknown as { routes: { handler: { name?: string } }[] }).routes.map(
      (r) => r.handler?.name,
    );

  test("the factory returns a NAMED handler, not an anonymous closure", () => {
    const mw = requirePermission("posts", "read");
    expect(typeof mw).toBe("function");
    expect(
      mw.name,
      "a nested `const mw: MiddlewareHandler = async (c, next) => …` loses its name under Bun — use a named function expression",
    ).toBe("requirePermissionMw");
  });

  test("and the app's own route table carries that name", () => {
    // The unit assertion above passes even if nothing mounts it. This is the
    // half that proves the router really records what an audit would read.
    expect(handlerNames().filter((n) => n === "requirePermissionMw").length).toBeGreaterThan(20);
  });

  test("the gates that were already visible still are", () => {
    // If Hono ever stops recording middleware entries at all, the assertion
    // above fails for a reason that has nothing to do with the factory. This
    // one tells the two apart.
    const names = new Set(handlerNames());
    for (const gate of ["requireUser", "requireAdminMw", "requirePlatformMw", "requireOperatorMw"]) {
      expect(names.has(gate), `${gate} vanished from the route table`).toBe(true);
    }
  });
});
