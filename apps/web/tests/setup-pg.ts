/**
 * Postgres test harness — boots an in-process pglite, loads the pgvector
 * extension, applies every `packages/db/drizzle/pg` migration, and injects
 * the resulting drizzle client into `buildContext` via
 * `__setDbOverrideForTests`. Returns the same shape as the SQLite harness so
 * spec files can share fixtures.
 *
 * Why pglite: it ships a WASM Postgres that runs in-process, no Docker, no
 * external server. The trade-offs vs real Postgres are minor for our use
 * (no LISTEN/NOTIFY, no parallel queries) and the extension surface we need
 * (pgvector) is supported.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@workeros/db/pg";
import { createApp } from "../src/server/app";
import { __setDbOverrideForTests } from "../src/server/context";
import type { Env } from "../src/server/env";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const MIGRATIONS = resolve(ROOT, "packages/db/drizzle/pg");

export interface PgTestHarness {
  env: Env;
  app: ReturnType<typeof createApp>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  cookies: () => Record<string, string>;
  cleanup: () => Promise<void>;
}

const DEFAULT_APP_URL = "http://localhost:5173";

/** Apply every migration file under `MIGRATIONS` to the pglite instance, in
 *  ascending directory order. We bypass drizzle-kit's migrator because it
 *  wants a real connection string; pglite's `exec` runs raw SQL fine. */
const applyPgMigrations = async (
  db: ReturnType<typeof drizzle>,
  pg: PGlite,
): Promise<void> => {
  // Wait for the WASM postgres + extension bundles (vector.tar.gz) to finish
  // unpacking before issuing the first CREATE EXTENSION — otherwise the
  // control file lookup races the extension loader.
  await pg.waitReady;
  // Enable pgvector so the `vector(N)` column types in later migrations parse.
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS vector"));

  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const file = resolve(MIGRATIONS, dir, "migration.sql");
    const body = readFileSync(file, "utf8");
    // drizzle-kit emits statement-breakpoint markers; split on them so each
    // statement runs as a single `exec` call (pglite doesn't accept some
    // multi-statement bundles).
    const statements = body
      .split(/-->\s*statement-breakpoint\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
  }
};

export const makeHarnessPg = async (
  overrides: Partial<Env> = {},
): Promise<PgTestHarness> => {
  const pg = new PGlite({ extensions: { vector } });
  const db = drizzle(pg, { schema });
  await applyPgMigrations(db, pg);

  const env: Env = {
    APP_URL: DEFAULT_APP_URL,
    AUTH_SECRET: "test-secret-not-for-prod-but-stable-across-calls",
    DATABASE_URL: "postgres://pglite-in-memory",
    ...overrides,
  };
  __setDbOverrideForTests(env, db as unknown as Parameters<typeof __setDbOverrideForTests>[1], "pg");

  const app = createApp(env);

  const cookieJar = new Map<string, string>();
  const syntheticIp = `127.0.${(Math.random() * 250 + 1) | 0}.${
    (Math.random() * 250 + 1) | 0
  }`;
  const fetchWithCookies = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = input.startsWith("http") ? input : `${env.APP_URL}${input}`;
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Origin")) headers.set("Origin", env.APP_URL);
    if (!headers.has("X-Forwarded-For"))
      headers.set("X-Forwarded-For", syntheticIp);
    if (cookieJar.size > 0) {
      const cookieHeader = [...cookieJar.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      headers.set("Cookie", cookieHeader);
    }
    const res = await app.fetch(new Request(url, { ...init, headers }));
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value === "" || value === "deleted") cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
    return res;
  };

  return {
    env,
    app,
    fetch: fetchWithCookies,
    cookies: () => Object.fromEntries(cookieJar),
    cleanup: async () => {
      try {
        await pg.close();
      } catch {
        // already closed
      }
    },
  };
};
