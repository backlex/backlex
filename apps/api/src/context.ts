import { createPgClient, type PgDb } from "@workeros/db/pg";
import { createD1Client, createBunSqliteClient, type SqliteDb } from "@workeros/db/sqlite";
import { createAuth, type Auth } from "@workeros/auth";
import type { StorageAdapter, VectorAdapter } from "@workeros/core/adapters";
import { fsStorage } from "./adapters/storage.fs";
import { r2Storage } from "./adapters/storage.r2";
import { pgvectorAdapter } from "./adapters/vector.pg";
import { vectorizeAdapter } from "./adapters/vector.cf";
import type { Env } from "./env";

export interface Ctx {
  env: Env;
  dialect: "pg" | "sqlite";
  db: PgDb | SqliteDb;
  auth: Auth;
  storage: StorageAdapter;
  vector: VectorAdapter;
}

export const buildContext = (env: Env): Ctx => {
  const dialect: "pg" | "sqlite" =
    env.D1 ? "sqlite" : env.DATABASE_URL ? "pg" : "sqlite";

  const db: PgDb | SqliteDb = env.D1
    ? createD1Client(env.D1)
    : env.DATABASE_URL
      ? createPgClient(env.DATABASE_URL)
      : createBunSqliteClient();

  const auth = createAuth(db, dialect, {
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
  });

  const storage: StorageAdapter = env.R2 ? r2Storage(env.R2) : fsStorage("./.data/files");

  const vector: VectorAdapter = env.VECTORIZE
    ? vectorizeAdapter(env.VECTORIZE)
    : dialect === "pg"
      ? pgvectorAdapter(db as PgDb)
      : noVectorAdapter();

  return { env, dialect, db, auth, storage, vector };
};

const noVectorAdapter = (): VectorAdapter => {
  const fail = () => {
    throw new Error(
      "No vector backend configured. Set DATABASE_URL (with pgvector) or bind VECTORIZE.",
    );
  };
  return { upsert: fail, query: fail, delete: fail };
};
