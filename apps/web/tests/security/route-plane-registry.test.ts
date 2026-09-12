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
import { makeHarness, type TestHarness } from "../setup";
import { ROUTE_PLANES, applies, planeFor, type RoutePlane } from "../../src/server/lib/route-planes";
import { requirePermission } from "../../src/server/middleware/permission";

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
  /** The same routes with their METHOD, for the entries qualified by one. */
  let routes: { path: string; method: string }[];

  beforeAll(() => {
    h = makeHarness();
    // Hono records one entry per registered handler, including the `use("*")`
    // middleware chain. Middleware entries are the bare wildcards, and a
    // route's own path is what we care about.
    const seen = new Set<string>();
    routes = [];
    for (const r of (h.app as unknown as { routes: { path: string; method: string }[] }).routes) {
      if (r.path === "*" || r.path === "/*") continue;
      seen.add(r.path);
      routes.push({ path: r.path, method: r.method });
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
    //
    // `applies` is the REAL matcher, imported rather than mirrored. This test
    // used to carry its own copy of the segment matching, and the copy
    // disagreed the moment `exact` stopped meaning string equality — it
    // reported a live entry dead. An entry is reachable exactly when the
    // matcher would pick it, so asking the matcher is not only shorter, it is
    // the question. It also covers the qualification for free: a carve-out
    // naming a method nobody serves (`{ methods: ["PATCH"] }` on a GET-only
    // prefix) is fiction, and a prefix-only check would have blessed it.
    const dead = ROUTE_PLANES.filter((entry) => {
      if (entry.prefix === "/api") return false; // the fallback, always "live"
      return !routes.some((r) => applies(entry, r.path, r.method));
    }).map((e) => `${e.methods ? `${e.methods.join("|")} ` : ""}${e.prefix}${e.exact ? " (exact)" : ""}`);

    expect(dead, `declared but never mounted:\n${dead.join("\n")}`).toEqual([]);
  });

  test("a method-qualified entry narrows, and the base entry still answers for the rest", () => {
    // The `/api/workspace-config` prefix serves a public read that the SIGN-IN
    // page makes and an operator write, at the same path. This is the one shape
    // a prefix-keyed table cannot express, and the reason `methods` / `exact`
    // exist — so it is asserted directly rather than inferred from the count in
    // route-gate-scan.test.ts.
    expect(planeFor("/api/workspace-config", "GET")?.plane).toBe("public" satisfies RoutePlane);
    expect(planeFor("/api/workspace-config", "PUT")?.plane).toBe("platform" satisfies RoutePlane);
    // `exact`, so the carve-out does not run downhill into paths it was not
    // written for. `/raw` is the operator's unredacted read.
    expect(planeFor("/api/workspace-config/raw", "GET")?.plane).toBe("platform" satisfies RoutePlane);
    // …while the branding assets the sign-in page loads have a prefix of their
    // own, and needed no new dimension at all.
    expect(planeFor("/api/workspace-config/asset/logo", "GET")?.plane).toBe("public" satisfies RoutePlane);
    expect(planeFor("/api/workspace-config/asset/logo", "POST")?.plane).toBe("platform" satisfies RoutePlane);

    // Same split under /api/t: reading an invite by its token runs before the
    // visitor has anything, accepting it does not.
    expect(planeFor("/api/t/acme/orgs/invites/tok_x", "GET")?.plane).toBe("public" satisfies RoutePlane);
    expect(planeFor("/api/t/acme/orgs/invites/accept", "POST")?.plane).toBe("app" satisfies RoutePlane);
    // An org's OWN invite list is a different path shape and keeps `app`.
    expect(planeFor("/api/t/acme/orgs/org_1/invites", "GET")?.plane).toBe("app" satisfies RoutePlane);
  });

  test("the invite carve-out cannot be widened by an org slug", () => {
    // `findOrg` resolves `:orgId` by id OR SLUG, and the slug is caller-chosen.
    // Without the depth pin an org slugged `invites` would drag every path
    // under `/orgs/invites/` into a `public` declaration written for one
    // token lookup — the firewall reads a path prefix and never learns which
    // route Hono actually matched, so it would drop a layer off routes that
    // are not this one.
    expect(planeFor("/api/t/acme/orgs/invites/org_1/members", "GET")?.plane).toBe(
      "app" satisfies RoutePlane,
    );
    expect(planeFor("/api/t/acme/orgs/invites/invites", "GET")?.plane).toBe(
      "public" satisfies RoutePlane, // same depth as the token lookup — this IS the token lookup
    );
    expect(planeFor("/api/t/acme/orgs/invites", "GET")?.plane).toBe("app" satisfies RoutePlane);
  });

  test("omitting the method returns the BROADER entry, never the carve-out", () => {
    // `planeFor(path)` still has callers, and the safe direction for one that
    // does not know the method is the stricter answer. A qualified entry must
    // not be reachable without naming the method it was qualified for —
    // otherwise dropping the argument anywhere would silently publish a route.
    expect(planeFor("/api/workspace-config")?.plane).toBe("platform" satisfies RoutePlane);
    expect(planeFor("/api/t/acme/orgs/invites/tok_x")?.plane).toBe("app" satisfies RoutePlane);
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

  test("no prefix is declared twice under the same qualification", () => {
    // Two entries MAY share a prefix, but only when one narrows the other by
    // method or by `exact` — that is what a carve-out is. Two entries with the
    // same prefix and the same qualification are a genuine duplicate: the sort
    // picks one by tie-break and the other is dead text that reads as a
    // declaration.
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of ROUTE_PLANES) {
      const key = `${e.methods ? [...e.methods].sort().join("|") : "*"} ${e.prefix}${e.exact ? " exact" : ""}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    expect(dupes).toEqual([]);
  });

  test("a carve-out is strictly narrower than the entry it shares a prefix with", () => {
    // The property that makes `methods` / `exact` safe to add to an ENFORCING
    // guard: a qualified entry can only ever take requests AWAY from the base
    // entry, never add any. So every prefix declared more than once must have
    // exactly one unqualified entry to fall back to — a set of carve-outs with
    // no base would leave whatever they do not match falling through to a
    // SHORTER prefix, and the shortest of all is `/api`, which is `public`.
    const byPrefix = new Map<string, typeof ROUTE_PLANES>();
    for (const e of ROUTE_PLANES) {
      byPrefix.set(e.prefix, [...(byPrefix.get(e.prefix) ?? []), e]);
    }
    const baseless = [...byPrefix]
      .filter(([, es]) => es.length > 1 && !es.some((e) => !e.methods && !e.exact))
      .map(([p]) => p);
    expect(
      baseless,
      `these prefixes are declared only by carve-outs, so anything they do not match falls through to a shorter prefix:\n${baseless.join("\n")}`,
    ).toEqual([]);
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
