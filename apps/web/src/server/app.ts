import type { AuthPlane, OrgRole } from "@backlex/core";
import { createD1SessionClient } from "@backlex/db/sqlite";
import { sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { buildContext, type Ctx } from "./context";
import type { Env } from "./env";
import { apiRateLimitMiddleware } from "./lib/api-rate-limit";
import { usageMeterMiddleware } from "./lib/usage-meter";
import { authLockoutMiddleware, authRateLimitMiddleware } from "./lib/auth-rate-limit";
import { passwordVerificationHookMiddleware } from "./lib/auth-hook-middleware";
import { configureLogBuffer, configureLogLevel, levelForStatus, log } from "./lib/log";
import {
  type TraceContext,
  deriveTraceContext,
  formatTraceparent,
} from "./lib/trace";
import { recordSpan, traceSampleRate } from "./services/traces";
import { exportSpanOtlp, otlpEnabled } from "./services/otlp";
import { flushLogsOtlp } from "./services/otlp-logs";
import { isDemoMode } from "./services/demo";
import { demoGuardMiddleware } from "./middleware/demo";
import { errorHandler } from "./middleware/error";
import type { PermissionVar } from "./middleware/permission";
import { sessionMiddleware } from "./middleware/session";
import { tenantMiddleware } from "./middleware/tenant";
import { accountRoutes } from "./routes/account";
import { activityRoutes } from "./routes/activity";
import { tracesRoutes } from "./routes/traces";
import { adoptRoutes } from "./routes/adopt";
import { migrateRoutes } from "./routes/migrate";
import { advisorRoutes } from "./routes/advisor";
import { analyticsRoutes } from "./routes/analytics";
import { tagManagerRoutes } from "./routes/tag-manager";
import { consentRoutes } from "./routes/consent";
import { consentPublicRoutes } from "./routes/consent-public";
import { isPerSiteScript, isPublicSubresource } from "./lib/public-paths";
import { analyticsCollectRoutes, siteScriptRoutes } from "./routes/analytics-collect";
import { analyticsIngestRoutes } from "./routes/analytics-ingest";
import { aiAskRoutes } from "./routes/ai-ask";
import { agentsRoutes } from "./routes/agents";
import { apiKeysRoutes } from "./routes/api-keys";
import { appUsersRoutes } from "./routes/app-users";
import { appOrgsRoutes } from "./routes/app-orgs";
import { appAgentsPublicRoutes } from "./routes/app-agents-public";
import { appOrgsPublicRoutes } from "./routes/app-orgs-public";
import { authRoutes } from "./routes/auth";
import { authAdminRoutes } from "./routes/auth-admin";
import { authPublicRoutes } from "./routes/auth-public";
import { platformAuthRoutes } from "./routes/platform-auth";
import { collectionsRoutes } from "./routes/collections";
import { commentsRoutes } from "./routes/comments";
import { dbAdminRoutes } from "./routes/db-admin";
import { emailConfigRoutes } from "./routes/email-config";
import { emailTemplatesRoutes } from "./routes/email-templates";
import { documentsRoutes } from "./routes/documents";
import { geoRoutes } from "./routes/geo";
import { emailFieldRoutes } from "./routes/email-fields";
import { phoneRoutes } from "./routes/phone";
import { flowsRoutes } from "./routes/flows";
import { foldersRoutes } from "./routes/folders";
import { functionsRoutes } from "./routes/functions";
import { extensionsRoutes } from "./routes/extensions";
import { i18nRoutes } from "./routes/i18n";
import { i18nPublicRoutes } from "./routes/i18n-public";
import { integrationsRoutes } from "./routes/integrations";
import { itemsRoutes } from "./routes/items";
import { ldapAdminRoutes } from "./routes/ldap-admin";
import { adminMcpRoutes, tenantMcpRoutes } from "./routes/mcp";
import { jwksRoutes } from "./routes/jwks";
import { mcpAuthorizeConsentGate, mcpOAuthWellKnownRoutes } from "./routes/mcp-oauth";
import { meRoutes } from "./routes/me";
import { metricsRoutes } from "./routes/metrics";
import { usageRoutes } from "./routes/usage";
import { notificationsRoutes } from "./routes/notifications";
import { deviceTokensRoutes } from "./routes/device-tokens";
import { pushConfigRoutes } from "./routes/push-config";
import { pushTemplatesRoutes } from "./routes/push-templates";
import { phoneNumbersRoutes } from "./routes/phone-numbers";
import { smsConfigRoutes } from "./routes/sms-config";
import { aiConfigRoutes } from "./routes/ai-config";
import { messagingRoutes } from "./routes/messaging";
import { jobsRoutes } from "./routes/jobs";
import { openapiRoutes } from "./routes/openapi";
import { panelsRoutes } from "./routes/panels";
import { paymentsRoutes } from "./routes/payments";
import { paymentsPublicRoutes } from "./routes/payments-public";
import { integrationsPublicRoutes } from "./routes/integrations-public";
import { dashboardsRoutes } from "./routes/dashboards";
import { kpisRoutes } from "./routes/kpis";
import { schemaVersionsRoutes } from "./routes/schema-versions";
import { dashboardsPublicRoutes } from "./routes/dashboards-public";
import { formsRoutes } from "./routes/forms";
import { formsPublicRoutes } from "./routes/forms-public";
import { approvalsPublicRoutes } from "./routes/approvals-public";
import { signaturesPublicRoutes } from "./routes/signatures-public";
import { approvalsRoutes } from "./routes/approvals";
import { signaturesRoutes } from "./routes/signatures";
import { bookingPublicRoutes } from "./routes/booking-public";
import { bookingRoutes } from "./routes/booking";
import { realtimeRoutes } from "./routes/realtime";
import { realtimeAdminRoutes } from "./routes/realtime-admin";
import { revisionsRoutes } from "./routes/revisions";
import {
  permissionsRoutes,
  rolesRoutes,
  usersRoutes,
} from "./routes/roles";
import { samlAdminRoutes } from "./routes/saml-admin";
import { thirdPartyAuthAdminRoutes } from "./routes/third-party-auth-admin";
import { oidcAdminRoutes } from "./routes/oidc-admin";
import { scimAdminRoutes } from "./routes/scim-admin";
import { syncHooksRoutes } from "./routes/sync-hooks";
import { authHooksRoutes } from "./routes/auth-hooks";
import { realtimeChannelsRoutes } from "./routes/realtime-channels";
import { rlsRoutes } from "./routes/rls";
import { s3Routes } from "./routes/s3";
import { s3CredentialsRoutes } from "./routes/s3-credentials";
import { captchaRoutes } from "./routes/captcha";
import { impersonationRoutes } from "./routes/impersonation";
import { signingKeysRoutes } from "./routes/signing-keys";
import { oauthClientsRoutes } from "./routes/oauth-clients";
import { cdcRoutes } from "./routes/cdc";
import { dynamicRegistrationGate } from "./lib/oauth-registration-gate";
import { captchaMiddleware } from "./lib/captcha-middleware";
import { erasureRoutes } from "./routes/erasure";
import { scimRoutes } from "./routes/scim";
import { platformSamlAdminRoutes } from "./routes/platform-saml-admin";
import { platformLdapAdminRoutes } from "./routes/platform-ldap-admin";
import { sandboxRpcRoutes } from "./routes/sandbox-rpc";
import { settingsRoutes } from "./routes/settings";
import { sharedLinksRoutes } from "./routes/shared-links";
import { sharedPublicRoutes } from "./routes/shared-public";
import { FILES_COLLECTION, storageRoutes } from "./routes/storage";
import { uploadsRoutes, tusBaseHeaders } from "./routes/uploads";
import { uploadPolicy } from "./services/uploads";
import { flagsPublicRoutes, flagsAdminRoutes } from "./routes/feature-flags";
import { templatesRoutes } from "./routes/templates";
import { demoRoutes } from "./routes/demo";
import { tenantAuthRoutes } from "./routes/tenant-auth";
import { tenantsRoutes } from "./routes/tenants";
import { vectorRoutes } from "./routes/vector";
import { webhookTriggerRoutes } from "./routes/webhook-trigger";
import { webhooksRoutes } from "./routes/webhooks";
import { workspaceConfigRoutes } from "./routes/workspace-config";
import {
  isWorkspaceAllowedOrigin,
  refreshAllowedOriginsIfStale,
  warmAllowedOrigins,
} from "./services/cors-origins";
import type { PermResolveCache } from "./services/permissions";
import {
  ensureDefaultTenant,
  ensureSystemRoles,
  seedEmailTemplates,
  seedOwnerScopedPermissions,
} from "./services/seed";

export type AppBindings = {
  Variables: {
    ctx: Ctx;
    auth: {
      /** Which auth plane this identity belongs to — see {@link AuthPlane}.
       *  `"platform"` for admin-app / control-plane sessions and API keys;
       *  `"app"` for workspace end-users authenticated via a tenant's own
       *  auth service. Always `"platform"` until the tenant-auth surface
       *  ships. */
      plane: AuthPlane;
      userId: string | null;
      email: string | null;
      roles: string[];
      /** Resolved by tenantMiddleware. Null only on /api/auth and /health. */
      tenantId?: string | null;
      /** Set by sessionMiddleware when the request authenticates with a
       *  bearer API key — the key's home tenant wins over user.activeTenantId
       *  so machine-to-machine calls always land in the right workspace. */
      apiKeyTenantId?: string | null;
      /** Set by sessionMiddleware when the bearer API key is scoped to a
       *  single role. tenantMiddleware narrows `roles` to that role and the
       *  permission resolver evaluates against it alone. Null/absent = the
       *  key carries the owner's full role set. */
      apiKeyRoleId?: string | null;
      /** The PAK row id. Surfaced so MCP dispatcher / audit logging can
       *  attribute requests back to a specific key without re-querying. */
      apiKeyId?: string | null;
      /** Per-key MCP tool allowlist. `null` = unrestricted (all tools the
       *  server exposes are callable). `[]` = zero tools (deny everything).
       *  An array = only the listed tool names are callable. The MCP layer
       *  enforces this; REST routes ignore it. */
      apiKeyMcpTools?: string[] | null;
      /** When true, the MCP layer rejects every write tool for this key
       *  (insert / update / delete / grant / revoke / invoke / assign / etc.).
       *  REST routes are unaffected. */
      apiKeyMcpReadOnly?: boolean;
      /** Per-key requests-per-minute cap from `api_keys.rate_limit_per_minute`.
       *  Null/absent = the shared global budget. Enforced by the global API
       *  limiter even on deploys where that limiter is otherwise disabled. */
      apiKeyRateLimit?: number | null;
      /** Per-key monthly request quota from `api_keys.monthly_quota`. Checked
       *  by the usage meter against the `usage_counters` ledger; over-quota
       *  requests get 429 QUOTA_EXCEEDED. Null/absent = unmetered. */
      apiKeyMonthlyQuota?: number | null;
      /** Set by sessionMiddleware when the request authenticates with a
       *  workspace end-user bearer token (plane = "app"). The session row
       *  carries the issuing workspace; we pin the request to it so the
       *  customer's app never needs to send `X-Backlex-Tenant`. */
      appSessionTenantId?: string | null;
      /** `app_sessions.id` behind an app-plane request (from the access JWT's
       *  `sid`, or the row the bearer/cookie token matched). Lets the org layer
       *  read and write the session's pinned `active_org_id`. */
      appSessionId?: string | null;
      /** App-plane organization context, resolved by tenantMiddleware. Feeds
       *  `$org.id` / `$org.role` / `$user.orgs` in the permission DSL and the
       *  org-scoped role grants in `loadRolesForUser`. See
       *  `services/app-orgs.ts::resolveOrgContext` and docs/app-organizations.md. */
      orgId?: string | null;
      orgRole?: OrgRole | null;
      orgIds?: string[];
      /** Set by sessionMiddleware when the request authenticates with an MCP
       *  OAuth access token (better-auth `mcp` plugin — hosted Claude et al).
       *  Carries the OAuth client id for auditing; guard behavior rides the
       *  `apiKeyMcp*` fields (readOnly derives from the token's scopes). */
      oauthClientId?: string | null;
      /** Set by sessionMiddleware when the request is an operator ACTING AS one
       *  of the workspace's end-users. The identity is genuinely the subject's;
       *  these fields carry who is behind it so the audit trail names both, and
       *  `impersonationReadOnly` is what the write gate reads. See
       *  `services/impersonation.ts` and docs/impersonation.md. */
      impersonatedBy?: string | null;
      impersonationId?: string | null;
      impersonationReadOnly?: boolean;
    };
    /** Correlation id for this request. Taken from an inbound `x-request-id`
     *  (trusted proxy / client), else `cf-ray` on Workers, else a generated
     *  UUID. Echoed back on the `x-request-id` response header, stamped onto
     *  every structured log line for the request, and surfaced in error
     *  responses so support can trace a single call end-to-end. */
    requestId: string;
    /** W3C trace context for this request — continued from an inbound
     *  `traceparent` (SDK / upstream service) or freshly started here. The
     *  `traceId` is shared across every hop of one logical operation; `spanId`
     *  identifies this request's span; `parentSpanId` is the caller's span (null
     *  when this request started the trace). Echoed on the `traceparent`
     *  response header, stamped on the access log, persisted as a span row, and
     *  re-emitted on downstream calls (functions) so traces stitch together. */
    trace: TraceContext;
    /** Error code (e.g. `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL`) stashed by the
     *  global error handler so the single access-log line can carry it. Unset
     *  for successful responses. */
    errorCode?: string;
    /** Workspace to bill this request to when it carries no authenticated
     *  identity — set by public handlers (`setMeterTenant`) once they've
     *  resolved the row that owns the request (flow, embed token, form). The
     *  usage meter falls back to it so public surfaces are metered and
     *  quota-checked like the rest of the data API. */
    meterTenantId?: string | null;
    permission: PermissionVar;
    /** Per-request L1 permission cache. Lazily initialized by the first
     *  `requirePermission` (or any explicit `getRequestPermCache(c)` call)
     *  and reused by subsequent `resolvePermission` calls in the same
     *  request — GraphQL, expand, shared-links, etc. — so a single request
     *  never hits the same `(collection, action)` lookup twice. */
    permCache?: PermResolveCache;
    /** Per-request phase timings (ms), emitted as a `Server-Timing` response
     *  header. `_t0` is the worker-entry timestamp; other keys are durations.
     *  Used to attribute latency (dispatch vs ctx vs middleware vs route). */
    __st?: Record<string, number>;
    /** Which collection + local columns an item-list request filtered and
     *  sorted on. Set by the list handler once the query is parsed and folded
     *  into the span's `attributes` below, so the advisor's runtime rules can
     *  suggest indexes for the columns traffic actually uses. Column names
     *  only — no filter values are ever recorded. */
    queryShape?: { collection: string; filters: string[]; sorts: string[] };
  };
};

let rolesSeeded = false;

/** Wrap a middleware to record its OWN time (excluding the downstream `next()`
 *  it triggers) into the per-request Server-Timing collector under `name`.
 *  Diagnostic — lets us split `premw` into cors/session/tenant. */
/** Liveness + readiness. Polled constantly by uptime monitors and load
 *  balancers, so they are logged at debug — and they run BEFORE session/tenant
 *  resolution, so a probe can still answer when the database cannot. */
const PROBE_PATHS = ["/health", "/health/ready"];

/**
 * Did the readiness probe fail because the database is unreachable, or because
 * it is reachable and simply has no schema yet?
 *
 * The distinction is the whole point of the probe: a deployment whose
 * migrations were never applied answers `SELECT 1` perfectly well and then
 * 500s on every real request, so "reachable" alone reported it healthy.
 *
 * Drivers disagree about where the message lands — D1 puts it on `cause`,
 * bun:sqlite on `message` — so both are read. Postgres says
 * `relation "tenants" does not exist`; SQLite and D1 say `no such table`.
 */
export const classifyDbProbeError = (
  e: unknown,
): { reachable: boolean; text: string } => {
  const err = e as { message?: string; cause?: unknown } | null;
  const causeText =
    (err?.cause as { message?: string } | undefined)?.message ??
    (err?.cause == null ? "" : String(err.cause));
  const text = `${err?.message ?? ""} ${causeText}`.trim();
  return {
    reachable: /no such table|does not exist|undefined_table/i.test(text),
    text,
  };
};

const timed =
  (name: string, mw: MiddlewareHandler<AppBindings>): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    const st = c.get("__st");
    const start = performance.now();
    let downstream = 0;
    // Propagate the wrapped middleware's return value: short-circuiting
    // middlewares (e.g. `cors` on an OPTIONS preflight) return a `Response`
    // instead of calling `next()`. Dropping it leaves the context unfinalized
    // ("Context is not finalized" → 500 on every OPTIONS), so we must return it.
    const res = await mw(c, async () => {
      const d0 = performance.now();
      await next();
      downstream += performance.now() - d0;
    });
    if (st) st[name] = performance.now() - start - downstream;
    return res;
  };

export const createApp = (env: Env) => {
  // Main app stays as plain Hono — `OpenAPIHono.route(...)` chains the tag
  // tree types of every sub-app together, which can blow past TS heap
  // limits in a large repo. The sub-apps that ARE `OpenAPIHono` still
  // expose their `openAPIRegistry`; `mountOpenapiRoutes` collects them
  // explicitly to build the doc.
  const app = new Hono<AppBindings>();

  // Set the structured-log threshold once per isolate from env (default info).
  configureLogLevel(env.LOG_LEVEL);
  // Only buffer when there is a collector to buffer FOR — otherwise it is a
  // per-isolate memory cost with no consumer.
  configureLogBuffer(otlpEnabled(env));

  // Outermost middleware: assign a correlation id and emit the SINGLE structured
  // JSON access line per request. Runs first so `requestId` is available to
  // every downstream layer (ctx build, error handler) and the timing wraps the
  // whole request. When a downstream handler throws, Hono's `onError`
  // (middleware/error.ts) runs and the outer `await next()` below still resolves
  // normally — so this line fires for thrown errors too. The error handler does
  // NOT log its own line; it only stashes `errorCode` (read here) so each
  // request produces exactly one access line, success or failure.
  app.use("*", async (c, next) => {
    const reqId =
      c.req.header("x-request-id") ||
      c.req.header("cf-ray") ||
      crypto.randomUUID();
    c.set("requestId", reqId);
    // Continue an inbound W3C trace (SDK / upstream service) or start a fresh
    // one. We sample 100% — the per-request span write is non-blocking and the
    // table is pruned, so the cost is a fire-and-forget insert, not latency.
    const trace = deriveTraceContext(c.req.header("traceparent"), true);
    c.set("trace", trace);
    const start = Date.now();
    await next();
    c.res.headers.set("x-request-id", reqId);
    // Re-advertise the trace so a browser/SDK can correlate its call, and so a
    // downstream that read our response continues the same trace.
    c.res.headers.set("traceparent", formatTraceparent(trace));
    let path: string;
    try {
      path = new URL(c.req.url).pathname;
    } catch {
      path = c.req.path;
    }
    // Log probes at debug so they don't drown the access log by default
    // (visible only under LOG_LEVEL=debug). See PROBE_PATHS.
    const isProbe = PROBE_PATHS.includes(path);
    const status = c.res.status;
    const level = isProbe ? "debug" : levelForStatus(status);
    let auth: { tenantId?: string | null; userId?: string | null } | undefined;
    try {
      auth = c.get("auth");
    } catch {
      auth = undefined;
    }
    const ms = Date.now() - start;
    const code = c.get("errorCode");
    log[level]("request", {
      requestId: reqId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      method: c.req.method,
      path,
      status,
      ms,
      tenantId: auth?.tenantId ?? null,
      userId: auth?.userId ?? null,
      // Present only on error responses (stashed by the global error handler).
      code,
    });
    // Ship the lines this request produced. Deliberately OUTSIDE the trace
    // sampling gate below: logs and traces do not share a sampling story, and
    // at any rate under 1 most requests would never flush — the buffer would
    // fill and start dropping lines that were never exported. Each line still
    // carries `traceId`, so a collector joins it to its span when there is one.
    if (otlpEnabled(env)) {
      const flush = flushLogsOtlp(env);
      try {
        c.executionCtx?.waitUntil?.(flush);
      } catch {
        void flush;
      }
    }
    // Persist the span for the admin Traces panel. Probes are skipped, as are
    // the traces endpoints themselves (avoid a self-referential feedback loop).
    // Non-blocking: never add latency or fail the request over telemetry.
    if (!isProbe && !path.startsWith("/api/admin/traces")) {
      let ctx: Ctx | undefined;
      try {
        ctx = c.get("ctx");
      } catch {
        ctx = undefined;
      }
      if (ctx && Math.random() < traceSampleRate(ctx.env)) {
        let shape: { collection: string; filters: string[]; sorts: string[] } | undefined;
        try {
          shape = c.get("queryShape");
        } catch {
          shape = undefined;
        }
        const spanInput = {
          trace,
          name: `${c.req.method} ${path}`,
          method: c.req.method,
          path,
          status,
          durationMs: ms,
          startedAt: start,
          tenantId: auth?.tenantId ?? null,
          userId: auth?.userId ?? null,
          errorCode: code,
          queryShape: shape,
        };
        // Same sampled span feeds the local table AND (when OTLP_ENDPOINT is
        // set) the external OpenTelemetry collector. Both never throw.
        // Same sampled span feeds the local table AND (when OTLP_ENDPOINT is
        // set) the external OpenTelemetry collector. Both never throw.
        const write = otlpEnabled(ctx.env)
          ? Promise.all([
              recordSpan(ctx, spanInput).catch(() => {}),
              exportSpanOtlp(ctx.env, spanInput),
            ]).then(() => {})
          : recordSpan(ctx, spanInput).catch(() => {});
        // `c.executionCtx` is a getter that THROWS on non-Workers runtimes
        // (Bun/Vercel/Netlify) — guard it, then fall back to fire-and-forget.
        try {
          c.executionCtx?.waitUntil?.(write);
        } catch {
          void write;
        }
      }
    }
  });

  // Per-request phase timing → `Server-Timing` response header. Gated behind a
  // secret header (`x-backlex-timing: $DEBUG_TIMING_SECRET`) so the diagnostic
  // is on-demand for ops (curl) and never publicly discloses internal phase
  // latencies. When off (default — no secret, or header mismatch) `__st` is
  // never set, so the `timed()` wrappers + ctx/d1 marks all no-op (`if (st)`)
  // and nothing is collected or emitted. `total` captures whole instance-worker
  // time; vs external ttfb + ICMP RTT it isolates dispatch (WfP) overhead.
  app.use("*", async (c, next) => {
    const on =
      !!env.DEBUG_TIMING_SECRET &&
      c.req.header("x-backlex-timing") === env.DEBUG_TIMING_SECRET;
    if (!on) {
      await next();
      return;
    }
    const t0 = performance.now();
    const st: Record<string, number> = { _t0: t0 };
    c.set("__st", st);
    await next();
    const total = performance.now() - t0;
    const parts = [`total;dur=${total.toFixed(1)}`];
    for (const k of ["ctx", "d1", "cors", "session", "tenant", "premw"]) {
      const v = st[k];
      if (v !== undefined) parts.push(`${k};dur=${v.toFixed(1)}`);
    }
    c.res.headers.set("Server-Timing", parts.join(", "));
  });

  /**
   * The surfaces meant to be iframed from anywhere.
   *
   * ONE predicate, read by both the X-Frame-Options strip below and the CSP
   * choice further down. They have to agree: a path with `frame-ancestors *`
   * but a surviving `X-Frame-Options: SAMEORIGIN` is still blocked, and the
   * two lists drifted apart the moment the booking pages joined only one.
   *
   * - `/embed/*` — the dashboard embed and the form's embed variant.
   * - `/api/public/*` — the data those pages fetch once framed.
   * - `/book/*`, `/b/*` — the booking pages. Unlike a form, whose standalone
   *   page stays same-origin-only, BOTH of these belong on the operator's own
   *   site, so there is no separate embed URL for them at all.
   */
  const isFramable = (path: string): boolean =>
    path.startsWith("/embed/") ||
    path.startsWith("/api/public/") ||
    path.startsWith("/book/") ||
    path.startsWith("/b/");

  // `isPublicSubresource` lives in `lib/public-paths.ts` now, because a
  // SECOND caller appeared: `middleware/tenant.ts` must skip the workspace
  // cookie on exactly these paths. The full reasoning — CORP, shared-cache
  // suppression, and consent — is written down there.

  // Registered BEFORE secureHeaders so its post-phase runs LAST (Hono runs
  // post-middleware in reverse registration order) — this is the only place we
  // can reliably override the headers that secureHeaders() sets. Two of them:
  // the X-Frame-Options on framable embed surfaces (the CSP `frame-ancestors *`
  // set below already makes modern browsers ignore XFO, but we drop it for
  // older agents too), and the CORP above.
  app.use("*", async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    if (isFramable(path)) c.res.headers.delete("x-frame-options");
    if (isPublicSubresource(path)) {
      c.res.headers.set("cross-origin-resource-policy", "cross-origin");
    }
  });

  app.use("*", secureHeaders());

  // Content-Security-Policy. `secureHeaders()` sets HSTS/XFO/nosniff/etc. but
  // NOT a CSP, so the admin SPA shipped without one — any stored-XSS sink
  // (collection/comment/AI-rendered content) would run with no mitigation.
  // `script-src 'self'` (no 'unsafe-inline') is the core protection: injected
  // inline scripts simply won't execute. Styles keep 'unsafe-inline' (React /
  // Tailwind inject style attributes); img/connect stay broad (R2 assets,
  // same-origin API + SSE/WS, cross-origin VITE_API_URL setups). GraphiQL
  // (served at GET /api/graphql) bootstraps from a CDN + inline, so that one
  // route gets a relaxed policy.
  const STRICT_CSP = [
    "default-src 'self'",
    // static.cloudflareinsights.com: Cloudflare Web Analytics (RUM) is
    // auto-injected at the zone proxy on Cloudflare-fronted deploys (e.g. the
    // playground + cloud tenants on the backlex.com zone); without the
    // allowance the beacon is blocked and every page logs CSP errors. The
    // origin serves only CF's own beacon script, so the stored-XSS posture of
    // 'self'-only is unchanged. Inert on non-Cloudflare deploys. (CF's inline
    // iframe-fallback loader stays blocked — per-response hash, harmless.)
    "script-src 'self' https://static.cloudflareinsights.com",
    // 'unsafe-inline' for styles: React/Tailwind set style attributes. Google
    // Fonts stylesheet host is allow-listed (the admin loads Geist from it).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
  const GRAPHIQL_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
    "img-src 'self' data: https:",
    "font-src 'self' data: https://unpkg.com https://cdn.jsdelivr.net",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
  // Embedded BI dashboards are meant to be iframed on third-party sites, so the
  // public embed page (`/embed/...`) and its data API (`/api/public/...`) must
  // allow framing from any origin — `frame-ancestors *` plus dropping the
  // X-Frame-Options secureHeaders() set (XFO has no allow-all value, so its
  // mere presence as SAMEORIGIN/DENY would block the frame). Everything else
  // keeps the strict same-origin policy.
  const EMBED_CSP = STRICT_CSP.replace("frame-ancestors 'self'", "frame-ancestors *");
  // Public form pages (`/f/<token>`, `/embed/f/<token>`) may render the
  // Cloudflare Turnstile widget, which loads a script from and frames
  // challenges.cloudflare.com — both blocked by the strict `'self'` policy.
  // The standalone page keeps `frame-ancestors 'self'`; the embed variant
  // inherits the framable base.
  const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
  const withTurnstile = (csp: string): string =>
    `${csp.replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`)}; frame-src 'self' ${TURNSTILE_ORIGIN}`;
  const FORM_CSP = withTurnstile(STRICT_CSP);
  const FORM_EMBED_CSP = withTurnstile(EMBED_CSP);
  // In dev the embed page is served through the Worker but its HTML is Vite's
  // transformed shell, which carries an INLINE React-refresh preamble script —
  // a strict `script-src 'self'` would block it (preamble never installs →
  // blank page). Prod's built shell has no inline scripts, so it keeps the
  // strict policy. So: no CSP on the embed page in dev only.
  const isDevServer = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  app.use("*", async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    const isGraphiql = c.req.method === "GET" && path === "/api/graphql";
    // Same predicate the X-Frame-Options strip uses — see `isFramable`. On
    // Cloudflare this middleware is the only place a framable policy can come
    // from: the static `_headers` file can only ever ADD to a policy, and a
    // browser enforces the strictest of duplicate CSPs.
    const isEmbed = isFramable(path);
    const isFormPage = path.startsWith("/f/") || path.startsWith("/embed/f/");
    // Extension iframe entries set their own inline-only CSP in the route
    // (default-src 'none'; script-src 'unsafe-inline') — don't overwrite it.
    if (/^\/api\/extensions\/[^/]+\/assets\//.test(path)) return;
    // Authorize.net's Accept Hosted bridge sets its own policy, and has to:
    // redeeming a form token means POSTing it cross-origin from an inline
    // script, and STRICT_CSP forbids both (`form-action 'self'` alone would
    // make the page silently do nothing). Its policy is narrower than this one
    // everywhere else — `default-src 'none'`, one script named by hash, and
    // exactly the two Authorize.net origins as form targets.
    //
    // Conditioned on the header actually being there, so a 404 or an error
    // rendered under that path still gets the strict policy rather than none.
    if (
      c.res.headers.has("content-security-policy") &&
      path.startsWith("/api/payments/authorizenet/")
    ) {
      return;
    }
    // Routes that stream user-uploaded bytes opt into an inert sandbox policy
    // of their own (`default-src 'none'; sandbox` — see
    // services/storage/content-type.ts). Replacing it with STRICT_CSP would
    // hand those responses `script-src 'self'` back, and uploaded objects are
    // same-origin — precisely the stored-XSS path the sandbox closes.
    if (c.res.headers.get("content-security-policy")?.includes("sandbox")) return;
    if (
      isDevServer &&
      (path.startsWith("/embed/") ||
        path.startsWith("/f/") ||
        path.startsWith("/book/") ||
        path.startsWith("/b/"))
    ) {
      // Dev-only: the Worker-served SPA shell carries Vite's inline
      // React-refresh preamble, which `script-src 'self'` would block.
      c.res.headers.delete("content-security-policy");
    } else {
      c.res.headers.set(
        "content-security-policy",
        isGraphiql
          ? GRAPHIQL_CSP
          : isFormPage
            ? isEmbed
              ? FORM_EMBED_CSP
              : FORM_CSP
            : isEmbed
              ? EMBED_CSP
              : STRICT_CSP,
      );
    }
    if (isEmbed) c.res.headers.delete("x-frame-options");
  });

  // Build the per-request context *before* CORS so the CORS origin check can
  // read the active workspace set. `buildContext` is memoized per isolate
  // (createAuth + adapter setup happens once); the one-time role/seed bootstrap
  // is gated by a module flag.
  //
  // On D1 we open a per-request Sessions-API client so reads can hit the
  // nearest replica. The bookmark from the previous request (sent back on
  // `x-d1-bookmark`) is fed to `withSession` so cross-request read-your-writes
  // is preserved — see CF's "Use Sessions API" pattern. The base Ctx (and the
  // better-auth instance it carries) stays bound to the original D1 binding —
  // better-auth's own DB writes route to primary, while route handlers use
  // the session-bound `ctx.db` and get replica reads.
  app.use("*", async (c, next) => {
    const st = c.get("__st");
    const tc = performance.now();
    const baseCtx = await buildContext(env);
    if (st) st.ctx = performance.now() - tc;
    let ctx: Ctx = baseCtx;
    let session: { getBookmark: () => string | null } | null = null;
    if (env.D1) {
      // Read the prior bookmark (if any); fall back to `first-unconstrained`
      // so CF picks the nearest replica when no anchor is provided. Mutations
      // always route to primary regardless of the constraint.
      const constraint = c.req.header("x-d1-bookmark") ?? "first-unconstrained";
      const td = performance.now();
      const s = createD1SessionClient(env.D1, constraint);
      if (st) st.d1 = performance.now() - td;
      session = s;
      ctx = { ...baseCtx, db: s.db };
    }
    c.set("ctx", ctx);
    if (!rolesSeeded) {
      // Set optimistically so a burst of concurrent first-requests on a cold
      // isolate doesn't each run the bootstrap.
      rolesSeeded = true;
      const dbCtx = { db: ctx.db, dialect: ctx.dialect };
      // Prime the cross-origin allow-list before the CORS middleware runs on
      // this same first request — otherwise the first cross-origin call after
      // a cold isolate start would miss the workspace redirect-URL origins.
      // One cheap SELECT; stays on the critical path.
      await warmAllowedOrigins(dbCtx);
      // The rest is idempotent bootstrap seeding. On an already-provisioned
      // instance (every cold isolate after the first ever) it's ~11 no-op
      // SELECTs that needlessly blocked the first request ~110ms — traced on a
      // cold /api/collections. Defer it off the critical path; `waitUntil` keeps
      // the isolate alive until it finishes. The genuine first-user bootstrap is
      // also performed in context.ts, so deferring here is safe. Tests / runtimes
      // without an ExecutionContext fall back to awaiting inline (deterministic).
      const seed = async () => {
        const defaultTenantId = await ensureDefaultTenant(dbCtx);
        await ensureSystemRoles(dbCtx, defaultTenantId);
        await seedOwnerScopedPermissions(dbCtx, defaultTenantId, FILES_COLLECTION);
        await seedEmailTemplates(dbCtx);
      };
      // Typed by what is actually used, not by the platform interface. The
      // global `ExecutionContext` grows over time — workers-types v5 added
      // `tracing` and `abort` — while Hono's `c.executionCtx` tracks its own
      // definition, so naming the full type here makes an unrelated types bump
      // a compile error about properties nobody calls. The same structural
      // shape is what `entries/worker.ts` and the agent background hook use.
      let ec: { waitUntil: (p: Promise<unknown>) => void } | undefined;
      try {
        ec = c.executionCtx;
      } catch {
        ec = undefined;
      }
      if (ec) {
        ec.waitUntil(seed().catch(() => {}));
        // Pre-warm the lazily-chunked GraphQL handler in the background, once per
        // cold isolate. GraphQL is a first-class data API here — a customer app
        // may use it exclusively — so we don't want its 452K chunk parsed inside
        // the first /api/graphql request (a p99 spike on every cold isolate).
        // Parsing it off the critical path keeps cold-start lean AND has the
        // module cached before real query load arrives. No-op if already loaded.
        ec.waitUntil(import("./routes/graphql").catch(() => {}));
      } else await seed();
    }
    await next();
    // Stamp the latest bookmark on the way out so the client can round-trip
    // it on the next request. `c.res.headers.set` merges into the final
    // response — downstream handlers can't clobber it (we run after next()).
    if (session) {
      const bm = session.getBookmark();
      if (bm) c.res.headers.set("x-d1-bookmark", bm);
    }
  });

  // TUS discovery headers must be set BEFORE cors so they ride along on the
  // cors-short-circuited OPTIONS response (cors builds its 204 from the
  // accumulated `c.res.headers`). See `tusBaseHeaders`.
  const tusHeaders = tusBaseHeaders(uploadPolicy(env).maxBytes);
  app.use("/api/uploads", tusHeaders);
  app.use("/api/uploads/*", tusHeaders);

  // `/.well-known/*` is skipped below: those documents (JWKS, OAuth metadata)
  // are public and uncredentialed, and serve their own `ACAO: *` so ANY origin
  // can read them. The credentialed policy here would overwrite that with the
  // single allowed origin, which is exactly wrong for a discovery document.
  const corsMw = timed("cors", cors({
      // Allow `APP_URL` always; allow any origin in `EXTRA_TRUSTED_ORIGINS`
      // or derived from a workspace's `auth_config.redirectUrls` (so a
      // customer's app on a different domain can call its workspace's auth
      // surface + the data API with credentials). Anything else gets a
      // non-matching ACAO header → blocked by the browser.
      origin: (origin, c) => {
        if (!origin || origin === env.APP_URL) return env.APP_URL;
        const ctx = c.get("ctx");
        if (ctx) refreshAllowedOriginsIfStale({ db: ctx.db, dialect: ctx.dialect });
        return isWorkspaceAllowedOrigin(origin, env) ? origin : env.APP_URL;
      },
      credentials: true,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Backlex-Tenant",
        // Publishable analytics ingest key — a custom header, so a browser SDK
        // on a customer origin preflights before it can post events.
        "X-Backlex-Ingest-Key",
        // Stable per-visitor id for feature-flag rollout bucketing. A browser
        // should prefer `?bucket=`, which needs no preflight; this is for
        // server-side callers.
        "X-Backlex-Bucket",
        "X-D1-Bookmark",
        "MCP-Protocol-Version",
        // TUS resumable-upload request headers (Uppy / tus-js-client).
        "Tus-Resumable",
        "Upload-Length",
        "Upload-Offset",
        "Upload-Metadata",
        "Upload-Concat",
      ],
      allowMethods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      // Expose so the browser SPA can read the bookmark off the response and
      // round-trip it on the next request (D1 Sessions API). The TUS headers let
      // a browser client read the resume offset + session location. Server-Timing
      // is NOT exposed — it's an ops-only, secret-gated diagnostic.
      exposeHeaders: [
        "X-Request-Id",
        // IETF-draft rate-limit headers (global API quota) so SDK/browser
        // clients can read their remaining budget and back off predictively.
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "RateLimit-Reset",
        "Retry-After",
        "X-D1-Bookmark",
        "Location",
        "Upload-Offset",
        "Upload-Length",
        "Tus-Resumable",
        "Tus-Version",
        "Tus-Extension",
        "Tus-Max-Size",
      ],
    }),
  );
  // Carve-outs from the credentialed CORS policy above, all for the same
  // reason: each serves a document or endpoint that ANY origin must be able to
  // reach, and the policy here would replace their own `ACAO: *` with a single
  // allowed origin — which is exactly wrong for them.
  //
  //  - `/.well-known/*` — JWKS and OAuth metadata, public and uncredentialed.
  //  - `/api/analytics/collect` + `/script.js` — the web tag. It runs on
  //    customer domains that are not on any allowlist, and `sendBeacon` cannot
  //    send a header or survive a preflight. The route answers `ACAO: *`
  //    WITHOUT credentials and is append-only; it can never read a row back.
  //    See `routes/analytics-collect.ts` for what replaces the origin check.
  //  - `/api/consent/config` — what a cookie banner on a customer's own domain
  //    reads to know what to show. Read-only, session-free, and it returns only
  //    what the operator publishes to their own visitors; the projection behind
  //    it names its columns so the site's operator settings cannot reach the
  //    body. See `routes/consent-public.ts`.
  //  - `/api/consent/record` — where that banner posts the visitor's decision,
  //    and where the visitor withdraws it. The only write on this list, so it
  //    carries four ceilings rather than one and accepts nothing unless the site
  //    has an ENABLED consent policy. Same file.
  //
  // Matched against `c.req.path`, which excludes the query string — so
  // `/api/consent/config?s=…` is exempt on the exact entry and needs no prefix.
  const CORS_EXEMPT = [
    "/api/analytics/collect",
    "/api/analytics/script.js",
    "/api/consent/config",
    "/api/consent/record",
  ];
  // The per-site script file joins them, at BOTH its paths — it is a path
  // PARAMETER, so it needs a prefix rather than another exact entry, and
  // `isPerSiteScript` is that prefix test. The exact entries above stay; none
  // of those paths is under either prefix.
  //
  // Worth naming what this exemption actually does, because "CORS" sends the
  // next person to the wrong layer: a `<script src>` without `crossorigin` is
  // not CORS-governed at all. What it prevents is hono's `cors()` stamping
  // `Vary: Origin` and an `ACAO` of one specific origin onto a response we want
  // cached identically for every origin on the internet.

  /**
   * `/api/flags` is the one public-surface endpoint the credentialed policy
   * locked out, and the lockout was invisible: a non-allowlisted origin got an
   * `ACAO` of the WORKSPACE's own host, so a customer's marketing page could
   * not read its own workspace's flags — which is the exact caller a rollout
   * percentage exists for. `docs/feature-flags.md` presents this route as the
   * read path for "your apps"; the analytics tag at `/api/site/<id>.js`
   * already answers `*`. Flags simply never got the same treatment.
   *
   * A blanket exemption would have been wrong. An allowlisted origin (a
   * workspace `redirectUrls` host) reads flags WITH credentials today and gets
   * its own logged-in evaluation; `ACAO: *` is incompatible with credentials,
   * so exempting the path outright would have broken the callers it already
   * served in order to serve new ones.
   *
   * So the decision is deferred to `corsMw` and only its FALLBACK is rewritten:
   * if it answered the caller's own origin, that origin is allowlisted and the
   * credentialed answer stands. If it answered `APP_URL` to a caller that is
   * not `APP_URL`, that is the "not allowed" fallback, and for this one
   * read-only path the honest answer is `*` without credentials.
   *
   * `no-store` because the body is per-caller and `*` makes it cacheable by
   * anything in between; `Vary: Origin` because the header now depends on it.
   */
  const FLAGS_PATH = "/api/flags";
  const relaxFlagsCors: MiddlewareHandler<AppBindings> = async (c, next) => {
    await next();
    const origin = c.req.header("Origin");
    if (!origin || origin === env.APP_URL) return;
    if (c.res.headers.get("Access-Control-Allow-Origin") === origin) return;
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.delete("Access-Control-Allow-Credentials");
    c.res.headers.set("Vary", "Origin");
    c.res.headers.set("Cache-Control", "no-store");
  };
  app.use("*", async (c, next) =>
    c.req.path === FLAGS_PATH || c.req.path === `${FLAGS_PATH}/`
      ? relaxFlagsCors(c, next)
      : next(),
  );

  app.use("*", async (c, next) =>
    c.req.path.startsWith("/.well-known/") ||
    CORS_EXEMPT.includes(c.req.path) ||
    isPerSiteScript(c.req.path)
      ? next()
      : corsMw(c, next),
  );

  // Liveness/readiness probes deliberately bypass session + tenant resolution.
  // `tenantMiddleware` calls `ensureDefaultTenant`, which SELECTs from
  // `tenants` — so on a deployment whose migrations have not been applied the
  // probes were the first thing to 500, with an `INTERNAL` body that named
  // nothing. A liveness check that cannot answer until the database is healthy
  // is not a liveness check; `/health/ready` below is where the DB is probed,
  // and it now reports an unmigrated database as its own state.
  const skipOnProbe =
    (mw: MiddlewareHandler<AppBindings>): MiddlewareHandler<AppBindings> =>
    (c, next) =>
      PROBE_PATHS.includes(c.req.path) ? next() : mw(c, next);

  app.use("*", timed("session", skipOnProbe(sessionMiddleware)));
  app.use("*", timed("tenant", skipOnProbe(tenantMiddleware)));

  // Mark when all pre-route middleware (ctx + CORS + session + tenant) is done,
  // so `premw` vs `route` (= total − premw) can be split in Server-Timing.
  app.use("*", async (c, next) => {
    const st = c.get("__st");
    const t0 = st?._t0;
    if (st && t0 !== undefined) st.premw = performance.now() - t0;
    await next();
  });

  // Global per-identity rate limit on the data API. Runs after session+tenant
  // (so the limiter key can use the resolved API key / user / tenant) and is
  // scoped to `/api/*`. No-ops unless enabled (off on self-host, auto-on for
  // managed cloud) — see lib/api-rate-limit.ts. Skips `/api/auth/*` internally,
  // which the dedicated auth limiter already covers.
  app.use("/api/*", apiRateLimitMiddleware);

  // Usage metering (#12): counts every metered response into the per-day
  // `usage_counters` ledger and enforces per-key monthly quotas + workspace
  // hard request caps. Sits INSIDE the rate limiter so throttled 429s are
  // neither counted nor billed. Skips `/api/auth/*` like the limiter.
  app.use("/api/*", usageMeterMiddleware);

  // Playground write-guard: only mounted in DEMO_MODE, so normal instances
  // don't pay even the path check. Must sit before the route mounts (it 403s
  // the blocked writes wholesale, including the better-auth catch-all paths).
  if (isDemoMode(env)) app.use("/api/*", demoGuardMiddleware);

  // `version` is the worker-template version baked in at build time (see
  // vite.config `define`). Lets the cloud control-plane + ops verify which
  // template a live instance is actually running without guessing. The `typeof`
  // guard keeps it safe under runtimes that don't apply Vite `define` (bun test,
  // bun self-host) — there it reports "dev" instead of throwing on the global.
  const templateVersion =
    typeof __TEMPLATE_VERSION__ !== "undefined" ? __TEMPLATE_VERSION__ : "dev";
  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: templateVersion,
      dialect: c.get("ctx").dialect,
      // Which JS engine is actually executing — workerd/node/bun deploys of
      // the same bundle are otherwise indistinguishable from the outside.
      // workerd must be checked before node: under `nodejs_compat` it also
      // populates `process.versions.node` (polyfill, not a real node).
      runtime:
        typeof Bun !== "undefined"
          ? `bun/${Bun.version}`
          : globalThis.navigator?.userAgent === "Cloudflare-Workers"
            ? "workerd"
            : typeof process !== "undefined" && process.versions?.node
              ? `node/${process.versions.node}`
              : "unknown",
      ts: Date.now(),
    }),
  );

  // Readiness probe — unlike `/health` (liveness; the isolate is up), this
  // verifies the request path can actually reach the database with a trivial
  // `SELECT 1`. Returns 503 when the DB is unreachable so orchestrators / load
  // balancers (and uptime checks) can pull a broken instance out of rotation
  // instead of routing traffic that will 500. Cheap enough to poll frequently.
  app.get("/health/ready", async (c) => {
    const ctx = c.get("ctx");
    const t0 = Date.now();
    // Probe a SYSTEM TABLE, not `SELECT 1`. A bare `SELECT 1` succeeds against
    // a database that is merely *reachable*, which is how a deployment whose
    // migrations were never applied used to report itself ready and then 500
    // on every request. `tenants` exists in the very first migration, so
    // "reachable but unmigrated" is a distinct, nameable state.
    let dbUp = false;
    let migrated = false;
    let detail: string | null = null;
    try {
      const raw = sql.raw("SELECT 1 AS ok FROM tenants LIMIT 1");
      if (ctx.dialect === "pg") await (ctx.db as { execute: (q: unknown) => Promise<unknown> }).execute(raw);
      else await (ctx.db as { all: (q: unknown) => Promise<unknown> }).all(raw);
      dbUp = true;
      migrated = true;
    } catch (e) {
      const { reachable, text } = classifyDbProbeError(e);
      dbUp = reachable;
      detail = reachable
        ? "Database is reachable but not migrated — run `bun run db:migrate:d1` (miniflare/Workers), `db:migrate:sqlite` (Bun), or `db:migrate:pg` (Postgres)."
        : text || String(e);
      log.error("readiness.db_probe_failed", {
        requestId: c.get("requestId"),
        migrated: false,
        reachable,
        err: text,
      });
    }
    const ok = dbUp && migrated;
    return c.json(
      {
        ok,
        db: dbUp ? "up" : "down",
        migrated,
        ...(detail ? { detail } : {}),
        dbMs: Date.now() - t0,
        dialect: ctx.dialect,
        version: templateVersion,
        ts: Date.now(),
      },
      ok ? 200 : 503,
    );
  });

  // Per-IP rate limit on the sensitive auth subpaths (sign-in, sign-up,
  // password reset, magic link, OTP, 2FA). Sits in front of both the
  // control-plane better-auth router and the workspace end-user tenant-auth
  // router so credential-stuffing and reset-spam are blunted before they
  // ever reach the auth handler. GETs and other read-only OAuth flows
  // pass through untouched (see lib/auth-rate-limit.ts).
  app.use("/api/auth/*", authRateLimitMiddleware);
  app.use("/api/t/*", authRateLimitMiddleware);
  // Per-account failed-login lockout, layered after the per-IP limiter on the
  // same auth surfaces. Only password sign-in is gated (see auth-lockout.ts).
  app.use("/api/auth/*", authLockoutMiddleware);
  // The switch that closes open dynamic client registration. In front of the
  // better-auth mount, where the lockout gate is, because the plugin owns
  // `/api/auth/mcp/register` and has no option for this. See
  // lib/oauth-registration-gate.ts.
  app.use("/api/auth/*", dynamicRegistrationGate);
  app.use("/api/t/*", authLockoutMiddleware);
  // The workspace's `password-verification` auth hook — the app's own say on a
  // password sign-in, after our built-in lockout has had its. Workspace plane
  // only; a refusal revokes the session better-auth already issued (see
  // lib/auth-hook-middleware.ts).
  app.use("/api/t/*", passwordVerificationHookMiddleware);
  // The captcha gate, in front of better-auth's router — a failed challenge
  // must cost nothing downstream, so it runs before the lockout counter and
  // before any row is written. See lib/captcha-middleware.ts.
  app.use("/api/t/*", captchaMiddleware);

  // Public auth-surface discovery — must be registered before the better-auth
  // catch-all (`/api/auth/*`) so it isn't shadowed by it.
  app.route("/api/auth", authPublicRoutes);
  // Control-plane SSO (SAML ACS/metadata/slo, LDAP sign-in) — must precede the
  // better-auth catch-all so `/api/auth/saml/*` and `/api/auth/ldap/*` win.
  app.route("/api/auth", platformAuthRoutes);
  // MCP OAuth consent gate — must ALSO precede the catch-all: it rewrites
  // GET /api/auth/mcp/authorize to force the consent screen for unconsented
  // clients (the plugin skips consent unless the client opts in) and then
  // falls through to the better-auth handler below.
  app.route("/api/auth", mcpAuthorizeConsentGate());
  app.route("/api/auth", authRoutes);
  // Root OAuth discovery documents (RFC 8414 / RFC 9728) — hosted MCP clients
  // (claude.ai custom connectors) fetch these from the origin root to find
  // the authorize/token/register endpoints under /api/auth/mcp/*.
  app.route("/.well-known", mcpOAuthWellKnownRoutes());
  app.route("/.well-known", jwksRoutes());
  app.route("/api/me", meRoutes);
  app.route("/api/account", accountRoutes);
  // Workspace end-user auth (the "auth as a service" surface) — each tenant
  // gets its own better-auth instance under /api/t/<slug>/auth/*, backed by
  // the app_* tables and the tenant-scoped adapter wrapper.
  app.route("/api/t", tenantAuthRoutes);
  // End-user organization self-service, alongside the auth surface on the same
  // `/api/t/:slug` prefix. Mounted after tenantAuthRoutes — its catch-all is
  // `/:slug/auth/*`, so the `/orgs` paths here never collide with it.
  app.route("/api/t", appOrgsPublicRoutes);
  app.route("/api/t", appAgentsPublicRoutes(app));
  app.route("/api/tenants", tenantsRoutes);
  app.route("/api/admin/email-templates", emailTemplatesRoutes);
  app.route("/api/admin/documents", documentsRoutes);
  app.route("/api/geo", geoRoutes);
  app.route("/api/phone", phoneRoutes);
  app.route("/api/email", emailFieldRoutes);
  app.route("/api/admin/approvals", approvalsRoutes);
  app.route("/api/admin/signatures", signaturesRoutes);
  app.route("/api/admin/booking", bookingRoutes);
  app.route("/api/admin/email-config", emailConfigRoutes);
  app.route("/api/admin/push-templates", pushTemplatesRoutes);
  app.route("/api/admin/push-config", pushConfigRoutes);
  app.route("/api/admin/sms-config", smsConfigRoutes);
  app.route("/api/admin/ai-config", aiConfigRoutes);
  app.route("/api/workspace-config", workspaceConfigRoutes);
  app.route("/api/admin/auth", authAdminRoutes);
  app.route("/api/admin/saml", samlAdminRoutes);
  app.route("/api/admin/oidc", oidcAdminRoutes);
  app.route("/api/admin/third-party-auth", thirdPartyAuthAdminRoutes);
  app.route("/api/admin/scim", scimAdminRoutes);
  app.route("/api/admin/sync-hooks", syncHooksRoutes);
  app.route("/api/admin/auth-hooks", authHooksRoutes);
  app.route("/api/admin/realtime-channels", realtimeChannelsRoutes);
  app.route("/api/admin/rls", rlsRoutes);
  app.route("/api/admin/s3-credentials", s3CredentialsRoutes);
  app.route("/api/admin/captcha", captchaRoutes);
  app.route("/api/admin/impersonation", impersonationRoutes);
  app.route("/api/admin/signing-keys", signingKeysRoutes);
  app.route("/api/admin/oauth-clients", oauthClientsRoutes);
  app.route("/api/admin/cdc-sinks", cdcRoutes);
  // The S3-compatible endpoint. Mounted OUTSIDE `/api` and before the session
  // middleware chain on purpose: a SigV4 request carries no cookie, no bearer
  // token and no workspace header, and running it through a gate built for
  // those would either reject it or resolve the wrong workspace. Its own
  // handler authenticates from the signature and derives the workspace from
  // the credential. See routes/s3.ts.
  app.route("/s3", s3Routes);
  app.route("/api/admin/erasure", erasureRoutes);
  // SCIM itself is NOT session/api-key authenticated — the IdP presents the
  // workspace's SCIM bearer token and every handler resolves the tenant from it.
  app.route("/api/scim/v2", scimRoutes);
  app.route("/api/admin/ldap-config", ldapAdminRoutes);
  app.route("/api/admin/platform-saml", platformSamlAdminRoutes);
  app.route("/api/admin/platform-ldap-config", platformLdapAdminRoutes);
  app.route("/api/admin/adopt", adoptRoutes);
  app.route("/api/admin/migrate", migrateRoutes);
  app.route("/api/admin/panels", panelsRoutes);
  app.route("/api/admin/dashboards", dashboardsRoutes);
  app.route("/api/admin/kpis", kpisRoutes);
  app.route("/api/admin/schema", schemaVersionsRoutes);
  app.route("/api/admin/i18n", i18nRoutes);
  app.route("/api/i18n", i18nPublicRoutes);
  app.route("/api/admin/settings", settingsRoutes);
  app.route("/api/admin/db", dbAdminRoutes);
  app.route("/api/admin/metrics", metricsRoutes);
  app.route("/api/admin/usage", usageRoutes);
  app.route("/api/admin/realtime", realtimeAdminRoutes);
  app.route("/api/admin/advisor", advisorRoutes);
  app.route("/api/api-keys", apiKeysRoutes);
  app.route("/api/collections", collectionsRoutes);
  app.route("/api/admin/templates", templatesRoutes);
  app.route("/api/admin/demo", demoRoutes);
  app.route("/api/items", itemsRoutes);
  app.route("/api/activity", activityRoutes);
  app.route("/api/admin/traces", tracesRoutes);
  app.route("/api/admin/analytics", analyticsRoutes);
  app.route("/api/admin/tag-manager", tagManagerRoutes);
  app.route("/api/admin/consent", consentRoutes);
  app.route("/api/consent", consentPublicRoutes);
  // The canonical home of the per-site script. `/api/analytics/tm/<id>.js`
  // still answers the same handler and always will — it is inside a `<script>`
  // tag on every already-deployed customer page.
  app.route("/api/site", siteScriptRoutes);
  // Public ingest — authenticated by a publishable key or a normal session,
  // never anonymous. Kept off `/api/admin/*` because client bundles call it.
  app.route("/api/analytics", analyticsCollectRoutes);
  app.route("/api/analytics", analyticsIngestRoutes);
  app.route("/api/revisions", revisionsRoutes);
  app.route("/api/storage", storageRoutes);
  app.route("/api/uploads", uploadsRoutes);
  app.route("/api/flags", flagsPublicRoutes);
  app.route("/api/admin/feature-flags", flagsAdminRoutes);
  app.route("/api/folders", foldersRoutes);
  app.route("/api/vector", vectorRoutes);
  app.route("/api/realtime", realtimeRoutes);
  app.route("/api/webhooks", webhooksRoutes);
  app.route("/api/admin/integrations", integrationsRoutes);
  app.route("/api/admin/payments", paymentsRoutes);
  // Public payment-provider webhook receiver — no `requireUser`. The path
  // token resolves the workspace and the provider HMAC authenticates the body
  // (see routes/payments-public.ts).
  app.route("/api/payments", paymentsPublicRoutes);
  // Public integration-webhook receiver — same shape, one level over: the path
  // token resolves the subscription and the endpoint's own secret authenticates
  // the delivery (see routes/integrations-public.ts).
  app.route("/api/integrations", integrationsPublicRoutes);
  // Public flow-trigger endpoint — POST /api/webhook/:flowId fires the
  // matching `webhook`-triggered flow. Distinct path from /api/webhooks
  // (outgoing dispatch admin) by design.
  app.route("/api/webhook", webhookTriggerRoutes);
  app.route("/api/comments", commentsRoutes);
  app.route("/api/shared-links", sharedLinksRoutes);
  // Public, unauthenticated record-share resolution — no `requireUser`.
  app.route("/api/shared", sharedPublicRoutes);
  app.route("/api/public/dashboards", dashboardsPublicRoutes);
  app.route("/api/admin/forms", formsRoutes);
  // Public form definition + submit — no `requireUser`; the `/api/public/`
  // prefix inherits the framable CSP + XFO-strip for the iframe embed page.
  app.route("/api/public/forms", formsPublicRoutes);
  // The signer's side of an e-signature request. Same shape as the form
  // endpoints above: no `requireUser`, the link token is the whole grant.
  app.route("/api/public/approve", approvalsPublicRoutes);
  app.route("/api/public/sign", signaturesPublicRoutes);
  // The booker's side. Same shape again: no `requireUser`, the page token is
  // the grant to see a calendar and the manage token the grant to change one
  // appointment. Framable, because a booking widget belongs on the operator's
  // own site rather than on ours.
  app.route("/api/public/book", bookingPublicRoutes);

  // Public dashboard embed page. `/embed/*` is in `run_worker_first`, so the
  // Worker (not CF Static Assets) serves the SPA shell here — which lets the
  // header middleware above apply the framable CSP (`frame-ancestors *`, no
  // XFO). Static assets get a strict same-origin CSP via public/_headers; only
  // this worker-served path is iframe-able. Other runtimes serve `/embed/*`
  // through their own static SPA fallback (no ASSETS binding → route skipped).
  //
  // We fetch the ORIGINAL request path (not a rewritten `/index.html`) so the
  // Static Assets SPA fallback (`not_found_handling = single-page-application`)
  // returns the shell — and in dev `@cloudflare/vite-plugin` serves it through
  // Vite's HTML transform (with the React-refresh preamble) instead of the raw
  // file, which would otherwise white-screen the page.
  // Script embed loader — the modern alternative to a hand-written iframe:
  //   <div data-backlex-form="frm_…"></div>
  //   <script src="https://…/embed/form.js" async></script>
  // It mounts a sandboxed iframe per marker and auto-sizes it from the form
  // page's height postMessages, so embeds never need a fixed height. Served
  // from the worker, before the /embed/* shell route below.
  //
  // Being registered here is NOT enough to reach a browser: this is a
  // non-`/api` path, and every target routes non-`/api` paths to the app by an
  // explicit allow-list. It was in Cloudflare's `run_worker_first` and in
  // NEITHER Vercel's nor Netlify's, so on those two it fell into the SPA
  // fallback and answered `index.html` as `text/html` — a `<script src>` that
  // does nothing, on a URL the admin hands customers verbatim. Adding a route
  // here means adding it to all three configs; `runtime-routing.test.ts` is
  // what now says so out loud.
  app.get("/embed/form.js", (c) => {
    const js = `(function(){
var S=document.currentScript,O=new URL(S.src).origin;
function mount(el){if(el.__bx)return;el.__bx=1;
var t=el.getAttribute("data-backlex-form"),l=el.getAttribute("data-lang");
var f=document.createElement("iframe");
f.src=O+"/embed/f/"+encodeURIComponent(t)+(l?"?lang="+encodeURIComponent(l):"");
f.style.cssText="width:100%;border:0;display:block;transition:height .15s ease";
f.height="480";f.setAttribute("title","Form");f.setAttribute("loading","lazy");
el.appendChild(f);
window.addEventListener("message",function(e){
if(e.origin!==O||!e.data||e.data.type!=="backlex-form-height")return;
if(e.source===f.contentWindow)f.style.height=e.data.height+"px";});}
function scan(){document.querySelectorAll("[data-backlex-form]").forEach(mount);}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",scan);else scan();
})();`;
    return c.body(js, 200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
  });

  if (env.ASSETS) {
    // `/f/*` (standalone public form page) shares the worker-served-shell path
    // with `/embed/*`: both are in `run_worker_first` so the header middleware
    // above can set their special CSP (Turnstile allowances; framable for
    // embeds) instead of the static `_headers` policy.
    app.get("/f/*", async (c) => {
      const res = await env.ASSETS!.fetch(new Request(c.req.url, { headers: c.req.raw.headers }));
      if (isDevServer) return res;
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "text/html; charset=utf-8" },
      });
    });
    // The two booking pages, for the same reason and by the same route: a
    // booking widget belongs on the operator's site. Served here rather than
    // by Static Assets so the framable CSP above is the one that lands —
    // `_headers` would leave the strict `frame-ancestors 'self'` in place
    // alongside it, and the browser takes the stricter of the two.
    //
    // No separate `/embed/b/` variant: unlike a form, whose standalone page
    // stays same-origin-only, BOTH booking pages are meant to be embeddable,
    // so the link an operator already has is the one they paste into an
    // iframe. A second URL would only be a second thing to rotate.
    app.get("/book/*", async (c) => {
      const res = await env.ASSETS!.fetch(new Request(c.req.url, { headers: c.req.raw.headers }));
      if (isDevServer) return res;
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "text/html; charset=utf-8" },
      });
    });
    app.get("/b/*", async (c) => {
      const res = await env.ASSETS!.fetch(new Request(c.req.url, { headers: c.req.raw.headers }));
      if (isDevServer) return res;
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "text/html; charset=utf-8" },
      });
    });
    app.get("/embed/*", async (c) => {
      const res = await env.ASSETS!.fetch(new Request(c.req.url, { headers: c.req.raw.headers }));
      // In dev (@cloudflare/vite-plugin) return the upstream response untouched
      // so Vite's HTML transform + React-refresh preamble stay intact; framable
      // headers only matter in prod (and `app` runs locally, not in an iframe).
      if (isDevServer) return res;
      // Prod: re-stream the body with only content-type — DON'T copy
      // content-length/encoding (a stale length truncates the HTML). The header
      // middleware then sets the framable CSP (frame-ancestors *, no XFO).
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "text/html; charset=utf-8" },
      });
    });
  }
  app.route("/api/notifications", notificationsRoutes);
  app.route("/api/device-tokens", deviceTokensRoutes);
  app.route("/api/phone-numbers", phoneNumbersRoutes);
  app.route("/api/messaging", messagingRoutes);
  app.route("/api/flows", flowsRoutes);
  app.route("/api/jobs", jobsRoutes);
  app.route("/api/roles", rolesRoutes);
  app.route("/api/permissions", permissionsRoutes);
  app.route("/api/users", usersRoutes);
  app.route("/api/app-users", appUsersRoutes);
  app.route("/api/app-orgs", appOrgsRoutes);
  app.route("/api/functions", functionsRoutes);
  app.route("/api/extensions", extensionsRoutes);
  // Lazy: the GraphQL subsystem (graphql-yoga + graphql + @graphql-tools) is a
  // large slice of the bundle that most requests never touch. Dynamic-import it
  // on first hit so it stays out of the worker's cold-start eval path.
  app.all("/api/graphql", (c) =>
    import("./routes/graphql").then((m) => m.handleGraphql(c, app as unknown as Hono)),
  );
  // GraphQL subscriptions over SSE (graphql-sse distinct-connections mode) —
  // delegates to the realtime layer's transports; same lazy-load rationale.
  app.all("/api/graphql/stream", (c) =>
    import("./routes/graphql").then((m) => m.handleGraphqlStream(c)),
  );
  app.route("/api", openapiRoutes);
  app.route("/api/_internal/sandbox-rpc", sandboxRpcRoutes);
  // MCP (Model Context Protocol) — must mount after the routes its tools
  // sub-fetch into, since the route factories capture the same `app`
  // reference to issue in-process requests against the existing REST
  // surface. Two mounts: `/mcp` is open to any authenticated identity
  // (permissions are enforced by the per-tool sub-fetch); `/api/admin/mcp`
  // additionally requires the system `admin` role.
  app.route("/mcp", tenantMcpRoutes(app, env));
  app.route("/api/admin/mcp", adminMcpRoutes(app, env));
  // Admin "Ask AI" page — splits the design's `planForPrompt` mock into
  // /plan (Claude → tool + args) and /run (executes one MCP tool, logs to
  // the activity table). Mounted after MCP because /run reuses the same
  // tool roster via in-process sub-fetches against this same Hono app.
  app.route("/api/admin/ai", aiAskRoutes(app, env));
  // AI agents — mounted alongside MCP / Ask-AI because the agent run loop
  // issues in-process sub-fetches against this same Hono app (carrying the
  // caller's identity) to execute the agent's allow-listed MCP tools.
  app.route("/api/agents", agentsRoutes(app, env));

  app.onError(errorHandler);

  return app;
};
