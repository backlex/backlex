/**
 * Which mounted `/api` routes name an authorization gate the ROUTER can see.
 *
 * WHY THIS EXISTS
 *
 * The 2026-09 audit's largest cluster was five route groups using the
 * self-serve workspace `admin` gate on deployment-wide state, while the correct
 * rule sat written down, in this codebase, in the right file. Nothing could ask
 * "which routes have no recognised gate in front of them?", because the gates
 * were not visible to anything mechanical. #344 made them visible; this is what
 * reads them.
 *
 * A route that is gated INSIDE its handler is protected and still counted here.
 * That is the point: this measures readability, not safety. The remedy for an
 * entry is usually to move the check to a mounted middleware, and where that is
 * impossible the reason belongs in a comment at the route — see the ceiling
 * below.
 *
 * TWO THINGS THE ORIGINAL SWEEP GOT WRONG, both of which OVER-report
 * (measured on PR #346's branch, and the reason this lives in a file rather
 * than in an issue comment):
 *
 *  1. **`ALL` rows.** `app.use("/api/uploads", tusHeaders)` registers an entry
 *     with method `ALL` and an anonymous handler. Keying on `method + path`
 *     judges it separately from the `POST /api/uploads` beside it, which is
 *     gated and visible. Those are middleware registrations, not routes.
 *  2. **A wildcard mount covers its own root.** `r.use("*", requireUser, …)`
 *     mounted at `/api/agents` gates `/api/agents` as well as everything under
 *     it. Testing only `startsWith(prefix + "/")` misses the bare root.
 *
 * Together they accounted for five of the 45 the issue opened with.
 */

/** One entry as Hono records it in `app.routes`. */
export interface RouteEntry {
  path: string;
  method: string;
  handler?: { name?: string };
}

/**
 * The middleware names that COUNT as an authorization gate.
 *
 * A name, not a reference, because that is all `app.routes` carries. Which is
 * also the trap: a gate produced by a factory must be a NAMED function
 * expression or it arrives as `""` and silently stops counting. See
 * `middleware/permission.ts` and `middleware/app-user.ts`, both of which say so
 * at the definition.
 */
export const GATE_NAMES: readonly string[] = [
  "requireUser",
  "requireAdmin",
  "requireAdminMw",
  "requireAdminMiddleware",
  "requireAdminWorkspaceMw",
  "requireAdminTenantGate",
  "requireOperatorMw",
  "requirePlatformMw",
  "requireUserWithOAuthChallenge",
  "requirePermissionMw",
  "requireAppUserMw",
  "protectedResource",
  "dynamicRegistrationGate",
];

/** Only these prefixes are in scope — the SPA shell and static assets are not. */
const IN_SCOPE = /^\/(api|mcp|s3|\.well-known)/;

export interface GateScanResult {
  /** Route keys in scope. */
  inScope: number;
  /** Gated by a middleware mounted directly on the route. */
  gatedDirect: number;
  /** Covered by a gate mounted on a wildcard above them (or at their root). */
  gatedWildcard: number;
  /** `ALL` rows whose path is gated under a concrete method — `app.use(...)`
   *  registrations, not routes. */
  artefacts: number;
  /** `METHOD /path` for everything left, excluding paths declared `public`. */
  ungated: string[];
}

/**
 * @param routes  Hono's `app.routes`.
 * @param planeOf Declared plane for a path, or `undefined`. Injected rather
 *                than imported so this file stays free of the server tree and
 *                so a test can drive the matcher with known answers.
 */
export const scanRouteGates = (
  routes: readonly RouteEntry[],
  planeOf: (path: string) => string | undefined,
): GateScanResult => {
  const gates = new Set(GATE_NAMES);

  // A gate mounted on `<prefix>/*` covers the prefix ITSELF and everything
  // beneath it.
  const wildcards = routes
    .filter((r) => r.handler?.name && gates.has(r.handler.name) && r.path.endsWith("/*"))
    .map((r) => r.path.slice(0, -2))
    .filter((p) => p.length > 0);

  /** Every gate name seen at a PATH, under any method. */
  const gatedPaths = new Set<string>();
  for (const r of routes) {
    const n = r.handler?.name;
    if (n && gates.has(n)) gatedPaths.add(r.path);
  }

  const byKey = new Map<string, Set<string>>();
  for (const r of routes) {
    if (r.path === "*" || r.path === "/*") continue;
    const key = `${r.method} ${r.path}`;
    byKey.set(key, (byKey.get(key) ?? new Set()).add(r.handler?.name || ""));
  }

  const out: GateScanResult = {
    inScope: 0,
    gatedDirect: 0,
    gatedWildcard: 0,
    artefacts: 0,
    ungated: [],
  };

  for (const [key, names] of byKey) {
    const sp = key.indexOf(" ");
    const method = key.slice(0, sp);
    const path = key.slice(sp + 1);
    if (!IN_SCOPE.test(path)) continue;
    out.inScope++;

    if ([...names].some((n) => gates.has(n))) {
      out.gatedDirect++;
      continue;
    }
    if (wildcards.some((w) => path === w || path.startsWith(`${w}/`))) {
      out.gatedWildcard++;
      continue;
    }
    if (method === "ALL" && gatedPaths.has(path)) {
      out.artefacts++;
      continue;
    }
    // Declared unauthenticated. Read from the plane table rather than a local
    // list, so there is exactly one place that says a route is public and the
    // firewall reads the same one.
    if (planeOf(path) === "public") continue;
    out.ungated.push(key);
  }
  out.ungated.sort();
  return out;
};

/**
 * How many routes may still hide their gate inside the handler.
 *
 * A NUMBER, deliberately, not a list of blessed paths. A stale exemption list
 * is how a rule quietly stops meaning anything — the code it excused moves, the
 * entry stays, and the next route in that file inherits a pass nobody wrote for
 * it. A ceiling cannot do that: any new ungated route pushes the count past it
 * and goes red, whatever its path.
 *
 * It is not a target to sit at. Every entry under it is a route whose gate a
 * reader cannot see, and #345 carries the classification. As of `cf670380` the
 * 21 are: `app.use` registrations under `/api/t/*` and `/api/uploads/*`; the
 * two GraphQL doors and `/api/me`, which check `auth` in the handler; five
 * routes that are public by design but not yet declared so in `ROUTE_PLANES`;
 * and three that CANNOT become a mounted middleware —
 * `POST /api/items/:slug/batch` (the action differs per operation),
 * `POST /api/revisions/:id/revert` (the collection is only known after loading
 * the revision row) and `/api/realtime/*` (the permission is keyed on the
 * channel path param).
 *
 * Lower it when a family moves. Raising it needs a sentence saying why.
 */
export const MAX_UNGATED = 21;

/** Below this the scan has stopped seeing the router and its zero means
 *  nothing. */
export const MIN_IN_SCOPE = 500;

/** Below this the matcher has stopped recognising gates, which would make every
 *  route look ungated — the opposite failure, and just as silent. */
export const MIN_GATED = 400;
