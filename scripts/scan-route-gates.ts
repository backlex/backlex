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
 * reader cannot see. What follows is the classification, RE-DERIVED from the
 * live router rather than carried forward — an earlier version of this comment
 * had three of these wrong, and a wrong classification is worse than none
 * because it retires a question nobody then re-asks.
 *
 * The 19, by why each one is here:
 *
 *  · **2 middleware registrations.** `ALL /api/t/*` and `ALL /api/uploads/*`
 *    are `app.use(...)` rows, not routes. Arguably the scan should not count
 *    them at all; that is a change to this file, not to the product.
 *
 *  · **9 `/api/realtime/*`.** The permission is keyed on the `:channel` path
 *    param and what it maps to differs per channel KIND, so there is nothing
 *    for a mounted middleware to name.
 *
 *  · **2 GraphQL doors** — `ALL /api/graphql` and `ALL /api/graphql/stream`.
 *    These were previously filed as "genuinely liftable" and that was WRONG.
 *    Their route-level check is `auth.tenantId`, a scoping precondition, not
 *    authorization: an anonymous caller carrying `X-Backlex-Tenant` is meant to
 *    reach them, and the real check is `resolvePermission(ctx, auth, collection,
 *    action)` per resolver — a single document touches many collections with
 *    different actions. Mounting `requireUser` would break anonymous public
 *    reads; mounting a `requireTenant` would be worse than nothing, because a
 *    gate name that means "a tenant is required" would let a future route drop
 *    out of this count while staying anonymously reachable.
 *
 *  · **1 `POST /api/items/:slug/batch`** — a batch carries mixed
 *    create/update/delete, so there is no single action to name.
 *
 *  · **1 `POST /api/revisions/:id/revert`** — the collection is only known
 *    after loading the revision row named by `{id}`.
 *
 *  · **1 `GET /api/admin/integrations/oauth/callback`** — gated inside, and it
 *    has to be: it is where the PROVIDER redirects a browser back, so it must
 *    answer a signed-out caller with a redirect to `/integrations?oauth=…`, not
 *    the JSON 401 a mounted gate returns.
 *
 *  · **3 public by design that CANNOT be declared so.** `ROUTE_PLANES` is keyed
 *    on a path PREFIX, not a method, and `GET /api/workspace-config` +
 *    `GET /api/workspace-config/asset/:kind` share their prefix with the
 *    operator's `PUT /` and `GET /raw`. Declaring the prefix `public` would open
 *    those. `GET /api/t/:slug/orgs/invites/:token` is the app-plane invite
 *    lookup, where holding the token IS the authorization.
 *    (`GET /api/tenants/invite` was the one of these with a prefix of its own,
 *    and it moved in #350.)
 *
 * So exactly ONE of the 19 was liftable — `GET /api/me`, which now mounts
 * `requireUser` — and the honest remainder is two structural questions rather
 * than a backlog of routes: should this scan count `app.use` rows at all, and
 * should `ROUTE_PLANES` gain method granularity.
 *
 * Lower it when a family moves. Raising it needs a sentence saying why.
 */
export const MAX_UNGATED = 19;

/** Below this the scan has stopped seeing the router and its zero means
 *  nothing. */
export const MIN_IN_SCOPE = 500;

/** Below this the matcher has stopped recognising gates, which would make every
 *  route look ungated — the opposite failure, and just as silent. */
export const MIN_GATED = 400;
