/**
 * SECURITY — cross-origin allow-list (`services/cors-origins.ts`) and its
 * enforcement in the CORS middleware (`app.ts`).
 *
 * The contract under test:
 *   - only `APP_URL`, `EXTRA_TRUSTED_ORIGINS` entries, and origins derived
 *     from a workspace's stored `auth_config.redirectUrls` are allowed to make
 *     credentialled cross-origin requests;
 *   - an arbitrary origin is NEVER reflected into
 *     `Access-Control-Allow-Origin` (no origin reflection — with
 *     `credentials: true` a reflected ACAO would be a full CSRF/data-read
 *     bypass for any site);
 *   - the workspace origin set is a module-scope cache: `warmAllowedOrigins`
 *     populates it eagerly, `refreshAllowedOriginsIfStale` is TTL-gated
 *     (5 min) so a just-written redirect URL is not visible until a
 *     warm/stale refresh runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  envExtraOrigins,
  isWorkspaceAllowedOrigin,
  redirectUrlOrigins,
  refreshAllowedOriginsIfStale,
  warmAllowedOrigins,
} from "../src/server/services/cors-origins";
import type { Env } from "../src/server/env";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Env for the pure-logic tests: no DB involved, so only the env-derived
// allow-list applies (the module cache never contains these hostnames).
const bareEnv = (extra?: string): Env =>
  ({
    APP_URL: "http://localhost:5173",
    AUTH_SECRET: "irrelevant",
    ...(extra !== undefined ? { EXTRA_TRUSTED_ORIGINS: extra } : {}),
  }) as Env;

describe("cors-origins — pure allow-list logic", () => {
  test("envExtraOrigins parses, trims, normalizes to origins, drops invalid entries", () => {
    const env = bareEnv(
      " https://extra.example , https://two.example/some/path?q=1 , not-a-url ,, https://three.example:8443 ",
    );
    expect(envExtraOrigins(env)).toEqual([
      "https://extra.example",
      "https://two.example", // path/query stripped — origins only
      "https://three.example:8443",
    ]);
    expect(envExtraOrigins(bareEnv())).toEqual([]);
  });

  test("redirectUrlOrigins dedupes to origins and drops garbage", () => {
    expect(
      redirectUrlOrigins([
        "https://app.acme.example/auth/callback",
        "https://app.acme.example/other/return",
        "https://second.example/cb",
        "nonsense",
      ]),
    ).toEqual(["https://app.acme.example", "https://second.example"]);
    expect(redirectUrlOrigins(null)).toEqual([]);
    expect(redirectUrlOrigins(undefined)).toEqual([]);
  });

  test("env-listed origin is allowed; arbitrary origins are NOT", () => {
    const env = bareEnv("https://trusted.example");
    expect(isWorkspaceAllowedOrigin("https://trusted.example", env)).toBe(true);
    // Same origin expressed as a URL with a path still matches (normalized).
    expect(isWorkspaceAllowedOrigin("https://trusted.example/deep/path", env)).toBe(true);

    // No reflection: unknown origins, sub/superstring tricks, scheme and port
    // variants must all be rejected.
    expect(isWorkspaceAllowedOrigin("https://evil.example", env)).toBe(false);
    expect(isWorkspaceAllowedOrigin("https://trusted.example.evil.example", env)).toBe(false);
    expect(isWorkspaceAllowedOrigin("https://eviltrusted.example", env)).toBe(false);
    expect(isWorkspaceAllowedOrigin("http://trusted.example", env)).toBe(false); // scheme downgrade
    expect(isWorkspaceAllowedOrigin("https://trusted.example:8443", env)).toBe(false); // other port
    expect(isWorkspaceAllowedOrigin("null", env)).toBe(false); // sandboxed-iframe Origin
    expect(isWorkspaceAllowedOrigin("garbage not a url", env)).toBe(false);
    expect(isWorkspaceAllowedOrigin("", env)).toBe(false);
  });
});

describe("cors-origins — workspace redirect URLs + HTTP enforcement", () => {
  let h: TestHarness;
  let client: Database;
  let dbCtx: { db: any; dialect: "sqlite" };

  const ALLOWED = "https://app.acme.test";
  const EVIL = "https://evil.attacker.test";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH as string);
    dbCtx = { db: drizzle({ client }), dialect: "sqlite" };

    // Register a redirect URL the way production does: the admin auth-config
    // PATCH. Its origin should implicitly become CORS-allowed.
    const res = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirectUrls: [`${ALLOWED}/auth/callback`] }),
    });
    expect(res.status).toBe(200);
  });
  afterAll(() => {
    client.close();
    h.cleanup();
  });

  test("workspace-registered origin admitted after warm; arbitrary origin still rejected", async () => {
    // The module cache was warmed on the app's first request — BEFORE the
    // PATCH above — so refresh it the way boot does.
    await warmAllowedOrigins(dbCtx);
    expect(isWorkspaceAllowedOrigin(ALLOWED, h.env)).toBe(true);
    expect(isWorkspaceAllowedOrigin(`${ALLOWED}/any/path`, h.env)).toBe(true);
    expect(isWorkspaceAllowedOrigin(EVIL, h.env)).toBe(false);
  });

  test("HTTP: allowed workspace origin is reflected with credentials", async () => {
    const res = await h.fetch("/api/collections", {
      headers: { Origin: ALLOWED },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("HTTP: disallowed origin is NOT reflected (ACAO falls back to APP_URL)", async () => {
    const res = await h.fetch("/api/collections", {
      headers: { Origin: EVIL },
    });
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao).not.toBe(EVIL); // the security property
    expect(acao).toBe(h.env.APP_URL); // pinned fallback behavior
  });

  test("HTTP: preflight for a disallowed origin does not authorize it", async () => {
    const res = await h.fetch("/api/collections", {
      method: "OPTIONS",
      headers: {
        Origin: EVIL,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe(EVIL);
    expect(res.headers.get("access-control-allow-origin")).toBe(h.env.APP_URL);
  });

  test("HTTP: preflight for the allowed origin succeeds", async () => {
    const res = await h.fetch("/api/collections", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("cache staleness: a newly written redirect URL is invisible until a refresh", async () => {
    const LATE = "https://late-added.acme.test";
    const res = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        redirectUrls: [`${ALLOWED}/auth/callback`, `${LATE}/cb`],
      }),
    });
    expect(res.status).toBe(200);

    // Within the 5-min TTL the lazy refresh is a no-op — the new origin is
    // NOT yet allowed (pinned: config writes take up to TTL to apply to CORS).
    refreshAllowedOriginsIfStale(dbCtx);
    await Bun.sleep(20); // let any (unexpected) fire-and-forget refresh land
    expect(isWorkspaceAllowedOrigin(LATE, h.env)).toBe(false);

    // A warm (boot-path) refresh picks it up.
    await warmAllowedOrigins(dbCtx);
    expect(isWorkspaceAllowedOrigin(LATE, h.env)).toBe(true);
    // Removed URLs drop out on refresh too — the cache is replaced, not merged.
    const res2 = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ redirectUrls: [`${ALLOWED}/auth/callback`] }),
    });
    expect(res2.status).toBe(200);
    await warmAllowedOrigins(dbCtx);
    expect(isWorkspaceAllowedOrigin(LATE, h.env)).toBe(false);
    expect(isWorkspaceAllowedOrigin(ALLOWED, h.env)).toBe(true);
  });
});
