import { createPgClient, type PgDb, type PgDriver } from "@workeros/db/pg";
import { createD1Client, type SqliteDb } from "@workeros/db/sqlite";
import { ensureMigrations } from "@workeros/db";
import { createAuth, type Auth, type OAuthProviderConfig } from "@workeros/auth";
import { SYSTEM_ROLES } from "@workeros/core";
import type {
  EmailAdapter,
  EmbeddingAdapter,
  ImageAdapter,
  StorageAdapter,
  VectorAdapter,
} from "@workeros/core/adapters";
import { fsStorage } from "./adapters/storage.fs";
import { r2Storage } from "./adapters/storage.r2";
import { bunS3Storage } from "./adapters/storage.s3.bun";
import { s3FetchStorage } from "./adapters/storage.s3.fetch";
import { pgvectorAdapter } from "./adapters/vector.pg";
import {
  vectorizeAdapter,
  type VectorizeIndexMap,
} from "./adapters/vector.cf";
import { workersAiEmbeddingAdapter } from "./adapters/embedding.workers-ai";
import { openaiEmbeddingAdapter } from "./adapters/embedding.openai";
import { selfHostEmbeddingAdapter } from "./adapters/embedding.self-host";
import {
  embeddingRouter,
  noEmbeddingAdapter,
} from "./adapters/embedding.router";
import { selectEmailAdapter } from "./lib/email-select";
import { resolveEmailAdapter } from "./services/email-config";
import { bunImage } from "./adapters/image.bun";
import { passthroughImage } from "./adapters/image.passthrough";
import {
  ensureSystemRoles,
  assignRoleByName,
  ensureDefaultTenant,
  ensureTenantMembership,
  userCount,
} from "./services/seed";
import { loadAppSettings } from "./services/settings";
import { invalidateUserRoles } from "./services/permissions-cache";
import { publishEvent } from "./services/events";
import { isCloudflareWorkers, isStatelessEdge, isXataPgUrl } from "./lib/runtime";
import { AppError } from "@workeros/core";
import type { Env } from "./env";

export interface Ctx {
  env: Env;
  dialect: "pg" | "sqlite";
  db: PgDb | SqliteDb;
  /** Read-only client for lag-tolerant queries. Points at the configured
   *  Postgres read replica when `HYPERDRIVE_REPLICA` / `DATABASE_REPLICA_URL`
   *  is set; otherwise falls back to {@link Ctx.db}. SQLite/D1 always alias
   *  the primary. Do NOT use for reads-after-write — replication lag means
   *  the row may not be visible yet. Default everywhere else is `ctx.db`;
   *  routes opt in by saying `ctx.dbRead` explicitly. */
  dbRead: PgDb | SqliteDb;
  auth: Auth;
  /** Deployment-level email adapter (env-derived). Most callers should prefer
   *  {@link Ctx.emailFor} so a workspace's own `email_config` is honoured. */
  email: EmailAdapter;
  /** Resolve the email transport for a workspace: its own `email_config` row
   *  → the instance `_global` row → the deployment env adapter. Memoized per
   *  request. Pass `null` for system mail with no workspace context. */
  emailFor: (tenantId: string | null | undefined) => Promise<EmailAdapter>;
  storage: StorageAdapter;
  vector: VectorAdapter;
  /** Text → vector embedding. Routes to Workers AI or OpenAI based on the
   *  requested model (see `EMBEDDING_MODELS`). Throws if the model's
   *  provider isn't configured. */
  embedding: EmbeddingAdapter;
  image: ImageAdapter;
}

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
  p.finally(() => ctxBuilding.delete(env as unknown as object));
  return p;
};

const assembleContext = async (env: Env): Promise<Ctx> => {
  const override = testDbOverrides.get(env as unknown as object);

  // Picks the most specific available PG URL. Hyperdrive (CF Workers) sits in
  // front of the real Postgres and is the connection clients should use when
  // bound; we fall back to `DATABASE_URL` everywhere else.
  const pgUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;

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

  let db: PgDb | SqliteDb;
  let pgDriver: PgDriver | undefined;
  if (override) {
    db = override.db;
  } else if (env.D1) {
    db = createD1Client(env.D1);
  } else if (env.LIBSQL_URL) {
    // libSQL is fetch-based — works on every runtime including Vercel Edge
    // and Netlify Edge, so the import is unconditional (no bun:sqlite-style
    // dynamic gating needed). The module is lazy-loaded only to keep the
    // top-level sqlite barrel free of @libsql/client at module init.
    const { createLibsqlClient } = await import("@workeros/db/sqlite/libsql");
    db = createLibsqlClient(env.LIBSQL_URL, env.LIBSQL_AUTH_TOKEN);
  } else if (pgUrl) {
    // Default driver: postgres-js. Force neon-http on Vercel Edge (no
    // node:net); allow explicit override on every runtime.
    pgDriver =
      env.DATABASE_DRIVER ??
      (isStatelessEdge() ? "neon-http" : "postgres-js");
    if (pgDriver === "postgres-js" && isStatelessEdge()) {
      throw new AppError(
        "UNAVAILABLE",
        "postgres-js does not work on Vercel Edge — set DATABASE_DRIVER=neon-http",
      );
    }
    db = createPgClient(pgUrl, pgDriver);
  } else {
    // SQLite + no D1 → Bun self-host. Dynamically import so the top-level
    // sqlite module stays edge-safe (no `bun:sqlite` at module init).
    const { createBunSqliteClient } = await import("@workeros/db/sqlite/bun");
    db = createBunSqliteClient(env.SQLITE_PATH);
  }

  // Read replica (pg only). HYPERDRIVE_REPLICA (Workers) wins over the raw
  // URL — same precedence as the primary. Tests share the override; SQLite/D1
  // alias the primary because there's no replica equivalent. The driver
  // tracks the primary so behaviour stays consistent across runtimes.
  const pgReplicaUrl =
    dialect === "pg"
      ? env.HYPERDRIVE_REPLICA?.connectionString ?? env.DATABASE_REPLICA_URL
      : undefined;
  const dbRead: PgDb | SqliteDb =
    pgReplicaUrl && pgDriver && !override
      ? createPgClient(pgReplicaUrl, pgDriver)
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
      await ensureMigrations(db as Parameters<typeof ensureMigrations>[0], dialect);
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

  const social: {
    google?: OAuthProviderConfig;
    github?: OAuthProviderConfig;
    apple?: OAuthProviderConfig;
  } = {};
  if (env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET) {
    social.google = {
      clientId: env.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET) {
    social.github = {
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
    };
  }
  if (env.OAUTH_APPLE_CLIENT_ID && env.OAUTH_APPLE_CLIENT_SECRET) {
    social.apple = {
      clientId: env.OAUTH_APPLE_CLIENT_ID,
      clientSecret: env.OAUTH_APPLE_CLIENT_SECRET,
    };
  }

  const email: EmailAdapter = selectEmailAdapter(env);

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

  const auth = createAuth(db, dialect, {
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins,
    socialProviders: Object.keys(social).length > 0 ? social : undefined,
    email,
    plugins: pluginList,
    hooks: {
      onBeforeUserCreated: async () => {
        // The first user always gets in — that's how a fresh instance
        // bootstraps its admin. After that, honour the `openSignup` setting.
        const total = await userCount(dbCtx);
        if (total === 0) return { allow: true };
        const tenantId = await ensureDefaultTenant(dbCtx);
        const { openSignup } = await loadAppSettings(db, dialect, tenantId);
        return { allow: openSignup, reason: "Sign-up is disabled" };
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
        // Drop any cached "no roles" entry from the public path so the first
        // protected call after sign-up sees the freshly assigned role.
        invalidateUserRoles(tenantId, user.id);
        await ensureTenantMembership(
          dbCtx,
          tenantId,
          user.id,
          user.email,
          total <= 1 ? "owner" : "member",
        );
        // Fan out to flows + webhooks. `fullCtx` is set at the bottom of
        // buildContext so it's available by the time a hook can fire.
        if (fullCtx) {
          await publishEvent(
            env,
            "auth",
            { event: "signup", data: { id: user.id, email: user.email, tenantId } },
            { db, dialect, email: fullCtx.email, fullCtx, tenantId },
          );
        }
      },
    },
  });

  // Storage selection priority:
  //   1. R2 binding (Cloudflare Workers) — fastest path on the edge.
  //   2. S3-compatible (S3_BUCKET set) — uses Bun.S3Client native when
  //      available, else aws4fetch for any runtime with WHATWG fetch.
  //   3. Local fs — Bun self-host dev only.
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
  } else if (isStatelessEdge() || isCloudflareWorkers()) {
    // No persistent FS on any edge runtime; the local-fs adapter would
    // silently lose every upload between invocations.
    throw new AppError(
      "UNAVAILABLE",
      "Edge runtime requires R2 binding (Cloudflare) or S3-compatible config (S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY).",
    );
  } else {
    storage = fsStorage("./.data/files");
  }

  // Vector storage: prefer Vectorize on Workers (one binding per model so
  // each index keeps its own dimension). On Postgres, pgvector handles the
  // routing per-table — unless the target is Xata (no pgvector extension),
  // in which case we fall through to noVectorAdapter so the vector endpoints
  // fail with a clear "configure Vectorize" message instead of a cryptic
  // "type vector does not exist" at first upsert. Otherwise (SQLite without
  // Vectorize) fail loud.
  const vectorizeBindings: VectorizeIndexMap = {};
  if (env.VECTORIZE_OPENAI) vectorizeBindings["openai-3-small"] = env.VECTORIZE_OPENAI;
  if (env.VECTORIZE_OPENAI_LARGE) vectorizeBindings["openai-3-large"] = env.VECTORIZE_OPENAI_LARGE;
  if (env.VECTORIZE_BGE_M3) vectorizeBindings["bge-m3"] = env.VECTORIZE_BGE_M3;
  if (env.VECTORIZE_SELF_HOST_BGE_M3) vectorizeBindings["self-host-bge-m3"] = env.VECTORIZE_SELF_HOST_BGE_M3;
  const hasAnyVectorize =
    Object.keys(vectorizeBindings).length > 0;
  const pgHasPgvector = dialect === "pg" && !isXataPgUrl(pgUrl);
  const vector: VectorAdapter = hasAnyVectorize
    ? vectorizeAdapter(vectorizeBindings)
    : pgHasPgvector
      ? pgvectorAdapter(db as PgDb)
      : noVectorAdapter();

  // Embedding (text → vector). Models are routed to providers by the
  // registry: bge-m3 → Workers AI, openai-3-small → OpenAI. A model whose
  // provider isn't configured here fails loudly when invoked.
  const hasAnyEmbeddingProvider =
    env.AI || env.OPENAI_API_KEY || env.EMBEDDING_HTTP_URL;
  const embedding: EmbeddingAdapter = hasAnyEmbeddingProvider
    ? embeddingRouter({
        ...(env.AI ? { "workers-ai": workersAiEmbeddingAdapter(env.AI) } : {}),
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

  // Image transform: prefer Bun's built-in image API when available; fall
  // back to passthrough so the route still works (just without resizing).
  const image: ImageAdapter = bunImage() ?? passthroughImage();

  const ctx: Ctx = {
    env,
    dialect,
    db,
    dbRead,
    auth,
    email,
    emailFor,
    storage,
    vector,
    embedding,
    image,
  };
  // Late-bind so the `onUserCreated` closure can publish events through the
  // fully assembled Ctx (runFlows + webhook dispatch need `fullCtx`).
  fullCtx = ctx;
  ctxCache.set(env as unknown as object, ctx);
  return ctx;
};

const noVectorAdapter = (): VectorAdapter => {
  const fail = () => {
    throw new Error(
      "No vector backend configured. Set DATABASE_URL to a Postgres with pgvector (self-host PG, Supabase, Neon) or bind VECTORIZE_OPENAI / VECTORIZE_BGE_M3 on Cloudflare Workers. Xata does not ship pgvector; pair it with Vectorize.",
    );
  };
  return { upsert: fail, query: fail, delete: fail };
};
