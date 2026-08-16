import { type Auth, createAuth } from "@backlex/auth";
import {
  AppError,
  EMBEDDING_MODELS,
  EMBEDDING_MODEL_NAMES,
  SYSTEM_ROLES,
  isEmbeddingModel,
  type EmbeddingModel,
  type VectorStore,
} from "@backlex/core";
import type {
  EdgeImageAdapter,
  EmailAdapter,
  EmbeddingAdapter,
  GeocodeAdapter,
  ImageAdapter,
  PdfAdapter,
  PushAdapter,
  SMSAdapter,
  StorageAdapter,
  VectorAdapter,
} from "@backlex/core/adapters";
import { ensureMigrations } from "@backlex/db";
import { createPgClient, type PgDb, type PgDriver } from "@backlex/db/pg";
import { createD1Client, type SqliteDb } from "@backlex/db/sqlite";
import { cloudEmailAdapter } from "./adapters/email.cloud";
import { consoleEmail } from "./adapters/email.console";
import { cloudPushAdapter } from "./adapters/push.cloud";
import { cloudSmsAdapter } from "./adapters/sms.cloud";
import { cloudEmbeddingAdapter } from "./adapters/embedding.cloud";
import { openaiEmbeddingAdapter } from "./adapters/embedding.openai";
import {
  embeddingRouter,
  noEmbeddingAdapter,
} from "./adapters/embedding.router";
import { selfHostEmbeddingAdapter } from "./adapters/embedding.self-host";
import { workersAiEmbeddingAdapter } from "./adapters/embedding.workers-ai";
import { bunImage } from "./adapters/image.bun";
import { cfEdgeImage } from "./adapters/image.cf";
import { netlifyEdgeImage } from "./adapters/image.netlify";
import { passthroughImage } from "./adapters/image.passthrough";
import { consoleGeocode } from "./adapters/geocode.console";
import { googleGeocode } from "./adapters/geocode.google";
import { mapboxGeocode } from "./adapters/geocode.mapbox";
import { nominatimGeocode } from "./adapters/geocode.nominatim";
import { cfBrowserPdf } from "./adapters/pdf.cf-browser";
import { gotenbergPdf } from "./adapters/pdf.gotenberg";
import { sharpImage } from "./adapters/image.sharp";
import { wasmImage } from "./adapters/image.photon";
import { fsStorage } from "./adapters/storage.fs";
import { r2Storage } from "./adapters/storage.r2";
import { bunS3Storage } from "./adapters/storage.s3.bun";
import { s3FetchStorage } from "./adapters/storage.s3.fetch";
import {
  type VectorizeIndexMap,
  vectorizeAdapter,
} from "./adapters/vector.cf";
import { pgvectorAdapter } from "./adapters/vector.pg";
import { libsqlVectorAdapter } from "./adapters/vector.libsql";
import { pineconeVectorAdapter, type PineconeHostMap } from "./adapters/vector.pinecone";
import { qdrantVectorAdapter, type QdrantCollectionMap } from "./adapters/vector.qdrant";
import type { Env } from "./env";
import { cloudConfigured, reportToCloud } from "./lib/cloud-report";
import { buildEmailAdapter, selectEmailSpec } from "./lib/email-select";
import { buildPushAdapter, selectPushSpec } from "./lib/push-select";
import { buildSmsAdapter, selectSmsSpec } from "./lib/sms-select";
import {
  isCloudflareWorkers,
  isNetlify,
  isStatelessEdge,
  isVercel,
  isXataPgUrl,
} from "./lib/runtime";
import { loadPolicy } from "./services/auth-config";
import { resolveEmailAdapter } from "./services/email-config";
import { resolvePushAdapter } from "./services/push-config";
import { resolveSmsAdapter } from "./services/sms-config";
import { publishEvent } from "./services/events";
import { acceptInviteForUser, hasValidInvite } from "./services/invites";
import { invalidateUserRoles } from "./services/permissions-cache";
import {
  assignRoleByName,
  ensureDefaultTenant,
  ensureSystemRoles,
  ensureTenantMembership,
  userCount,
} from "./services/seed";
import { applyTemplate } from "./services/templates";
import { getTemplate } from "./templates/catalog";

/**
 * What vector search can actually do on this deployment — computed once in
 * `buildContext` from the same env checks that pick the vector/embedding
 * adapters, so the admin UI (model picker, enable toggle) can tell the truth
 * instead of letting a request fail at first embed.
 */
export interface VectorCapabilities {
  /** Where vectors are stored. `none` → vector search cannot work at all. */
  store: VectorStore;
  /** `env.EMBEDDING_DEFAULT_MODEL` when it names a known model, else null. */
  defaultModel: EmbeddingModel | null;
  /** Per-model readiness: the model's embedding provider is configured AND
   *  the store can hold its vectors (on Vectorize: its binding is present). */
  models: Record<EmbeddingModel, boolean>;
}

export interface Ctx {
  env: Env;
  dialect: "pg" | "sqlite";
  db: PgDb | SqliteDb;
  /** Read-only client for lag-tolerant queries. Points at the configured
   *  Postgres read replica when `DATABASE_REPLICA_URL` is set; otherwise
   *  falls back to {@link Ctx.db}. SQLite/D1 always alias
   *  the primary. Do NOT use for reads-after-write — replication lag means
   *  the row may not be visible yet. Default everywhere else is `ctx.db`;
   *  routes opt in by saying `ctx.dbRead` explicitly. */
  dbRead: PgDb | SqliteDb;
  /** True when the active DB driver supports an interactive transaction the
   *  batch endpoint can run an atomic write set through (postgres-js / in-process
   *  SQLite). False on D1 / libSQL / neon-http (HTTP transports). */
  txCapable: boolean;
  auth: Auth;
  /** Deployment-level email adapter (env-derived). Most callers should prefer
   *  {@link Ctx.emailFor} so a workspace's own `email_config` is honoured. */
  email: EmailAdapter;
  /** Resolve the email transport for a workspace: its own `email_config` row
   *  → the instance `_global` row → the deployment env adapter. Memoized per
   *  request. Pass `null` for system mail with no workspace context. */
  emailFor: (tenantId: string | null | undefined) => Promise<EmailAdapter>;
  /** Deployment-level push adapter (env-derived; a `multi` fan-out when several
   *  providers are configured). Prefer {@link Ctx.pushFor} so a workspace's own
   *  `push_config` is honoured. */
  push: PushAdapter;
  /** Resolve the push transport for a workspace: its own `push_config` row →
   *  the instance `_global` row → the deployment env adapter. Memoized per
   *  isolate (one entry per tenant). */
  pushFor: (tenantId: string | null | undefined) => Promise<PushAdapter>;
  /** Deployment-level SMS adapter (env-derived). Prefer {@link Ctx.smsFor} so a
   *  workspace's own `sms_config` is honoured. */
  sms: SMSAdapter;
  /** Resolve the SMS transport for a workspace: its own `sms_config` row → the
   *  instance `_global` row → the deployment env adapter. Memoized per isolate. */
  smsFor: (tenantId: string | null | undefined) => Promise<SMSAdapter>;
  storage: StorageAdapter;
  vector: VectorAdapter;
  /** Text → vector embedding. Routes to Workers AI or OpenAI based on the
   *  requested model (see `EMBEDDING_MODELS`). Throws if the model's
   *  provider isn't configured. */
  embedding: EmbeddingAdapter;
  /** Deployment-level vector-search readiness (store + per-model providers). */
  vectorCaps: VectorCapabilities;
  image: ImageAdapter;
  /**
   * HTML → PDF renderer, or `undefined` when none is configured.
   *
   * Undefined rather than a no-op fallback, like {@link Ctx.edgeImage}: there
   * is no renderer that works everywhere without either a browser or a font
   * problem, so callers check for it and refuse with a message naming the env
   * vars. See `packages/core/src/adapters/pdf.ts`.
   */
  pdf?: PdfAdapter;
  /**
   * Address ⇄ point resolution, backing `geo` fields with `geocodeFrom` set and
   * the `/api/geo/*` endpoints.
   *
   * Always present, unlike {@link Ctx.pdf}: an unconfigured deployment gets the
   * `console` adapter, which resolves nothing. "This address could not be
   * placed" is already a normal outcome — a missing geocoder produces it for
   * every address instead of some, which is a degradation rather than a broken
   * feature. Check `.provider === "console"` to tell the two apart.
   */
  geocode: GeocodeAdapter;
  /** URL-based edge transform backend (CF Image Resizing / Netlify Image
   *  CDN); undefined on runtimes without one. The serve path prefers it over
   *  `image` when the file is publicly reachable — no bytes through the
   *  runtime. */
  edgeImage?: EdgeImageAdapter;
}

/**
 * Pick the PDF renderer, or none.
 *
 * Mirrors `selectEmailAdapter` / `selectSmsAdapter`: an explicit `PDF_PROVIDER`
 * pins one and is REFUSED if its credentials are missing, rather than quietly
 * falling through to the other — an operator who named a provider wants that
 * provider, and a silent substitution is how a contract ends up rendered
 * somewhere they did not intend.
 */
export const selectPdfAdapter = (env: Env): PdfAdapter | undefined => {
  const cf =
    env.PDF_CF_ACCOUNT_ID?.trim() && env.PDF_CF_API_TOKEN?.trim()
      ? cfBrowserPdf(env.PDF_CF_ACCOUNT_ID.trim(), env.PDF_CF_API_TOKEN.trim())
      : undefined;
  const goten = env.PDF_GOTENBERG_URL?.trim()
    ? gotenbergPdf(
        env.PDF_GOTENBERG_URL.trim(),
        env.PDF_GOTENBERG_USER?.trim() && env.PDF_GOTENBERG_PASS
          ? { user: env.PDF_GOTENBERG_USER.trim(), pass: env.PDF_GOTENBERG_PASS }
          : undefined,
      )
    : undefined;

  const pinned = env.PDF_PROVIDER?.trim().toLowerCase();
  if (pinned === "cf-browser" || pinned === "cloudflare") return cf;
  if (pinned === "gotenberg") return goten;
  return cf ?? goten;
};

/**
 * Pick the geocoder from env.
 *
 * Same shape as {@link selectPdfAdapter} — one provider per deployment, pinned
 * by `GEOCODE_PROVIDER` or else the first with usable credentials — with one
 * difference: this one always returns an adapter. PDF returns `undefined` when
 * nothing is configured because there is no acceptable way to render a document
 * without a renderer; geocoding degrades honestly instead, because "we could
 * not place this address" is an outcome the write path already handles for
 * addresses that genuinely cannot be placed.
 *
 * Nominatim needs no credentials, so it is only reachable by asking for it
 * (`GEOCODE_PROVIDER=nominatim`) or by setting `GEOCODE_URL` to a self-hosted
 * instance. Defaulting to the public one would silently point every deployment
 * at a volunteer-run service whose usage policy forbids exactly the bulk traffic
 * a `geocodeFrom` import produces.
 */
export const selectGeocodeAdapter = (env: Env): GeocodeAdapter => {
  const google = env.GEOCODE_GOOGLE_API_KEY?.trim()
    ? googleGeocode({
        apiKey: env.GEOCODE_GOOGLE_API_KEY.trim(),
        language: env.GEOCODE_LANGUAGE?.trim() || undefined,
        region: env.GEOCODE_COUNTRY?.trim() || undefined,
      })
    : undefined;
  const mapbox = env.GEOCODE_MAPBOX_TOKEN?.trim()
    ? mapboxGeocode({
        accessToken: env.GEOCODE_MAPBOX_TOKEN.trim(),
        language: env.GEOCODE_LANGUAGE?.trim() || undefined,
        country: env.GEOCODE_COUNTRY?.trim() || undefined,
      })
    : undefined;
  const nominatim = (): GeocodeAdapter =>
    nominatimGeocode({
      url: env.GEOCODE_URL?.trim() || undefined,
      // The public instance bans clients that don't identify themselves; name
      // the software and the deployment so a rate-limit complaint has somewhere
      // to land.
      userAgent: env.GEOCODE_USER_AGENT?.trim() || `backlex (${env.APP_URL ?? "self-hosted"})`,
      language: env.GEOCODE_LANGUAGE?.trim() || undefined,
    });

  const pinned = env.GEOCODE_PROVIDER?.trim().toLowerCase();
  if (pinned === "google") return google ?? consoleGeocode();
  if (pinned === "mapbox") return mapbox ?? consoleGeocode();
  if (pinned === "nominatim") return nominatim();
  if (pinned === "console") return consoleGeocode();
  if (google) return google;
  if (mapbox) return mapbox;
  // A self-hosted Nominatim is a deliberate act of configuration, so treat
  // `GEOCODE_URL` as opting in.
  if (env.GEOCODE_URL?.trim()) return nominatim();
  return consoleGeocode();
};

// Memoize the assembled Ctx by Env reference. Workers reuse the same `env`
// object across requests in the same isolate, so we can keep one Ctx alive —
// `createAuth` + the drizzle adapter setup happens once per isolate instead of
// on every request. We deliberately key on identity (WeakMap) rather than
// serialising env, so a fresh deployment with a different binding gets a fresh
// Ctx automatically.
const ctxCache = new WeakMap<object, Ctx>();
// Per-Ctx email adapter cache — exposed so the admin email-config write path
// can drop a stale entry after a workspace updates its config (would otherwise
// keep serving the previous adapter for the rest of the isolate's life).
const emailCaches = new WeakMap<object, Map<string, Promise<EmailAdapter>>>();
/** Drop a single tenant's cached email adapter. Also drops the "" key (the
 *  env-default fallback used when no workspace is supplied). */
export const invalidateEmailCache = (env: Env, tenantId: string): void => {
  const m = emailCaches.get(env as unknown as object);
  if (!m) return;
  m.delete(tenantId);
  m.delete("");
};
/** Drop every cached email adapter for this isolate. Use after writes to the
 *  `_global` row — that fallback layer affects every tenant that doesn't have
 *  its own `email_config` row, so a per-tenant invalidation alone would leave
 *  most workspaces serving the previous adapter. */
export const invalidateAllEmailCaches = (env: Env): void => {
  emailCaches.get(env as unknown as object)?.clear();
};
// Per-Ctx push adapter cache — same lifecycle as the email cache above; the
// admin push-config write path drops stale entries after an update.
const pushCaches = new WeakMap<object, Map<string, Promise<PushAdapter>>>();
/** Drop a single tenant's cached push adapter (plus the "" env-default key). */
export const invalidatePushCache = (env: Env, tenantId: string): void => {
  const m = pushCaches.get(env as unknown as object);
  if (!m) return;
  m.delete(tenantId);
  m.delete("");
};
/** Drop every cached push adapter for this isolate (use after `_global` writes). */
export const invalidateAllPushCaches = (env: Env): void => {
  pushCaches.get(env as unknown as object)?.clear();
};
// Per-Ctx SMS adapter cache — same lifecycle as the push cache above; the
// admin sms-config write path drops stale entries after an update.
const smsCaches = new WeakMap<object, Map<string, Promise<SMSAdapter>>>();
/** Drop a single tenant's cached SMS adapter (plus the "" env-default key). */
export const invalidateSmsCache = (env: Env, tenantId: string): void => {
  const m = smsCaches.get(env as unknown as object);
  if (!m) return;
  m.delete(tenantId);
  m.delete("");
};
/** Drop every cached SMS adapter for this isolate (use after `_global` writes). */
export const invalidateAllSmsCaches = (env: Env): void => {
  smsCaches.get(env as unknown as object)?.clear();
};

/** In-flight buildContext promise, deduped per `env` so concurrent first
 *  requests in the same isolate don't both pay the (async) build cost. */
const ctxBuilding = new WeakMap<object, Promise<Ctx>>();

/** Tests-only: pre-seed the db + dialect for a specific `Env`, so a pg test
 *  can hand `buildContext` a `pglite`-backed drizzle client instead of
 *  having buildContext open the real Postgres / Bun-SQLite path. Cleared
 *  automatically with the env; tests pass a fresh env per harness. */
const testDbOverrides = new WeakMap<
  object,
  { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" }
>();
export const __setDbOverrideForTests = (
  env: Env,
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
): void => {
  testDbOverrides.set(env as unknown as object, { db, dialect });
};

export const buildContext = (env: Env): Promise<Ctx> => {
  const cached = ctxCache.get(env as unknown as object);
  if (cached) return Promise.resolve(cached);
  const inFlight = ctxBuilding.get(env as unknown as object);
  if (inFlight) return inFlight;
  const p = assembleContext(env);
  ctxBuilding.set(env as unknown as object, p);
  // The cleanup rides a DERIVED promise, and a derived promise inherits the
  // rejection. `assembleContext` genuinely rejects on a misconfigured runtime
  // (no database on a stateless edge, postgres-js on an edge, Postgres on
  // Workers), and nothing awaits this derivative — so without the catch the
  // failure surfaces a SECOND time as an unhandled rejection, alongside the
  // one the caller is already handling through the returned `p`. Swallow it
  // here only; `p` still carries the real error to the caller.
  p.finally(() => ctxBuilding.delete(env as unknown as object)).catch(() => {});
  return p;
};

import { bindSigningKeysToDatabase } from "./services/signing-keys";

const assembleContext = async (env: Env): Promise<Ctx> => {
  const override = testDbOverrides.get(env as unknown as object);

  // There is exactly one way to name a Postgres origin. Hyperdrive used to be
  // read here as a more-specific alternative, but the Workers bundle ships no
  // Postgres driver at all (see the refusal below), and Hyperdrive is a
  // Workers-only binding — so that branch could never be taken on a runtime
  // that could act on it.
  const pgUrl = env.DATABASE_URL;

  const dialect: "pg" | "sqlite" = override
    ? override.dialect
    : env.D1 ? "sqlite" : env.LIBSQL_URL ? "sqlite" : pgUrl ? "pg" : "sqlite";

  // Edge runtimes that can't open node:net (Vercel Edge / Netlify Deno
  // Deploy) don't have a working Bun-SQLite path and have no D1 binding —
  // they MUST run on Postgres OR libSQL (HTTP-based, edge-safe). Fail fast
  // with a clear message instead of crashing on `bun:sqlite` resolution.
  if (!env.D1 && !env.LIBSQL_URL && !pgUrl && isStatelessEdge()) {
    throw new AppError(
      "UNAVAILABLE",
      "Edge runtime requires DATABASE_URL (Postgres) or LIBSQL_URL (Turso/libSQL). On Vercel Edge with a Postgres origin, also set DATABASE_DRIVER=neon-http.",
    );
  }

  // Postgres is NOT available on the Cloudflare Workers bundle, by
  // construction: `apps/web/vite.config.ts` aliases `postgres`,
  // `@neondatabase/serverless` and both `@backlex/db/pg` entrypoints to shims,
  // so every `pgTable` def and `drizzle-orm/pg-core` stay out of the eager
  // cold-start graph. `@backlex/db/pg` is statically imported across ~80 files;
  // un-aliasing it is a different bundle, not a flag. Use libSQL/Turso for a
  // networked database on Workers, or run the Postgres path on
  // Bun/Node/Vercel/Netlify.
  //
  // Say that here rather than letting `createPgClient` throw from the shim —
  // "Postgres driver is not bundled on the D1 Workers build (pg-shim)" reads
  // like a build bug, not like a configuration answer.
  if (!env.D1 && !env.LIBSQL_URL && pgUrl && isCloudflareWorkers()) {
    throw new AppError(
      "UNAVAILABLE",
      "Postgres is not supported on Cloudflare Workers — the Workers bundle ships without a Postgres driver. Bind D1, or set LIBSQL_URL (Turso/libSQL) for a networked database. To run on Postgres, deploy the Bun, Node, Vercel or Netlify target instead.",
    );
  }

  let db: PgDb | SqliteDb;
  let pgDriver: PgDriver | undefined;
  // Whether this driver supports an interactive transaction we can replay an
  // atomic write batch through. postgres-js (TCP) and in-process SQLite (bun /
  // pglite-in-tests) do; D1, libSQL and neon-http (HTTP transports) do not, so
  // the batch endpoint rejects `atomic:true` there (non-atomic batch still works).
  let txCapable: boolean;
  if (override) {
    db = override.db;
    txCapable = true; // bun-sqlite / pglite test backends both support tx
  } else if (env.D1) {
    db = createD1Client(env.D1);
    txCapable = false;
  } else if (env.LIBSQL_URL) {
    // libSQL is fetch-based — works on every runtime including Vercel Edge
    // and Netlify Edge, so the import is unconditional (no bun:sqlite-style
    // dynamic gating needed). The module is lazy-loaded only to keep the
    // top-level sqlite barrel free of @libsql/client at module init.
    const { createLibsqlClient } = await import("@backlex/db/sqlite/libsql");
    db = createLibsqlClient(env.LIBSQL_URL, env.LIBSQL_AUTH_TOKEN);
    txCapable = false;
  } else if (pgUrl) {
    // Default driver: postgres-js. Force neon-http on Vercel Edge (no
    // node:net); allow explicit override on every runtime.
    pgDriver =
      env.DATABASE_DRIVER ??
      (isStatelessEdge() ? "neon-http" : "postgres-js");
    if (pgDriver === "postgres-js" && isStatelessEdge()) {
      throw new AppError(
        "UNAVAILABLE",
        "postgres-js does not work on stateless edge runtimes (Vercel/Netlify Edge, Deno Deploy) — set DATABASE_DRIVER=neon-http",
      );
    }
    db = createPgClient(pgUrl, pgDriver, {
      statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
    });
    txCapable = pgDriver === "postgres-js";
  } else {
    // SQLite + no D1 → Bun self-host. Dynamically import so the top-level
    // sqlite module stays edge-safe (no `bun:sqlite` at module init).
    const { createBunSqliteClient } = await import("@backlex/db/sqlite/bun");
    db = createBunSqliteClient(env.SQLITE_PATH);
    txCapable = true;
  }

  // Read replica (pg only). Tests share the override; SQLite/D1 alias the
  // primary because there's no replica equivalent. The driver tracks the
  // primary so behaviour stays consistent across runtimes.
  const pgReplicaUrl = dialect === "pg" ? env.DATABASE_REPLICA_URL : undefined;
  const dbRead: PgDb | SqliteDb =
    pgReplicaUrl && pgDriver && !override
      ? createPgClient(pgReplicaUrl, pgDriver, {
          statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
        })
      : db;

  const dbCtx = { db, dialect };

  // Boot-time auto-migrate. CF D1 stays out of scope: `wrangler d1
  // migrations apply` runs inside the Workers Build command so the
  // schema is already current before the worker even boots. Bun
  // self-host runs migrations via the CLI explicitly. Vercel +
  // Netlify Postgres deploys have no such hook — without this they
  // freeze at whatever the database held when first provisioned, and
  // any new column drizzle expects (e.g. `mcp_tools`) makes
  // `SELECT *` 500 on first request.
  //
  // The runner is idempotent + deduped per-isolate (WeakMap keyed on
  // db handle), so the first request after a fresh deploy applies
  // every new migration in the bundle and subsequent requests skip
  // the whole path.
  //
  // **Failures are swallowed with a warning, NOT rethrown.** This is
  // a deliberate trade-off: an existing production database that's
  // mostly current but where ensureMigrations chokes on one statement
  // is recoverable by the operator running `bun run db:migrate:pg` or
  // applying the ALTER manually — but only if the app is still
  // serving requests. Killing every endpoint with 500 because of a
  // single failed migration leaves the operator no way to investigate
  // (admin UI itself is unreachable). A "missing column" issue surfaces
  // anyway: the next query that uses the column 500s, but every other
  // endpoint keeps working.
  //
  // The only scenario where swallowing hides a real problem is a
  // brand-new empty DB where migrations couldn't run at all — but in
  // that case every endpoint that hits the DB will 500 anyway and
  // the operator sees the same warning in the deploy logs.
  if (!env.D1) {
    try {
      const outcome = await ensureMigrations(
        db as Parameters<typeof ensureMigrations>[0],
        dialect,
      );
      // A migration that hit an *unrecognised* error (not the idempotent
      // "already exists" cases) leaves the schema partially applied while the
      // app still boots green. That used to be a buried console.warn; surface
      // it loudly and report it to the control plane so a managed deploy isn't
      // silently running on a broken schema.
      if (outcome.failed.length > 0) {
        const summary = outcome.failed
          .map((f) => `${f.name}: ${f.error}`)
          .join("; ");
        console.error(
          `[auto-migrate] ${outcome.failed.length} migration(s) FAILED — schema may be incomplete. Run \`bun run db:migrate:${dialect}\` against the production DB. Failures: ${summary}`,
        );
        void reportToCloud(env, {
          kind: "error",
          message: `auto-migrate: ${outcome.failed.length} migration(s) failed — ${summary}`,
        });
      }
    } catch (e) {
      // Walk the Error.cause chain so the deepest driver/DB error surfaces.
      // Drizzle wraps every failure with a useless "Failed query: ..."
      // template — without this we'd only log the wrapper and waste log
      // budget on a non-actionable line.
      let cur: unknown = e;
      let deepest = "";
      for (let i = 0; cur && i < 5; i++) {
        const msg = (cur as { message?: unknown }).message;
        if (typeof msg === "string" && msg.length > 0) deepest = msg;
        cur = (cur as { cause?: unknown }).cause;
      }
      console.error(
        "[auto-migrate] failed; continuing boot. Run `bun run db:migrate:pg` against the production DB to apply any missing migrations. Error:",
        (e as Error).message,
        "Cause:",
        deepest || "(none)",
      );
    }
  }

  // The control-plane (admin) auth instance deliberately ships NO social
  // providers. Consumer OAuth (Google / Apple / GitHub) belongs to the
  // workspace end-user plane — each workspace's better-auth instance wires its
  // own social set from env + per-workspace `auth_config` (see
  // services/tenant-auth.ts::getTenantAuth). Operators sign into the dashboard
  // with email/password (+ passkey) and, going forward, enterprise SSO.

  // Deployment-level transport. On a managed cloud project the worker is
  // injected with no `EMAIL_*` vars, so the spec resolves to `console` (mail
  // never leaves the box) — in that case route through the control-plane email
  // gateway instead. A per-workspace `email_config` row still overrides this
  // (resolveEmailAdapter checks the DB first, falling back to `email`).
  const emailSpec = selectEmailSpec(env);
  const email: EmailAdapter =
    cloudConfigured(env) && emailSpec.provider === "console"
      ? cloudEmailAdapter(env)
      : (buildEmailAdapter(emailSpec) ?? consoleEmail());

  // `emailFor` resolves a tenant's stored email_config (with fallback) on
  // first call and caches the adapter. Cache is isolate-wide (one entry per
  // tenant); the admin email-config write path calls `invalidateEmailCache`
  // to drop a stale entry after an update so the next request rebuilds.
  const emailCache = new Map<string, Promise<EmailAdapter>>();
  emailCaches.set(env as unknown as object, emailCache);
  const emailFor = (tenantId: string | null | undefined): Promise<EmailAdapter> => {
    const key = tenantId ?? "";
    let p = emailCache.get(key);
    if (!p) {
      p = resolveEmailAdapter({ db, dialect, env }, email, tenantId ?? null);
      emailCache.set(key, p);
    }
    return p;
  };

  // Push transport — same env → cloud-fallback → per-workspace resolution as
  // email. On a managed cloud project with no `PUSH_*` vars the spec is
  // `console`, so route through the control-plane push gateway instead.
  const pushSpec = selectPushSpec(env);
  const push: PushAdapter =
    cloudConfigured(env) && pushSpec.provider === "console"
      ? cloudPushAdapter(env)
      : buildPushAdapter(pushSpec);
  const pushCache = new Map<string, Promise<PushAdapter>>();
  pushCaches.set(env as unknown as object, pushCache);
  const pushFor = (tenantId: string | null | undefined): Promise<PushAdapter> => {
    const key = tenantId ?? "";
    let p = pushCache.get(key);
    if (!p) {
      p = resolvePushAdapter({ db, dialect, env }, push, tenantId ?? null);
      pushCache.set(key, p);
    }
    return p;
  };

  // SMS transport — same env → cloud-fallback → per-workspace resolution as
  // push. On a managed cloud project with no `SMS_*` vars the spec is `console`,
  // so route through the control-plane SMS gateway instead.
  const smsSpec = selectSmsSpec(env);
  const sms: SMSAdapter =
    cloudConfigured(env) && smsSpec.provider === "console"
      ? cloudSmsAdapter(env)
      : buildSmsAdapter(smsSpec);
  const smsCache = new Map<string, Promise<SMSAdapter>>();
  smsCaches.set(env as unknown as object, smsCache);
  const smsFor = (tenantId: string | null | undefined): Promise<SMSAdapter> => {
    const key = tenantId ?? "";
    let p = smsCache.get(key);
    if (!p) {
      p = resolveSmsAdapter({ db, dialect, env }, sms, tenantId ?? null);
      smsCache.set(key, p);
    }
    return p;
  };

  const pluginList = (env.AUTH_PLUGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(
      (p): p is "magic-link" | "email-otp" | "anonymous" | "passkey" =>
        p === "magic-link" ||
        p === "email-otp" ||
        p === "anonymous" ||
        p === "passkey",
    );

  // Holds the fully assembled Ctx so hooks set up before the assignment can
  // still reach storage/vector/image once they're built.
  let fullCtx: Ctx | undefined;

  // Better-auth rejects every request whose `Origin` header isn't in
  // `trustedOrigins` with a 403 INVALID_ORIGIN. The same CORS allow-list
  // that fronts the rest of the API (cors() middleware in app.ts) lives
  // off `env.APP_URL` + `env.EXTRA_TRUSTED_ORIGINS` + the per-workspace
  // `auth_config.redirectUrls`; we mirror APP_URL + EXTRA_TRUSTED_ORIGINS
  // into better-auth so a multi-deploy setup (CF Worker + Vercel +
  // Netlify pointing at the same DB) doesn't lock UI sign-in to the one
  // canonical APP_URL.
  //
  // Workspace-level redirect URLs aren't merged here because better-auth
  // reads `trustedOrigins` exactly once at construction; refreshing them
  // would require rebuilding `auth` per-request. The cors() middleware
  // already honours the workspace list at the HTTP edge, which covers
  // OAuth / SAML / API key flows. The remaining gap — multi-host UI
  // sign-in — is what this env var addresses.
  const trustedOrigins = [env.APP_URL];
  if (env.EXTRA_TRUSTED_ORIGINS) {
    for (const o of env.EXTRA_TRUSTED_ORIGINS.split(",")) {
      const trimmed = o.trim();
      if (trimmed) trustedOrigins.push(trimmed);
    }
  }

  // Email-verification gating is opt-in per instance (auth_config.policy on the
  // instance-global `_global` row) AND only honoured when a real email
  // transport exists — gating login behind a verification mail the console
  // adapter only logs would lock every new user out. `requireEmailVerification`
  // is a better-auth construction-time flag, so a policy change takes effect on
  // the next isolate build (cheap on Workers; a restart on a single Bun
  // process). Read failures degrade to "off" so a fresh/un-migrated DB can
  // still boot and bootstrap its first admin.
  const hasRealEmail =
    cloudConfigured(env) || emailSpec.provider !== "console";
  let requireEmailVerification = false;
  if (hasRealEmail) {
    try {
      // Read the active workspace's policy (with the instance-global fallback
      // baked into loadPolicy → loadAuthConfigRow), mirroring how the admin
      // PATCH writes to `auth.tenantId ?? "_global"` and the discovery surface
      // reads it back. `ensureDefaultTenant` is idempotent — it returns the
      // existing default workspace, only creating one on a brand-new DB.
      const tenantId = await ensureDefaultTenant(dbCtx);
      const policy = await loadPolicy(dbCtx, tenantId);
      requireEmailVerification = policy.requireEmailVerification === true;
    } catch {
      requireEmailVerification = false;
    }
  }

  const auth = await createAuth(db, dialect, {
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins,
    // No social providers on the control plane — see the note above where the
    // env OAuth block used to build `social`.
    email,
    plugins: pluginList,
    requireEmailVerification,
    hooks: {
      onBeforeUserCreated: async ({ email }) => {
        // The first user bootstraps the instance admin. On a managed cloud
        // instance the provisioner pins OWNER_EMAIL so a stranger can't claim
        // the public instance URL before the real owner does; self-host leaves
        // it unset, so any first visitor may claim.
        const total = await userCount(dbCtx);
        if (total === 0) {
          const owner = env.OWNER_EMAIL?.trim().toLowerCase();
          if (owner && email.trim().toLowerCase() !== owner)
            return {
              allow: false,
              reason: "Only the project owner can claim this instance",
            };
          return { allow: true };
        }
        // An invited address may sign up even while public sign-up is closed —
        // that's how admins add users without opening the door to everyone.
        if (await hasValidInvite(dbCtx, email)) return { allow: true };
        const tenantId = await ensureDefaultTenant(dbCtx);
        const { openSignup } = await loadPolicy(dbCtx, tenantId);
        return { allow: openSignup === true, reason: "Sign-up is disabled" };
      },
      onUserCreated: async (user) => {
        // Land every new user in the default tenant. The first user becomes
        // owner; subsequent ones land as members until invited elsewhere.
        const tenantId = await ensureDefaultTenant(dbCtx);
        await ensureSystemRoles(dbCtx, tenantId);
        const total = await userCount(dbCtx);
        const role =
          total <= 1 ? SYSTEM_ROLES.admin : SYSTEM_ROLES.authenticated;
        await assignRoleByName(dbCtx, tenantId, user.id, role);
        // Zero-touch schema template: the first user is the cloud-seeded admin.
        // If the cloud passed a SEED_TEMPLATE, materialize its collections into
        // the default workspace now. Idempotent + best-effort — never blocks
        // sign-up.
        if (total <= 1 && env.SEED_TEMPLATE && getTemplate(env.SEED_TEMPLATE)) {
          try {
            await applyTemplate(dbCtx, tenantId, env.SEED_TEMPLATE);
          } catch (e) {
            console.error("[seed-template] apply failed", env.SEED_TEMPLATE, (e as Error).message);
          }
        }
        // Drop any cached "no roles" entry from the public path so the first
        // protected call after sign-up sees the freshly assigned role.
        invalidateUserRoles(tenantId, user.id);
        // If this sign-up matches a pending invite, bind that membership now so
        // the invited user lands as an active member of the inviting workspace
        // in one step — no separate signed-in `POST /accept` round-trip needed.
        // MUST run before `ensureTenantMembership`: for an invite into the
        // default workspace, ensureTenantMembership would otherwise promote
        // the invited row to `active` first, and the invite (with its role
        // grant) would no longer match.
        try {
          await acceptInviteForUser(dbCtx, user.id, user.email);
        } catch (e) {
          console.error("[invite] auto-accept failed", (e as Error).message);
        }
        await ensureTenantMembership(
          dbCtx,
          tenantId,
          user.id,
          user.email,
          total <= 1 ? "owner" : "member",
        );
        // Fan out to flows + webhooks. `fullCtx` is set at the bottom of
        // buildContext so it's available by the time a hook can fire.
        //
        // Best-effort: the signup event is broadcast over the REALTIME Durable
        // Object (`publishEvent` → `stub.fetch`), and on a freshly provisioned
        // Workers-for-Platforms instance that binding can be momentarily
        // unready — a throw there would otherwise escape the better-auth hook
        // and surface as a raw 1101/500 to a user who was, in fact, created
        // successfully. The actual sign-up has already committed by this point,
        // so a failed fan-out must never fail the request. Same swallow-and-log
        // policy as the invite auto-accept above.
        if (fullCtx) {
          try {
            await publishEvent(
              env,
              "auth",
              { event: "signup", data: { id: user.id, email: user.email, tenantId } },
              { db, dialect, email: fullCtx.email, fullCtx, tenantId },
            );
          } catch (e) {
            console.error("[auth] signup event publish failed", (e as Error).message);
          }
        }
      },
    },
  });

  // Storage selection priority:
  //   1. R2 binding (Cloudflare Workers) — fastest path on the edge.
  //   2. S3-compatible (S3_BUCKET set) — uses Bun.S3Client native when
  //      available, else aws4fetch for any runtime with WHATWG fetch.
  //   3. Local fs — serverful self-host only (Bun / Node / Deno `deno run`),
  //      NOT serverless functions (their fs is ephemeral per-invocation).
  let storage: StorageAdapter;
  if (env.R2) {
    storage = r2Storage(env.R2);
  } else if (
    env.S3_BUCKET &&
    env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY
  ) {
    const s3Cfg = {
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
    };
    storage = bunS3Storage(s3Cfg) ?? s3FetchStorage(s3Cfg);
  } else if (
    isStatelessEdge() ||
    isCloudflareWorkers() ||
    isNetlify() ||
    isVercel()
  ) {
    // No durable filesystem on any edge runtime OR ephemeral serverless
    // function (Vercel/Netlify Node functions): the local-fs adapter would
    // silently lose every upload between invocations, so fail loudly instead.
    throw new AppError(
      "UNAVAILABLE",
      "This runtime has no persistent filesystem — set an R2 binding (Cloudflare) or S3-compatible config (S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY).",
    );
  } else {
    storage = fsStorage("./.data/files");
  }

  // Vector storage: prefer Vectorize on Workers (one binding per model so
  // each index keeps its own dimension). On Postgres, pgvector handles the
  // routing per-table — unless the target is Xata (no pgvector extension),
  // in which case we fall through to noVectorAdapter so the vector endpoints
  // fail with a clear "configure Vectorize" message instead of a cryptic
  // "type vector does not exist" at first upsert. On the libSQL / Turso
  // transport (SQLite dialect, LIBSQL_URL set, not D1) the engine has native
  // vector functions, so vectors live in-database — no Vectorize needed. Bun
  // SQLite and D1 have no vector primitives, so they still fall through to
  // noVectorAdapter (or Vectorize on Workers) and fail loud.
  const vectorizeBindings: VectorizeIndexMap = {};
  if (env.VECTORIZE_OPENAI) vectorizeBindings["openai-3-small"] = env.VECTORIZE_OPENAI;
  if (env.VECTORIZE_OPENAI_LARGE) vectorizeBindings["openai-3-large"] = env.VECTORIZE_OPENAI_LARGE;
  if (env.VECTORIZE_BGE_M3) vectorizeBindings["bge-m3"] = env.VECTORIZE_BGE_M3;
  if (env.VECTORIZE_SELF_HOST_BGE_M3) vectorizeBindings["self-host-bge-m3"] = env.VECTORIZE_SELF_HOST_BGE_M3;
  const hasAnyVectorize =
    Object.keys(vectorizeBindings).length > 0;

  // External stores are per-model for the same reason Vectorize is: an index /
  // collection fixes its vector dimension at creation. A configured API key
  // with no index for a model still counts as "this store is in use" — the
  // adapter throws a specific "no index for <model>" on that model rather than
  // silently falling through to a different store.
  const pineconeHosts: PineconeHostMap = {};
  if (env.PINECONE_INDEX_OPENAI) pineconeHosts["openai-3-small"] = env.PINECONE_INDEX_OPENAI;
  if (env.PINECONE_INDEX_OPENAI_LARGE) pineconeHosts["openai-3-large"] = env.PINECONE_INDEX_OPENAI_LARGE;
  if (env.PINECONE_INDEX_BGE_M3) pineconeHosts["bge-m3"] = env.PINECONE_INDEX_BGE_M3;
  if (env.PINECONE_INDEX_SELF_HOST_BGE_M3)
    pineconeHosts["self-host-bge-m3"] = env.PINECONE_INDEX_SELF_HOST_BGE_M3;
  const hasPinecone = Boolean(env.PINECONE_API_KEY) && Object.keys(pineconeHosts).length > 0;

  const qdrantCollections: QdrantCollectionMap = {};
  if (env.QDRANT_COLLECTION_OPENAI) qdrantCollections["openai-3-small"] = env.QDRANT_COLLECTION_OPENAI;
  if (env.QDRANT_COLLECTION_OPENAI_LARGE)
    qdrantCollections["openai-3-large"] = env.QDRANT_COLLECTION_OPENAI_LARGE;
  if (env.QDRANT_COLLECTION_BGE_M3) qdrantCollections["bge-m3"] = env.QDRANT_COLLECTION_BGE_M3;
  if (env.QDRANT_COLLECTION_SELF_HOST_BGE_M3)
    qdrantCollections["self-host-bge-m3"] = env.QDRANT_COLLECTION_SELF_HOST_BGE_M3;
  const hasQdrant = Boolean(env.QDRANT_URL) && Object.keys(qdrantCollections).length > 0;

  const pgHasPgvector = dialect === "pg" && !isXataPgUrl(pgUrl);
  const sqliteHasLibsqlVectors =
    !override && dialect === "sqlite" && !!env.LIBSQL_URL && !env.D1;
  // Explicitly-configured stores win over the dialect's implicit one: someone
  // who wires Pinecone on a Postgres deployment means it.
  const vector: VectorAdapter = hasAnyVectorize
    ? vectorizeAdapter(vectorizeBindings)
    : hasPinecone
      ? pineconeVectorAdapter({ apiKey: env.PINECONE_API_KEY!, hosts: pineconeHosts })
      : hasQdrant
        ? qdrantVectorAdapter({
            url: env.QDRANT_URL!,
            ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
            collections: qdrantCollections,
          })
        : pgHasPgvector
          ? pgvectorAdapter(db as PgDb)
          : sqliteHasLibsqlVectors
            ? libsqlVectorAdapter(db as SqliteDb)
            : noVectorAdapter();

  // Embedding (text → vector). Models are routed to providers by the
  // registry: bge-m3 → Workers AI, openai-3-small → OpenAI. A model whose
  // provider isn't configured here fails loudly when invoked.
  //
  // On a managed cloud project the Workers-AI provider runs through the
  // control-plane gateway (metered + hard-capped per plan) instead of the
  // tenant's own env.AI — the customer brings no AI key, so their embeddings
  // are our cost. OpenAI / self-host stay on the customer's own keys (their
  // cost), so they're never proxied.
  const managedCloud = cloudConfigured(env);
  const workersAiEmbedding = managedCloud
    ? cloudEmbeddingAdapter(env)
    : env.AI
      ? workersAiEmbeddingAdapter(env.AI)
      : null;
  const hasAnyEmbeddingProvider =
    workersAiEmbedding || env.OPENAI_API_KEY || env.EMBEDDING_HTTP_URL;
  const embedding: EmbeddingAdapter = hasAnyEmbeddingProvider
    ? embeddingRouter({
        ...(workersAiEmbedding ? { "workers-ai": workersAiEmbedding } : {}),
        ...(env.OPENAI_API_KEY
          ? { openai: openaiEmbeddingAdapter(env.OPENAI_API_KEY) }
          : {}),
        ...(env.EMBEDDING_HTTP_URL
          ? {
              "self-host": selfHostEmbeddingAdapter({
                baseUrl: env.EMBEDDING_HTTP_URL,
                token: env.EMBEDDING_HTTP_TOKEN,
              }),
            }
          : {}),
      })
    : noEmbeddingAdapter();

  // Vector-search readiness, derived from the exact same env checks that
  // picked the `vector` + `embedding` adapters above — the admin UI reads
  // this to disable models whose provider/store isn't configured.
  const providerReady: Record<"workers-ai" | "openai" | "self-host", boolean> = {
    "workers-ai": Boolean(workersAiEmbedding),
    openai: Boolean(env.OPENAI_API_KEY),
    "self-host": Boolean(env.EMBEDDING_HTTP_URL),
  };
  const vectorStore = hasAnyVectorize
    ? ("vectorize" as const)
    : hasPinecone
      ? ("pinecone" as const)
      : hasQdrant
        ? ("qdrant" as const)
        : pgHasPgvector
          ? ("pgvector" as const)
          : sqliteHasLibsqlVectors
            ? ("libsql" as const)
            : ("none" as const);
  const vectorCaps: VectorCapabilities = {
    store: vectorStore,
    defaultModel: isEmbeddingModel(env.EMBEDDING_DEFAULT_MODEL)
      ? env.EMBEDDING_DEFAULT_MODEL
      : null,
    models: Object.fromEntries(
      EMBEDDING_MODEL_NAMES.map((m) => [
        m,
        providerReady[EMBEDDING_MODELS[m].provider] &&
          // Per-model stores are only ready for the models they have an index
          // for; pgvector/libsql hold any dimension in one table.
          (vectorStore === "vectorize"
            ? Boolean(vectorizeBindings[m])
            : vectorStore === "pinecone"
              ? Boolean(pineconeHosts[m])
              : vectorStore === "qdrant"
                ? Boolean(qdrantCollections[m])
                : vectorStore !== "none"),
      ]),
    ) as Record<EmbeddingModel, boolean>,
  };

  // Image transform: Bun's built-in image API (self-host) → sharp (Node
  // serverless / any Node host, if the native addon loads) → passthrough. CF
  // Workers don't use this field; they resize at the edge in the storage route.
  const image: ImageAdapter =
    bunImage() ?? (await sharpImage()) ?? (await wasmImage()) ?? passthroughImage();
  // URL-based edge resize backends — the only two runtimes with one. This is
  // the single place that knows which runtime maps to which edge backend; the
  // serve path just checks `ctx.edgeImage`.
  const edgeImage = isCloudflareWorkers()
    ? cfEdgeImage()
    : isNetlify()
      ? netlifyEdgeImage()
      : undefined;

  // PDF: an explicit `PDF_PROVIDER` wins; otherwise whichever has usable
  // credentials, Cloudflare first because it needs no infrastructure. Left
  // undefined when neither is configured — there is deliberately no fallback
  // renderer (see the adapter contract for why).
  const pdf = selectPdfAdapter(env);
  const geocode = selectGeocodeAdapter(env);

  const ctx: Ctx = {
    env,
    dialect,
    db,
    dbRead,
    txCapable,
    auth,
    email,
    emailFor,
    push,
    pushFor,
    sms,
    smsFor,
    storage,
    vector,
    embedding,
    vectorCaps,
    image,
    pdf,
    geocode,
    edgeImage,
  };
  // Late-bind so the `onUserCreated` closure can publish events through the
  // fully assembled Ctx (runFlows + webhook dispatch need `fullCtx`).
  fullCtx = ctx;
  // Point token signing/verification at the `signing_keys` rows. Registered
  // here because `signAccessToken` takes only an `Env`; the source falls back
  // to the env keys whenever there are no rows, so an instance that never uses
  // the feature behaves exactly as it did before it existed. See
  // `services/signing-keys.ts`.
  bindSigningKeysToDatabase(ctx);
  ctxCache.set(env as unknown as object, ctx);
  return ctx;
};

const noVectorAdapter = (): VectorAdapter => {
  const fail = () => {
    throw new Error(
      "No vector backend configured. Set DATABASE_URL to a Postgres with pgvector (self-host PG, Supabase, Neon), set LIBSQL_URL to a Turso/libSQL database for native SQLite vectors, or bind VECTORIZE_OPENAI / VECTORIZE_BGE_M3 on Cloudflare Workers. Plain Bun SQLite and D1 have no vector primitives; Xata does not ship pgvector — pair either with Vectorize or use Turso/Postgres.",
    );
  };
  return { upsert: fail, query: fail, delete: fail };
};
