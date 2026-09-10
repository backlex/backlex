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
 *
 * What it does NOT try to do is tell an `app.use` row from an `app.all` route.
 * Hono records the two identically and the attempt would be a heuristic that
 * can hide a real ungated catch-all — the argument is at `MAX_UNGATED`.
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
 * @param planeOf Declared plane for a (path, method), or `undefined`. Injected
 *                rather than imported so this file stays free of the server
 *                tree and so a test can drive the matcher with known answers.
 *                The METHOD is passed because `ROUTE_PLANES` can qualify an
 *                entry by it — a prefix serving a public GET beside an operator
 *                PUT — and a path-only lookup would report the public one as
 *                ungated forever.
 */
export const scanRouteGates = (
  routes: readonly RouteEntry[],
  planeOf: (path: string, method: string) => string | undefined,
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
    // firewall reads the same one — including its method qualification, so this
    // scan and the firewall cannot disagree about which route the declaration
    // was for.
    if (planeOf(path, method) === "public") continue;
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
 * The 16, by why each one is here:
 *
 *  · **2 middleware registrations.** `ALL /api/t/*` and `ALL /api/uploads/*`
 *    are `app.use(...)` rows, not routes. **They stay counted, deliberately —
 *    see the note below.**
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
 * ── THE TWO STRUCTURAL QUESTIONS, ANSWERED ──────────────────────────────────
 *
 * **Should `ROUTE_PLANES` gain method granularity? YES — it has, and the claim
 * this comment used to make about the three routes it blocked was wrong for
 * two of them.** They were filed as "public by design but the table is keyed on
 * a prefix, so they cannot be declared". Only ONE of the three actually needed
 * a new dimension:
 *
 *   · `GET /api/workspace-config` genuinely does share a PATH with `PUT
 *     /api/workspace-config`, which no prefix can separate. That is what
 *     `methods` + `exact` are for, and it is the case they were added for.
 *   · `GET /api/workspace-config/asset/:kind` had a prefix of its own the whole
 *     time (`/api/workspace-config/asset`).
 *   · `GET /api/t/:slug/orgs/invites/:token` likewise
 *     (`/api/t/*​/orgs/invites`) — `POST …/invites/accept` sits under it and is
 *     separated by the method, not the path.
 *
 * All three were also live defects rather than bookkeeping: each was declared
 * to a plane that REFUSED the caller it exists for. Same shape as the
 * `/api/tenants/invite` 403 that #350 fixed, three more instances of it.
 *
 * **Should this scan stop counting `app.use` rows? NO.** Hono records
 * `app.use(path, mw)` and `app.all(path, handler)` **identically** — verified
 * in `hono/dist/hono-base.js`, where both reach `#addRoute(METHOD_NAME_ALL,
 * …)` and push `{ basePath, path, method, handler }` with nothing to tell them
 * apart. So there is no sound rule, only heuristics, and every one of them has
 * an unsafe direction:
 *
 *   · *"an ALL row over a path with concrete routes beneath it is a mount"* —
 *     laundered by `app.all("/api/x/*", handler)` used as a fallback beneath
 *     real routes, which is a shape this codebase already contains
 *     (`routes/auth.ts` is `new Hono().all("/*", …)`).
 *   · *"an ALL row whose handlers are all NAMED is a mount"* — laundered by any
 *     route handler that is a named function.
 *
 * Two permanent entries in a ceiling of 16 is a cheap price for not teaching
 * this scan a rule that can hide a genuinely ungated catch-all. The existing
 * `artefacts` rule stays as it is because it is narrower: it fires only where a
 * CONCRETE method at the SAME path is already gated and separately judged.
 *
 * So the remainder is not a backlog and not an open question. It is thirteen
 * routes whose gate cannot be mounted for a reason recorded at each one, plus
 * two rows that are not routes and that the router cannot prove are not routes.
 *
 * Lower it when a family moves. Raising it needs a sentence saying why.
 */
export const MAX_UNGATED = 16;

/** Below this the scan has stopped seeing the router and its zero means
 *  nothing. */
export const MIN_IN_SCOPE = 500;

/** Below this the matcher has stopped recognising gates, which would make every
 *  route look ungated — the opposite failure, and just as silent. */
export const MIN_GATED = 400;
