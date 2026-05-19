import { createPgClient, type PgDb } from "@workeros/db/pg";
import { createD1Client, createBunSqliteClient, type SqliteDb } from "@workeros/db/sqlite";
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
import { publishEvent } from "./services/events";
import type { Env } from "./env";

export interface Ctx {
  env: Env;
  dialect: "pg" | "sqlite";
  db: PgDb | SqliteDb;
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

export const buildContext = (env: Env): Ctx => {
  const cached = ctxCache.get(env as unknown as object);
  if (cached) return cached;

  const dialect: "pg" | "sqlite" =
    env.D1 ? "sqlite" : env.DATABASE_URL ? "pg" : "sqlite";

  const db: PgDb | SqliteDb = env.D1
    ? createD1Client(env.D1)
    : env.DATABASE_URL
      ? createPgClient(env.DATABASE_URL)
      : createBunSqliteClient(env.SQLITE_PATH);

  const dbCtx = { db, dialect };

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

  const auth = createAuth(db, dialect, {
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
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
  } else {
    storage = fsStorage("./.data/files");
  }

  // Vector storage: prefer Vectorize on Workers (one binding per model so
  // each index keeps its own dimension). On Postgres, pgvector handles the
  // routing per-table. Otherwise (SQLite without Vectorize) fail loud.
  const vectorizeBindings: VectorizeIndexMap = {};
  if (env.VECTORIZE_OPENAI) vectorizeBindings["openai-3-small"] = env.VECTORIZE_OPENAI;
  if (env.VECTORIZE_OPENAI_LARGE) vectorizeBindings["openai-3-large"] = env.VECTORIZE_OPENAI_LARGE;
  if (env.VECTORIZE_BGE_M3) vectorizeBindings["bge-m3"] = env.VECTORIZE_BGE_M3;
  if (env.VECTORIZE_SELF_HOST_BGE_M3) vectorizeBindings["self-host-bge-m3"] = env.VECTORIZE_SELF_HOST_BGE_M3;
  const hasAnyVectorize =
    Object.keys(vectorizeBindings).length > 0;
  const vector: VectorAdapter = hasAnyVectorize
    ? vectorizeAdapter(vectorizeBindings)
    : dialect === "pg"
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
      "No vector backend configured. Set DATABASE_URL (with pgvector) or bind VECTORIZE_OPENAI / VECTORIZE_BGE_M3.",
    );
  };
  return { upsert: fail, query: fail, delete: fail };
};
