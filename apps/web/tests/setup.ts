/**
 * Test harness — builds a Hono app on a fresh temp SQLite per suite, applies
 * the dialect-matched migrations, and returns `{ app, env, fetch }` helpers.
 *
 * Tests never spin up a real server; they call `app.fetch(req)` directly so
 * the request/response stays in-process. Cookies are tracked across calls
 * via the returned `fetch` so auth flows look the same as in a real browser.
 */
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app";
import type { Env } from "../src/server/env";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const MIGRATIONS = resolve(ROOT, "packages/db/drizzle/sqlite");

export interface TestHarness {
  env: Env;
  app: ReturnType<typeof createApp>;
  /** Cookie-tracking fetch wrapper. Pass relative or absolute URLs; only
   *  the path matters since the app is invoked directly. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Snapshot of cookies the harness is currently sending. */
  cookies: () => Record<string, string>;
  /** Remove the temp SQLite file and any rollback artefacts. */
  cleanup: () => void;
}

const DEFAULT_APP_URL = "http://localhost:5173";

export const makeHarness = (overrides: Partial<Env> = {}): TestHarness => {
  const dbPath = resolve(tmpdir(), `workeros-test-${randomUUID()}.sqlite`);
  mkdirSync(dirname(dbPath), { recursive: true });

  const migClient = new Database(dbPath, { create: true });
  migClient.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: migClient }), { migrationsFolder: MIGRATIONS });
  migClient.close();

  const env: Env = {
    APP_URL: DEFAULT_APP_URL,
    AUTH_SECRET: "test-secret-not-for-prod-but-stable-across-calls",
    SQLITE_PATH: dbPath,
    ...overrides,
  };

  const app = createApp(env);

  const cookieJar = new Map<string, string>();
  // Each harness gets its own synthetic client IP so the module-level
  // auth-rate-limit windows (lib/auth-rate-limit.ts) don't accumulate across
  // unrelated describe blocks in the same bun-test process. Without this a
  // batch of test files that legitimately sign up many users from the same
  // empty/"unknown" IP would tip the signup limit and start 429-ing.
  // Tests that explicitly want to exercise the limiter can set their own
  // X-Forwarded-For via the init argument.
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
    // Persist any Set-Cookie cookies the response wants the browser to keep.
    // We only need name=value; better-auth doesn't rely on attributes when
    // it parses the next request's Cookie header.
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
    cleanup: () => {
      try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
      // bun-sqlite WAL companions
      try { rmSync(`${dbPath}-wal`, { force: true }); } catch { /* ignore */ }
      try { rmSync(`${dbPath}-shm`, { force: true }); } catch { /* ignore */ }
    },
  };
};

/** Sign up + sign in as a fresh admin (the first user of a brand-new DB
 *  is auto-promoted via the `onUserCreated` hook in context.ts). */
export const seedAdmin = async (
  h: TestHarness,
  email = `admin-${Date.now()}@example.test`,
  password = "correct-horse-battery",
): Promise<{ email: string; password: string }> => {
  const res = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Test Admin" }),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  return { email, password };
};
