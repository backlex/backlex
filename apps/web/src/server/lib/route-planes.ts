/**
 * Which auth plane each mounted route prefix belongs to.
 *
 * WHY THIS FILE EXISTS
 *
 * backlex has two auth planes — `"platform"` (operators running the dashboard)
 * and `"app"` (a workspace's own end-users) — and today the boundary between
 * them is upheld almost everywhere by an ACCIDENT rather than a check:
 * `tenantMiddleware` leaves `auth.roles` empty for `plane === "app"`, so
 * `requireAdminMw` denies. `requireUser` alone checks only `auth.userId`, which
 * an `app_users` id satisfies just as well as a `users` id. `requirePlatformMw`
 * — the gate written for exactly this — is applied to a handful of route files
 * out of the ~110 prefixes below.
 *
 * The highest-value invariant in a two-plane product should not rest on an
 * empty array one line away from being populated. This table is the first half
 * of fixing that: a single declared answer per prefix, checked for completeness
 * by `apps/web/tests/route-plane-registry.test.ts` so a new mount cannot land
 * without one. The second half — a middleware that ENFORCES the declaration —
 * is deliberately not here. This file changes no runtime behaviour at all.
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
}

/**
 * Ordered longest-prefix-wins. `planeFor` sorts by descending prefix length, so
 * declaration order here is for humans; `/api/admin/settings` beats `/api`
 * regardless of where each sits in the list.
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
    prefix: "/api/t",
    plane: "app",
    note: "The rest of the per-workspace end-user surface: orgs, agents. tenantMiddleware pins these to the workspace stamped on the session and ignores X-Backlex-Tenant.",
  },

  // ── platform plane ──────────────────────────────────────────────────────
  { prefix: "/api/tenants", plane: "platform", note: "Workspace CRUD, membership and invites. POST / is requireUser-only today — the single most load-bearing missing plane gate in the app." },
  { prefix: "/api/users", plane: "platform", note: "Platform-user administration." },
  { prefix: "/api/app-users", plane: "platform", note: "OPERATOR view of the end-user pool. The end-users' own surface is /api/t." },
  { prefix: "/api/app-orgs", plane: "platform", note: "OPERATOR view of organizations. The org members' own surface is /api/t/:slug/orgs." },
  { prefix: "/api/roles", plane: "platform" },
  { prefix: "/api/permissions", plane: "platform" },
  { prefix: "/api/api-keys", plane: "platform", note: "Mints pak_ keys, which session.ts resolves on the PLATFORM plane. An app-plane caller reaching this laundered itself across the boundary." },
  { prefix: "/api/activity", plane: "platform", note: "The audit log." },
  { prefix: "/api/admin", plane: "platform", note: "Every /api/admin/* mount. Longest-prefix means each specific one below is redundant, which is the point: a new /api/admin/* mount inherits the right answer without touching this file." },
  { prefix: "/api/workspace-config", plane: "platform", note: "Workspace-level configuration the operator edits." },
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
  { prefix: "/api/vector", plane: "either", note: "Permission-gated similarity search." },
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
 */
const depth = (p: string): number => p.split("/").filter(Boolean).length;
const BY_LENGTH: readonly RoutePlaneEntry[] = [...ROUTE_PLANES].sort(
  (a, b) => depth(b.prefix) - depth(a.prefix) || b.prefix.length - a.prefix.length,
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
 * The declared plane for a concrete request path.
 *
 * Matches on a path SEGMENT boundary, so `/api/tenants-lookalike` does not
 * inherit `/api/tenants`'s answer. Returns `null` for a path no entry covers —
 * `/health`, `/embed/form.js`, the SPA fallback — which the completeness test
 * treats as "not an /api route" rather than as a hole.
 *
 * Longest prefix wins, counted in SEGMENTS rather than characters, so a
 * wildcard entry is not penalised for the slug it stands in for.
 */
export const planeFor = (path: string): RoutePlaneEntry | null => {
  for (const entry of BY_LENGTH) {
    if (covers(entry.prefix, path)) return entry;
  }
  return null;
};
