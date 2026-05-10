import { createPgClient, type PgDb } from "@workeros/db/pg";
import { createD1Client, createBunSqliteClient, type SqliteDb } from "@workeros/db/sqlite";
import { createAuth, type Auth, type OAuthProviderConfig } from "@workeros/auth";
import { SYSTEM_ROLES } from "@workeros/core";
import type {
  EmailAdapter,
  ImageAdapter,
  StorageAdapter,
  VectorAdapter,
} from "@workeros/core/adapters";
import { fsStorage } from "./adapters/storage.fs";
import { r2Storage } from "./adapters/storage.r2";
import { bunS3Storage } from "./adapters/storage.s3.bun";
import { s3FetchStorage } from "./adapters/storage.s3.fetch";
import { pgvectorAdapter } from "./adapters/vector.pg";
import { vectorizeAdapter } from "./adapters/vector.cf";
import { consoleEmail } from "./adapters/email.console";
import { resendEmail } from "./adapters/email.resend";
import { bunImage } from "./adapters/image.bun";
import { passthroughImage } from "./adapters/image.passthrough";
import {
  ensureSystemRoles,
  assignRoleByName,
  ensureDefaultTenant,
  ensureTenantMembership,
  userCount,
} from "./services/seed";
import { publishEvent } from "./services/events";
import type { Env } from "./env";

export interface Ctx {
  env: Env;
  dialect: "pg" | "sqlite";
  db: PgDb | SqliteDb;
  auth: Auth;
  email: EmailAdapter;
  storage: StorageAdapter;
  vector: VectorAdapter;
  image: ImageAdapter;
}

export const buildContext = (env: Env): Ctx => {
  const dialect: "pg" | "sqlite" =
    env.D1 ? "sqlite" : env.DATABASE_URL ? "pg" : "sqlite";

  const db: PgDb | SqliteDb = env.D1
    ? createD1Client(env.D1)
    : env.DATABASE_URL
      ? createPgClient(env.DATABASE_URL)
      : createBunSqliteClient();

  const dbCtx = { db, dialect };

  const social: { google?: OAuthProviderConfig; github?: OAuthProviderConfig } = {};
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

  const email: EmailAdapter =
    env.RESEND_API_KEY && env.EMAIL_FROM
      ? resendEmail(env.RESEND_API_KEY, env.EMAIL_FROM)
      : consoleEmail();

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

  const vector: VectorAdapter = env.VECTORIZE
    ? vectorizeAdapter(env.VECTORIZE)
    : dialect === "pg"
      ? pgvectorAdapter(db as PgDb)
      : noVectorAdapter();

  // Image transform: prefer Bun's built-in image API when available; fall
  // back to passthrough so the route still works (just without resizing).
  const image: ImageAdapter = bunImage() ?? passthroughImage();

  const ctx: Ctx = { env, dialect, db, auth, email, storage, vector, image };
  // Late-bind so the `onUserCreated` closure can publish events through the
  // fully assembled Ctx (runFlows + webhook dispatch need `fullCtx`).
  fullCtx = ctx;
  return ctx;
};

const noVectorAdapter = (): VectorAdapter => {
  const fail = () => {
    throw new Error(
      "No vector backend configured. Set DATABASE_URL (with pgvector) or bind VECTORIZE.",
    );
  };
  return { upsert: fail, query: fail, delete: fail };
};
