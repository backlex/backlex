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
import { invalidateAllPermissions } from "../src/server/services/permissions-cache";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const MIGRATIONS = resolve(ROOT, "packages/db/drizzle/sqlite");

/**
 * A `Response` whose `json()` is typed as the API's JSON envelope rather than
 * `unknown`.
 *
 * Every backlex route answers `{ data }`, `{ error }` or `{ status }` — a
 * shape the specs already know, and one they were asserting through 97
 * separate `as` casts because `Response.json()` is `Promise<unknown>` under
 * bun-types. Narrowing it once here is not a loosening: `res.json()` on a
 * response the harness did NOT produce (a raw `app.request`, an outbound
 * `fetch` stub) still hands back `unknown`, which is correct, because nothing
 * guarantees those are backlex envelopes at all.
 */
export interface ApiResponse extends Response {
  json(): Promise<Record<string, any>>;
}

export interface TestHarness {
  env: Env;
  app: ReturnType<typeof createApp>;
  /** Cookie-tracking fetch wrapper. Pass relative or absolute URLs; only
   *  the path matters since the app is invoked directly. */
  fetch: (input: string, init?: RequestInit) => Promise<ApiResponse>;
  /** The synthetic client IP this harness presents. Exposed so a spec that
   *  needs the SAME bucket across two paths can say so explicitly. */
  clientIp: string;
  /** Snapshot of cookies the harness is currently sending. */
  cookies: () => Record<string, string>;
  /** Remove the temp SQLite file and any rollback artefacts. */
  cleanup: () => void;
}

const DEFAULT_APP_URL = "http://localhost:5173";

/**
 * A distinct synthetic client IP per harness.
 *
 * The auth rate limiter keys on IP and allows five sign-ups per minute
 * (`lib/auth-rate-limit.ts`), and its window state is module-level — shared by
 * every harness in one bun-test process. So each harness needs its own IP, or
 * unrelated specs quietly eat each other's budget and someone's `sign-up`
 * returns 429.
 *
 * This used to pick one at RANDOM out of 250×250. With ~420 spec files that is
 * a birthday problem rather than a long shot: ~1.4 expected colliding pairs per
 * run, i.e. a **76% chance** some run has two harnesses sharing a bucket — and
 * the victim is whichever spec happens to sign up inside the loser's window,
 * which is why it read as an unrelated flake. Adding five specs in one wave is
 * what finally made it reproducible.
 *
 * A counter is collision-free by construction, which is the property actually
 * wanted here. 65,536 distinct values, far past any plausible spec count.
 *
 * Both harnesses draw from this one sequence — they run in the same process and
 * would otherwise collide with each other. Tests that deliberately exercise the
 * limiter still set their own `X-Forwarded-For` and are unaffected.
 */
let harnessSeq = 0;
export const nextSyntheticIp = (): string => {
  const n = harnessSeq++;
  return `127.0.${(n >> 8) & 0xff}.${n & 0xff}`;
};

/**
 * Apply the harness IP to requests made straight through `h.app.fetch`.
 *
 * ~43 specs hand-roll their own `request()` helper — they need to control the
 * Cookie header per identity, which the cookie-jar wrapper owns — and every one
 * of them sets `Origin` and `Cookie` and nothing else. So they reached the auth
 * limiter as IP `"unknown"`: not one bucket per spec, ONE BUCKET FOR ALL OF THEM,
 * against a budget of five sign-ups a minute.
 *
 * In a full run that bucket is always contended and which spec gets the 429 is
 * decided by scheduling — so the failure lands in a file that did nothing wrong
 * and disappears when that file is run on its own. Adding specs anywhere in the
 * suite reshuffles it.
 *
 * Wrapping `fetch` here fixes all of them at the shared resource rather than in
 * 43 copies, which is also the only version that stays fixed as specs are added.
 * An explicit `X-Forwarded-For` still wins, so the specs that deliberately
 * exercise the limiter are unaffected.
 */
export const withSyntheticIp = <T extends { fetch: (req: Request) => Response | Promise<Response> }>(
  app: T,
  ip: string,
): T =>
  new Proxy(app, {
    get(target, prop, receiver) {
      if (prop !== "fetch") return Reflect.get(target, prop, receiver);
      return (req: Request, ...rest: unknown[]) => {
        let out = req;
        if (!req.headers.has("X-Forwarded-For")) {
          const headers = new Headers(req.headers);
          headers.set("X-Forwarded-For", ip);
          // Re-wrapping preserves method and body; the original is discarded.
          out = new Request(req, { headers });
        }
        return (target.fetch as (r: Request, ...a: unknown[]) => Response | Promise<Response>)(
          out,
          ...rest,
        );
      };
    },
  }) as T;

/**
 * Hook budget for a spec that boots PGlite.
 *
 * Starting a WASM Postgres is seconds of CPU, and bun's default hook timeout is
 * five. The pre-push gate runs the suite alongside typecheck and four platform
 * builds, so on a loaded machine the boot lost the race and the hook timed out
 * — a red gate that said nothing about the code under test. The assertions
 * themselves are unaffected; only the door they walk through is wider.
 *
 * Raised from 60s once the suite reached fourteen pglite specs: each boots its
 * own WASM Postgres and replays the whole migration bundle, and late in a run
 * one of them took 68 seconds to do it. The number tracks how many of these
 * specs exist, so expect to revisit it rather than to have found the answer.
 */
export const PGLITE_BOOT_TIMEOUT_MS = 120_000;

/**
 * Per-test budget for an assertion that talks to PGlite.
 *
 * Same cause as the boot budget, one step further in. A body that signs a user
 * up runs a deliberately slow password hash on top of WASM Postgres, and with
 * several pglite specs resident at once that crossed bun's five-second default
 * — while passing comfortably when the spec ran alone. A test that only fails
 * when its neighbours are busy is reporting the machine, not the code.
 */
export const PGLITE_TEST_TIMEOUT_MS = 30_000;

export const makeHarness = (overrides: Partial<Env> = {}): TestHarness => {
  // Per-isolate caches (roles/perms/membership/session/tenant-resolve) are
  // module-level, so they persist across harnesses in one bun-test process. In
  // prod each isolate serves a single instance DB, but here every harness is a
  // fresh DB — a cached default-tenant id from a prior suite would dangle and
  // break FK inserts. Clear them whenever a new harness (new DB) is built.
  invalidateAllPermissions();

  const dbPath = resolve(tmpdir(), `backlex-test-${randomUUID()}.sqlite`);
  mkdirSync(dirname(dbPath), { recursive: true });

  const migClient = new Database(dbPath, { create: true });
  migClient.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: migClient }), { migrationsFolder: MIGRATIONS });
  migClient.close();

  const env: Env = {
    APP_URL: DEFAULT_APP_URL,
    AUTH_SECRET: "test-secret-not-for-prod-but-stable-across-calls",
    SQLITE_PATH: dbPath,
    // Quiet the per-request JSON access log + expected 4xx warnings so test
    // output stays readable (the suite deliberately drives many 401/404/409
    // paths). The middleware still runs (its code path is exercised); only the
    // emit is gated. Genuine 5xx still print at error. Override per-suite to
    // assert on logs.
    // The harness IS a trusted proxy: it wraps every request and sets
    // `X-Forwarded-For` to a per-harness address so specs do not share a rate
    // limiter bucket (see `nextSyntheticIp`). Saying so out loud is what makes
    // `lib/client-address.ts` read that header — it believes no client-supplied
    // header unless the deployment names one, which is the whole point of the
    // derivation. A spec that wants the production default (nothing trusted)
    // overrides this key to `undefined`.
    TRUSTED_PROXY_HEADER: "x-forwarded-for",
    LOG_LEVEL: "error",
    ...overrides,
  };

  const app = createApp(env);

  const cookieJar = new Map<string, string>();
  const syntheticIp = nextSyntheticIp();
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
    app: withSyntheticIp(app, syntheticIp),
    clientIp: syntheticIp,
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
 *  is auto-promoted via the `onUserCreated` hook in context.ts).
 *
 *  Public sign-up now defaults to CLOSED (auth_config.policy.openSignup). Most
 *  multi-user tests seed an admin and then create additional users via
 *  `/api/auth/sign-up/email`, so this helper opens public sign-up by default
 *  (the admin session from autoSignIn authorises the config PATCH). Pass
 *  `{ openSignup: false }` to exercise the closed-by-default behavior. */
export const seedAdmin = async (
  h: TestHarness,
  email = `admin-${Date.now()}@example.test`,
  password = "correct-horse-battery",
  opts: { openSignup?: boolean } = {},
): Promise<{ email: string; password: string }> => {
  const res = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Test Admin" }),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  if (opts.openSignup !== false) {
    const patch = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { openSignup: true } }),
    });
    if (!patch.ok) {
      throw new Error(`open signup failed: ${patch.status} ${await patch.text()}`);
    }
  }
  return { email, password };
};
