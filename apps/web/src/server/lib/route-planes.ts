/**
 * Which auth plane each mounted route prefix belongs to.
 *
 * WHY THIS FILE EXISTS
 *
 * backlex has two auth planes — `"platform"` (operators running the dashboard)
 * and `"app"` (a workspace's own end-users). The boundary between them used to
 * be upheld almost everywhere by an ACCIDENT rather than a check:
 * `tenantMiddleware` leaves `auth.roles` empty for `plane === "app"`, so
 * `requireAdminMw` denies, while `requireUser` alone checks only `auth.userId`
 * — which an `app_users` id satisfies just as well as a `users` id. The gate
 * written for exactly this, `requirePlatformMw`, sat on a handful of route
 * files out of the ~110 prefixes below.
 *
 * The highest-value invariant in a two-plane product should not rest on an
 * empty array one line away from being populated. So this table is a single
 * declared answer per prefix, and TWO things read it: the middleware in
 * `middleware/plane-firewall.ts`, which refuses a violation (`PLANE_GUARD`
 * defaults to `enforce`), and `apps/web/tests/route-plane-registry.test.ts`,
 * which refuses a new mount that declares nothing.
 *
 * The test half is not the lesser half. An UNKNOWN path is admitted in BOTH
 * modes on purpose — a typo in this table must not take the site down — so a
 * prefix nobody declared is a hole in an enforcing guard that raises no 403 and
 * writes no log line. Completeness is what makes the enforcement mean anything.
 *
 * This FILE still changes no runtime behaviour by itself; it is data. What
 * reads it does.
 *
 * THE FOUR VALUES
 *
 *   `"platform"` — operator surface. An app-plane bearer must never reach it.
 *   `"app"`      — the workspace's own end-user surface (`/api/t/:slug/...`).
 *   `"public"`   — unauthenticated by design (sign-in, JWKS, public forms,
 *                  inbound webhooks, the OpenAPI document).
 *   `"either"`   — genuinely serves both planes. `/api/items` is the product:
 *                  an operator browses a collection in the admin UI and an
 *                  end-user reads the same collection through the SDK, and the
 *                  permission resolver — not the plane — decides what each one
 *                  sees.
 *
 * HONESTY RULE FOR `"either"`
 *
 * `"either"` means "both planes are SUPPOSED to reach this", never "both planes
 * happen to reach this today because the route only carries `requireUser`". A
 * prefix in the second category is marked `"either"` with a `revisit` note
 * naming what has to be decided, so the enforcement phase inherits a list of
 * open questions instead of a table that quietly blesses the current gaps.
 * Enforcement will bite `"platform"`, `"app"` and `"public"`; `"either"` is the
 * escape hatch, and every unjustified one is debt this file makes visible.
 */

export type RoutePlane = "platform" | "app" | "public" | "either";

export interface RoutePlaneEntry {
  /** Mount prefix exactly as it appears in `app.ts`. */
  prefix: string;
  plane: RoutePlane;
  /** Why this prefix carries this plane, when it is not self-evident. */
  note?: string;
  /**
   * Set on an `"either"` entry that is only `"either"` because nothing narrows
   * it today. Names the decision the enforcement phase has to make.
   */
  revisit?: string;
  /**
   * Restrict this entry to these HTTP methods (upper-case). Omitted, it answers
   * for every method — which is the right default and should stay the common
   * case.
   *
   * WHY THIS EXISTS, AND WHY IT IS A NARROWING ONLY
   *
   * The table models `prefix → plane`; a router models `(method, path) →
   * handler`. Where a prefix serves one route that is public by design and
   * another that is the operator's, the coarser model cannot say so.
   * `/api/workspace-config` is the case: `GET /` is what the SIGN-IN page reads
   * for the workspace's name and branding, while `PUT /` writes it. One prefix,
   * two answers, and declaring the prefix `public` to fix the first would open
   * the second.
   *
   * A qualified entry can only ever make FEWER requests match it. A request it
   * does not match falls through to the next-most-specific entry, so removing
   * one of these can only widen what the entry admitted — never narrow it — and
   * the entry it falls through to is the unqualified one that was already
   * there. That is the property that keeps this safe to add to an ENFORCING
   * guard: the base declaration stays, and this carves an exception out of it.
   *
   * Reach for it only when a prefix genuinely serves both answers. A public
   * route that has a path of its own gets a prefix of its own instead — that
   * is what `/api/tenants/invite` did in #350, and it stays the cheaper move.
   */
  methods?: readonly string[];
  /**
   * Match only paths of the prefix's own DEPTH, never anything beneath it.
   *
   * Every other entry is inherited downward, which is normally what you want —
   * a new `/api/admin/*` mount picks up `platform` without touching this file.
   * For a PUBLIC exception that inheritance points the wrong way: a new route
   * added under it would become unauthenticated because of a decision taken
   * about a different route. `exact` stops that at the depth the exception was
   * written for.
   *
   * Depth rather than string equality, so it composes with `*`. For a
   * wildcard-free prefix the two are the same thing; for
   * `/api/t/*​/orgs/invites/*` only depth can say "the token lookup, and not
   * whatever somebody mounts under it later".
   */
  exact?: boolean;
}

/**
 * Ordered longest-prefix-wins. `planeFor` sorts by descending prefix length, so
 * declaration order here is for humans; `/api/admin/settings` beats `/api`
 * regardless of where each sits in the list.
 *
 * Three entries additionally carry `methods` / `exact`. Those are carve-outs
 * from the broader entry directly below them and are consulted first; see
 * `RoutePlaneEntry.methods` for why a qualified entry can only ever narrow.
 */
export const ROUTE_PLANES: readonly RoutePlaneEntry[] = [
  // ── public ──────────────────────────────────────────────────────────────
  {
    prefix: "/api/auth",
    plane: "public",
    note: "Control-plane sign-in/sign-up/callback. Unauthenticated by definition; better-auth owns its own CSRF and the rate limiter guards the sensitive subpaths.",
  },
  {
    prefix: "/.well-known",
    plane: "public",
    note: "JWKS + MCP OAuth discovery. Must be fetchable by a relying party that holds no credential at all.",
  },
  { prefix: "/api/i18n", plane: "public", note: "Published locale catalogues." },
  { prefix: "/api/public/approve", plane: "public", note: "Token-addressed approval link from an email." },
  { prefix: "/api/public/book", plane: "public", note: "Public booking page." },
  { prefix: "/api/public/dashboards", plane: "public", note: "Embedded dashboard, addressed by its embed token." },
  { prefix: "/api/public/forms", plane: "public", note: "Hosted form submission." },
  { prefix: "/api/public/sign", plane: "public", note: "E-signature ceremony, addressed by its signing token." },
  { prefix: "/api/shared", plane: "public", note: "Shared-record link, addressed by its token." },
  { prefix: "/api/site", plane: "public", note: "The tracker/consent script a customer's site loads." },
  { prefix: "/api/analytics", plane: "public", note: "Analytics collection + ingest from a customer's site. Authenticated by an ingest key, not a session." },
  { prefix: "/api/consent", plane: "public", note: "Consent banner bundle + record write from a visitor's browser." },
  { prefix: "/api/flags", plane: "public", note: "Feature-flag evaluation for an unauthenticated client." },
  { prefix: "/api/webhook", plane: "public", note: "INBOUND webhook trigger (singular). Authenticated by its own signature, never by a session. Distinct from /api/webhooks, which is the operator's outbound registry." },
  { prefix: "/api/payments", plane: "public", note: "Provider callbacks + hosted checkout return. Signature-authenticated." },
  { prefix: "/api/integrations", plane: "public", note: "Inbound provider webhooks + OAuth callback. Signature/state-authenticated." },
  { prefix: "/api/scim/v2", plane: "public", note: "SCIM provisioning from an external IdP. Bearer-authenticated by a provisioning token, which is neither plane's session." },
  { prefix: "/s3", plane: "public", note: "S3-compatible endpoint. AWS SigV4 over an s3 credential row; no session is involved." },
  {
    prefix: "/api/_internal/sandbox-rpc",
    plane: "public",
    note: "Loopback RPC from the functions sandbox. Guards itself on a per-invocation secret; never reachable with a user session.",
  },

  // ── app plane ───────────────────────────────────────────────────────────
  {
    // `*` matches exactly one path segment — here the workspace slug.
    prefix: "/api/t/*/auth",
    plane: "public",
    note: "A workspace's OWN auth surface: sign-up, sign-in, SAML ACS, LDAP bind, magic link, token refresh, invite accept. Nobody reaching it has an app-plane session yet — acquiring one is the point — and the caller's browser may well be holding a platform cookie from the dashboard on the same origin. Declaring the whole of /api/t as `app` made every one of these a violation, which is how the warn window earned its keep.",
  },
  {
    // Reading an invite by its token, before the invitee has any session at
    // all — `routes/app-orgs-public.ts` calls this out in its header as the one
    // route there that runs for a visitor with nothing. Holding the token IS
    // the authorization, and the response is the inviting org's name plus the
    // email it was sent to, both of which the holder already has.
    //
    // GET only, and that is what makes this expressible: `POST
    // /orgs/invites/accept` sits at the same depth and DOES need an app-plane
    // session, so it falls through to `/api/t` below. Declaring the prefix
    // outright would have taken the accept route with it.
    //
    // Pinned to this exact DEPTH, and that is load-bearing rather than tidy.
    // `findOrg` resolves `:orgId` by id **or slug**, and the slug is
    // caller-chosen — so without the pin an org slugged `invites` would put
    // `/orgs/invites/<x>/…` under a `public` declaration and quietly remove the
    // firewall layer from routes that are not this one. `RESERVED_ORG_SLUGS`
    // now refuses that slug at write time as well; both halves, because the
    // firewall reads a path prefix and never sees which route Hono matched.
    prefix: "/api/t/*/orgs/invites/*",
    methods: ["GET"],
    exact: true,
    plane: "public",
    note:
      "Token-addressed invite lookup. Declared separately because `app` was refusing the platform plane: an operator signed in to the dashboard who clicks a workspace invite link got a 403, which is the mirror image of the defect #350 fixed on /api/tenants/invite. #345.",
  },
  {
    prefix: "/api/t",
    plane: "app",
    note: "The rest of the per-workspace end-user surface: orgs, agents. tenantMiddleware pins these to the workspace stamped on the session and ignores X-Backlex-Tenant.",
  },

  // ── platform plane ──────────────────────────────────────────────────────
  {
    // Longest-match wins, so this sits above `/api/tenants` and covers only
    // `GET /invite/{token}` — `covers` compares whole segments, so it does not
    // reach `/api/tenants/invites`.
    //
    // It DOES cover anything added deeper, though: a future
    // `POST /api/tenants/invite/<anything>` would inherit `public` from here
    // rather than `platform` from the entry below. Nothing lives there today;
    // check this before adding one.
    prefix: "/api/tenants/invite",
    plane: "public",
    note:
      "The invite-accept page's lookup, and the one route under /api/tenants that is unauthenticated by design — its own OpenAPI description opens with \"Public.\" Holding the token IS the authorization, and the response is the invited email plus the workspace name, both of which the holder already has. Declared separately because `platform` was also refusing an app-plane bearer: somebody already signed in to another workspace who clicks an invite link got a 403 from the plane firewall, which is not a boundary anyone meant to draw. #345.",
  },
  { prefix: "/api/tenants", plane: "platform", note: "Workspace CRUD, membership and invites. POST / is requireUser-only today — the single most load-bearing missing plane gate in the app." },
  { prefix: "/api/users", plane: "platform", note: "Platform-user administration." },
  { prefix: "/api/app-users", plane: "platform", note: "OPERATOR view of the end-user pool. The end-users' own surface is /api/t." },
  { prefix: "/api/app-orgs", plane: "platform", note: "OPERATOR view of organizations. The org members' own surface is /api/t/:slug/orgs." },
  { prefix: "/api/roles", plane: "platform" },
  { prefix: "/api/permissions", plane: "platform" },
  { prefix: "/api/api-keys", plane: "platform", note: "Mints pak_ keys, which session.ts resolves on the PLATFORM plane. An app-plane caller reaching this laundered itself across the boundary." },
  { prefix: "/api/activity", plane: "platform", note: "The audit log." },
  { prefix: "/api/admin", plane: "platform", note: "Every /api/admin/* mount. Longest-prefix means each specific one below is redundant, which is the point: a new /api/admin/* mount inherits the right answer without touching this file." },
  {
    // The sign-in page's own read: the workspace name, logo and which login
    // methods to draw. Its handler says so — "public so the login page…" — and
    // it carries no gate, correctly, because nobody loading a sign-in screen
    // has a session yet.
    //
    // `exact` + GET, because the prefix serves three other routes that are the
    // operator's: `PUT /` writes this configuration, and `GET /raw` returns it
    // unredacted. Both fall through to the `platform` entry below.
    prefix: "/api/workspace-config",
    methods: ["GET"],
    exact: true,
    plane: "public",
    note:
      "What the sign-in page renders itself from. Declared public because `platform` refused an app-plane bearer: a workspace end-user whose browser holds an app-plane cookie on the same origin got a 403 loading the operator sign-in screen, and the screen has no branding without this. #345.",
  },
  {
    // The logo/favicon bytes the route above names. Same reasoning, one level
    // down; GET-only so an upload route added here would not inherit `public`.
    prefix: "/api/workspace-config/asset",
    methods: ["GET"],
    plane: "public",
    note: "Branding assets the sign-in page loads. Read-only by design — the operator's write path is PUT /api/workspace-config.",
  },
  { prefix: "/api/workspace-config", plane: "platform", note: "Workspace-level configuration the operator edits — PUT / and GET /raw. The two public reads are declared above." },
  { prefix: "/api/collections", plane: "platform", note: "Schema DDL. Already carries requirePlatformMw on its write routes (DDL_GATE)." },
  { prefix: "/mcp", plane: "platform", note: "Tenant MCP transport. Its tools replay the control-plane router through makeInternalFetch, so it inherits whatever that surface allows." },

  // ── either ──────────────────────────────────────────────────────────────
  {
    prefix: "/api/me",
    plane: "either",
    note: "Self-description of the caller. Both planes have a 'who am I' and both answers are correct.",
  },
  {
    prefix: "/api/account",
    plane: "either",
    note: "Self-service profile + preferences. Same reasoning as /api/me.",
  },
  {
    prefix: "/api/items",
    plane: "either",
    note: "The product. An operator browses a collection in the admin UI and an end-user reads the same collection through the SDK; requirePermission decides what each sees, and the plane is not the discriminator.",
  },
  { prefix: "/api/graphql", plane: "either", note: "The GraphQL twin of /api/items, and it must answer for both planes for the same reason." },
  { prefix: "/api/storage", plane: "either", note: "Permission-gated file access; an end-user uploading an avatar is the ordinary case." },
  { prefix: "/api/uploads", plane: "either", note: "Resumable (TUS) uploads, permission-gated like /api/storage." },
  { prefix: "/api/folders", plane: "either", note: "Permission-gated." },
  { prefix: "/api/revisions", plane: "either", note: "Permission-gated history of a row the caller may already read." },
  { prefix: "/api/comments", plane: "either", note: "Permission-gated; end-user commenting is a supported shape." },
  { prefix: "/api/realtime", plane: "either", note: "SSE. The realtime filter re-evaluates the subscriber's own permission predicate, so both planes subscribe through one route." },
  {
    prefix: "/api/vector",
    plane: "either",
    note:
      "Permission-gated similarity search. A namespace naming a collection takes that collection's gate; one naming nothing is a per-workspace scratch space. Those two answers are distinguishable (403 vs fall-through), so an app-plane caller can learn WHICH collection slugs exist — a workspace's collection names are DELIBERATELY not treated as secret. See docs/vector-search.md; #333 recorded the decision.",
  },
  { prefix: "/api/notifications", plane: "either", note: "Both planes receive notifications addressed to them." },
  { prefix: "/api/device-tokens", plane: "either", note: "Push registration. An end-user's phone is the primary case." },
  {
    prefix: "/api/geo",
    plane: "either",
    note:
      "Field-editor geocoding, on both planes. `/backfill/{slug}` is " +
      "permission-gated; `/geocode` and `/reverse` are not — they name no " +
      "collection, so there is no permission to gate on. What they DO spend is " +
      "the operator's provider quota, so each carries a per-identity rate limit " +
      "instead (`assertGeoBudget`). This note used to read " +
      "\"permission-gated geocoding helper\", which described one of the three " +
      "verbs and would have told an auditor the other two were covered.",
  },
  { prefix: "/api/phone", plane: "either", note: "Permission-gated E.164 normalisation used by field editors on both planes." },
  { prefix: "/api/email", plane: "either", note: "Permission-gated address normalisation used by field editors on both planes." },

  // `either` ONLY because nothing narrows them today. Each names its decision.
  {
    prefix: "/api/flows",
    plane: "either",
    revisit:
      "requireUser-only today, so an app-plane bearer reaches it. Running an automation is operator work; the open question is whether a manually-triggered flow is a supported end-user action (docs/flows.md describes a `manual` trigger without saying who may pull it).",
  },
  {
    prefix: "/api/jobs",
    plane: "either",
    revisit:
      "requireUser-only today. Enqueueing and retrying jobs reads as operator work, but jobs-run-as exists precisely so a job can act for a non-operator — decide before enforcing.",
  },
  {
    prefix: "/api/functions",
    plane: "either",
    revisit:
      "requireUser-only today. docs/sandbox.md presents functions as an app-facing extension point, so an end-user invoking one may be the intended shape; listing them is not.",
  },
  {
    prefix: "/api/agents",
    plane: "either",
    revisit:
      "requireUser-only today, and an app-plane twin already exists at /api/t/:slug/agents. If the app-plane surface is the supported one, this becomes platform.",
  },
  {
    prefix: "/api/extensions",
    plane: "platform",
    revisit:
      "Moved from `either` by the 2026-09 audit's phase 10. `GET /enabled` and " +
      "`GET /:name/assets/*` now carry `requirePlatformMw`: the first enumerates " +
      "installed extensions and their manifests (including which admin API paths " +
      "each is wired to call), and the second serves the complete entry SOURCE of " +
      "every panel and hook. `requireUser` admitted an app-plane end user to both. " +
      "If an app-plane surface for INVOKING a hook is ever wanted, it belongs at " +
      "`/api/t/:slug/…` with its own gate, not here.",
  },
  {
    prefix: "/api/webhooks",
    plane: "either",
    revisit:
      "requireUser-only today. The OUTBOUND webhook registry is operator configuration and should almost certainly be platform; confirm no SDK surface depends on it first.",
  },
  {
    prefix: "/api/shared-links",
    plane: "either",
    revisit:
      "requireUser-only today. Minting a public link to a record is a capability worth pinning to one plane deliberately rather than by omission.",
  },
  {
    prefix: "/api/messaging",
    plane: "either",
    revisit:
      "requireUser-only today. Sending an SMS or push on the workspace's account is operator work unless an end-user flow is documented to need it.",
  },
  {
    prefix: "/api/phone-numbers",
    plane: "either",
    revisit: "requireUser-only today. Provisioned numbers are workspace infrastructure; likely platform.",
  },

  // ── the catch-all, last by length ───────────────────────────────────────
  {
    prefix: "/api",
    plane: "public",
    note: "openapiRoutes — the OpenAPI document and its viewer. Only matched when nothing longer does, so it is the FALLBACK for this table as well as a mount. A new /api/* mount with no entry above therefore resolves to `public`, which is why the completeness test exists: silence here would read as a deliberate 'anyone may call it'.",
  },
] as const;

/**
 * Sorted once, most-specific first, so lookup is a plain scan.
 *
 * Specificity is SEGMENT COUNT, not string length: `/api/t/*​/auth` has to beat
 * `/api/t` even though a longer literal like `/api/workspace-config` would win
 * on characters. Ties break on length, which keeps the ordering stable and puts
 * a literal segment ahead of a wildcard of the same depth.
 *
 * `exact` and `methods` break the tie BEFORE length, so a qualified entry is
 * consulted ahead of the unqualified one at the same prefix — which is the
 * whole point of a carve-out. It matters only for two entries that share a
 * prefix; everywhere else the qualification fields are absent and the ordering
 * is exactly what it was.
 */
const depth = (p: string): number => p.split("/").filter(Boolean).length;
/** How narrow an entry is, ahead of prefix length. Higher is consulted first. */
const qualifiers = (e: RoutePlaneEntry): number => (e.exact ? 2 : 0) + (e.methods ? 1 : 0);
const BY_LENGTH: readonly RoutePlaneEntry[] = [...ROUTE_PLANES].sort(
  (a, b) =>
    depth(b.prefix) - depth(a.prefix) ||
    qualifiers(b) - qualifiers(a) ||
    b.prefix.length - a.prefix.length,
);

/**
 * Does `path` sit at or under `prefix`, treating `*` as exactly one segment?
 *
 * The wildcard exists for one shape and should stay rare: a mount whose plane
 * changes below a DYNAMIC segment. `/api/t/:slug/auth` is the only such case —
 * a workspace's own sign-in surface is public while everything else under
 * `/api/t` requires an app-plane session — and it cannot be written as a static
 * prefix because the slug is the customer's.
 */
const covers = (prefix: string, path: string): boolean => {
  const p = prefix.split("/");
  const s = path.split("/");
  if (s.length < p.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") {
      // A wildcard matches one non-empty segment, never a missing one.
      if (!s[i]) return false;
      continue;
    }
    if (p[i] !== s[i]) return false;
  }
  return true;
};

/**
 * Does a qualified entry answer for this request?
 *
 * Both checks are AND-ed onto `covers`, and both can only REJECT — an entry
 * that says nothing about methods answers for all of them, which is why adding
 * this dimension changed no existing entry's behaviour.
 *
 * A caller that does not know the method (`planeFor(path)`) skips every
 * method-qualified entry and falls through to the unqualified one. That is the
 * safe direction on purpose: the unqualified entry is the stricter of the pair
 * here, so an unmethodded lookup can under-report a public exception but can
 * never invent one.
 *
 * Exported so `route-plane-registry.test.ts` can ask "would this entry ever be
 * picked?" with the REAL matcher instead of a copy of it. The copy it used to
 * carry disagreed the moment `exact` stopped meaning string equality, which is
 * the whole argument against mirroring a matcher in its own test.
 */
export const applies = (
  entry: RoutePlaneEntry,
  path: string,
  method: string | undefined,
): boolean => {
  if (entry.exact && depth(entry.prefix) !== depth(path)) return false;
  if (entry.methods && (!method || !entry.methods.includes(method.toUpperCase()))) return false;
  return covers(entry.prefix, path);
};

/**
 * The declared plane for a concrete request path.
 *
 * Matches on a path SEGMENT boundary, so `/api/tenants-lookalike` does not
 * inherit `/api/tenants`'s answer. Returns `null` for a path no entry covers —
 * `/health`, `/embed/form.js`, the SPA fallback — which the completeness test
 * treats as "not an /api route" rather than as a hole.
 *
 * Longest prefix wins, counted in SEGMENTS rather than characters, so a
 * wildcard entry is not penalised for the slug it stands in for.
 *
 * `method` is optional and every caller that HAS one should pass it — without
 * it the three method-qualified entries cannot match, and the lookup returns
 * the broader declaration those carve out of. See `applies` for why that
 * direction is the safe one.
 */
export const planeFor = (path: string, method?: string): RoutePlaneEntry | null => {
  for (const entry of BY_LENGTH) {
    if (applies(entry, path, method)) return entry;
  }
  return null;
};
