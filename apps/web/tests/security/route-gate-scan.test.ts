/**
 * Authorization the ROUTER can see, checked mechanically instead of remembered.
 *
 * WHY THIS FILE EXISTS
 *
 * The 2026-09 audit's largest cluster was five route groups using the
 * self-serve workspace `admin` gate on deployment-wide state, while
 * `db-admin.ts` had the correct rule written down, in this codebase, in the
 * right place. Nothing could ask "which routes have no recognised gate in front
 * of them?" — the gates were invisible to anything mechanical, and invisible is
 * how that cluster happened. #344 made them visible; this reads them. See #345.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT
 *
 * Readability, not safety. A route gated inside its handler is protected and is
 * still counted: `POST /api/revisions/:id/revert` resolves the permission in its
 * body, correctly, and appears here. The remedy for an entry is normally to
 * move the check to a mounted middleware; where that is impossible the reason
 * belongs in a comment at the route, and in `MAX_UNGATED`'s doc.
 *
 * WHAT MAKES THIS A GUARD AND NOT A DECORATION
 *
 * A router scan that stops matching reports "0 ungated", which is
 * indistinguishable from a perfectly gated app. Four things are asserted
 * besides the count:
 *
 *   1. the scan saw a plausible number of in-scope routes (`MIN_IN_SCOPE`);
 *   2. it recognised a plausible number of GATES (`MIN_GATED`) — a matcher that
 *      recognises nothing would report every route ungated, the opposite
 *      failure and just as silent;
 *   3. every name in `GATE_NAMES` is actually registered somewhere, so a gate
 *      that is renamed or stops being mounted trips instead of quietly
 *      dropping out of the count;
 *   4. the matcher is exercised against synthetic routers with KNOWN answers —
 *      including the two shapes that made the original sweep over-report.
 *      Those fail even when the real router is spotless.
 *
 * AND THE CEILING IS A NUMBER, NOT A LIST
 *
 * Deliberately. A list of blessed paths is how a rule quietly stops meaning
 * anything: the code it excused moves, the entry stays, and the next route in
 * that file inherits a pass nobody wrote for it. This repo has that written
 * down twice. A ceiling cannot do it — a new ungated route pushes the count
 * past it and goes red whatever its path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GATE_NAMES,
  MAX_UNGATED,
  MIN_GATED,
  MIN_IN_SCOPE,
  type RouteEntry,
  scanRouteGates,
} from "../../../../scripts/scan-route-gates";
import { planeFor } from "../../src/server/lib/route-planes";
import { makeHarness, type TestHarness } from "../setup";

const planeOf = (p: string, m: string) => planeFor(p, m)?.plane;

describe("routes whose gate the router can see", () => {
  let h: TestHarness;
  let routes: RouteEntry[];

  beforeAll(() => {
    h = makeHarness();
    routes = (h.app as unknown as { routes: RouteEntry[] }).routes;
  });
  afterAll(() => h.cleanup());

  test("the scan can still see the router (vacuous-pass guard)", () => {
    const r = scanRouteGates(routes, planeOf);
    expect(
      r.inScope,
      `Only ${r.inScope} in-scope routes found. The scan has stopped seeing the ` +
        "router — its ungated count means nothing until this is fixed.",
    ).toBeGreaterThanOrEqual(MIN_IN_SCOPE);
  });

  test("the matcher can still recognise a gate (the opposite guard)", () => {
    const r = scanRouteGates(routes, planeOf);
    expect(
      r.gatedDirect,
      `Only ${r.gatedDirect} routes matched a gate name. A matcher that ` +
        "recognises nothing reports every route as ungated, which fails loudly — " +
        "but one that recognises too few quietly inflates the number instead.",
    ).toBeGreaterThanOrEqual(MIN_GATED);
  });

  test("every recognised gate name is actually mounted somewhere", () => {
    // The `ALLOWLIST is part of the test` rule, applied to the gate roster. A
    // gate that is renamed, or whose factory loses its function-expression name
    // under Bun, would stop matching — and every route behind it would silently
    // join the ungated count with no way to tell that from a real regression.
    const seen = new Set(routes.map((r) => r.handler?.name).filter(Boolean) as string[]);
    const missing = GATE_NAMES.filter((n) => !seen.has(n));
    expect(
      { missing },
      "These gate names match nothing in the router. Either the gate was " +
        "renamed, or a factory stopped returning a NAMED function expression " +
        "(a const arrow inside a function comes out as \"\" under Bun). Fix the " +
        "name or drop it from GATE_NAMES — do not leave it here.",
    ).toEqual({ missing: [] });
  });

  test("no more routes hide their gate than the recorded ceiling", () => {
    const r = scanRouteGates(routes, planeOf);
    expect(
      { count: r.ungated.length, routes: r.ungated },
      `${r.ungated.length} routes carry no gate the router can see, ceiling is ` +
        `${MAX_UNGATED}. A NEW one means its authorization lives in the handler ` +
        "body, where nothing mechanical can read it — move the check to a " +
        "mounted middleware. If it genuinely cannot be one (the permission " +
        "depends on the request body, or on a row the handler has to load " +
        "first), say so in a comment at the route and raise the ceiling in " +
        "scripts/scan-route-gates.ts with a sentence explaining which.",
    ).toEqual({ count: r.ungated.length, routes: r.ungated });
    expect(r.ungated.length).toBeLessThanOrEqual(MAX_UNGATED);
  });
});

/**
 * The matcher against inputs whose answers are known. These fail even when the
 * real router is spotless, which is what keeps the file honest between audits —
 * and two of them are the defects the original sweep shipped with.
 */
describe("the gate matcher itself", () => {
  const anyPlane = (): string | undefined => undefined;
  const gate = (path: string, method = "GET"): RouteEntry => ({
    path,
    method,
    handler: { name: "requireUser" },
  });
  const bare = (path: string, method = "GET"): RouteEntry => ({
    path,
    method,
    handler: { name: "" },
  });

  test("a route with a gate name is gated; one without is not", () => {
    const r = scanRouteGates([gate("/api/a"), bare("/api/b")], anyPlane);
    expect({ gated: r.gatedDirect, ungated: r.ungated }).toEqual({
      gated: 1,
      ungated: ["GET /api/b"],
    });
  });

  test("a wildcard gate covers its own ROOT, not only what is under it", () => {
    // Sweep defect #2. `r.use("*", requireUser)` mounted at `/api/agents` gates
    // `/api/agents` too; testing `startsWith(prefix + "/")` alone missed it and
    // reported the bare root as ungated.
    const r = scanRouteGates(
      [gate("/api/agents/*"), bare("/api/agents"), bare("/api/agents/x")],
      anyPlane,
    );
    expect(r.ungated).toEqual([]);
    expect(r.gatedWildcard).toBe(2);
  });

  test("an ALL row beside a gated method is a middleware registration, not a route", () => {
    // Sweep defect #1. `app.use("/api/uploads", tusHeaders)` registers an `ALL`
    // entry with an anonymous handler next to a gated `POST`.
    const r = scanRouteGates([gate("/api/uploads", "POST"), bare("/api/uploads", "ALL")], anyPlane);
    expect({ ungated: r.ungated, artefacts: r.artefacts }).toEqual({
      ungated: [],
      artefacts: 1,
    });
  });

  test("an ALL row with NO gated sibling is still counted", () => {
    // The other half of that rule — otherwise `ALL` would become a way to
    // register an ungated route and disappear from the count.
    const r = scanRouteGates([bare("/api/lonely", "ALL")], anyPlane);
    expect(r.ungated).toEqual(["ALL /api/lonely"]);
  });

  test("a path declared `public` is excluded, and only that path", () => {
    const r = scanRouteGates(
      [bare("/api/open"), bare("/api/closed")],
      (p) => (p === "/api/open" ? "public" : "platform"),
    );
    expect(r.ungated).toEqual(["GET /api/closed"]);
  });

  test("`public` is asked per METHOD, so a public GET does not excuse the PUT beside it", () => {
    // `ROUTE_PLANES` can qualify an entry by method — `GET /api/workspace-config`
    // is what the sign-in page renders itself from, `PUT` is what writes it. If
    // this scan asked the table by path alone it would either report the public
    // GET as ungated forever, or (worse, if the table were flattened to make it
    // stop) excuse an operator write.
    const r = scanRouteGates(
      [bare("/api/cfg", "GET"), bare("/api/cfg", "PUT")],
      (p, m) => (p === "/api/cfg" && m === "GET" ? "public" : "platform"),
    );
    expect(r.ungated).toEqual(["PUT /api/cfg"]);
  });

  test("routes outside /api, /mcp, /s3 and /.well-known are not in scope", () => {
    const r = scanRouteGates([bare("/embed/d/tok"), bare("/f/tok"), bare("/api/x")], anyPlane);
    expect({ inScope: r.inScope, ungated: r.ungated }).toEqual({
      inScope: 1,
      ungated: ["GET /api/x"],
    });
  });

  test("the same path under two methods is judged per method", () => {
    // A gated POST must not launder an ungated GET beside it. Only the `ALL`
    // rule above crosses methods, and only because those are not routes.
    const r = scanRouteGates([gate("/api/thing", "POST"), bare("/api/thing", "GET")], anyPlane);
    expect(r.ungated).toEqual(["GET /api/thing"]);
  });
});
