import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  flushUsage,
  monthUsage,
  resetUsageState,
  sweepUsageGauges,
  usageRows,
  utcDay,
  utcMonth,
} from "../src/server/services/usage";
import * as sqlite from "@backlex/db/sqlite";

/**
 * Usage metering (#12) — the ledger itself plus every enforcement edge:
 * request counting through the middleware, per-key rate limit + monthly
 * quota, workspace hard caps (requests / storage / rows), and the admin
 * exemption that keeps an over-quota workspace's panel reachable.
 */
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Insert a ledger row directly — for tests that need month usage in the DB
 *  without driving hundreds of requests through the buffer. */
const seedLedger = async (
  h: TestHarness,
  row: { tenantId: string; apiKeyId?: string; requests: number; dbRows?: number },
) => {
  const ctx = await buildContext(h.env);
  await (ctx.db as any).insert(sqlite.schema.usageCounters).values({
    tenantId: row.tenantId,
    apiKeyId: row.apiKeyId ?? "",
    day: utcDay(),
    requests: row.requests,
    errors: 0,
    dbRows: row.dbRows ?? null,
    storageBytes: row.dbRows != null ? 0 : null,
    updatedAt: new Date(),
  });
};

const activeTenantId = async (h: TestHarness): Promise<string> => {
  const res = (await (await h.fetch("/api/tenants")).json()) as {
    data: { id: string }[];
  };
  const id = res.data[0]?.id;
  if (!id) throw new Error("no tenant in /api/tenants");
  return id;
};

const mintKey = async (
  h: TestHarness,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; secret: string }> => {
  const res = await h.fetch("/api/api-keys", json("POST", { name: "meter", ...extra }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string; secret: string } };
  return { id: body.data.id, secret: body.data.secret };
};

/** Key-authenticated request WITHOUT the harness cookie jar — the admin
 *  session cookie would win over the bearer key in sessionMiddleware and the
 *  request would never carry an apiKeyId. */
const keyFetch = (h: TestHarness, path: string, secret: string): Promise<Response> =>
  h.app.fetch(
    new Request(`${h.env.APP_URL}${path}`, {
      headers: { authorization: `Bearer ${secret}`, Origin: h.env.APP_URL },
    }),
  );

describe("usage — request counting through the middleware", () => {
  let h: TestHarness;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("metered responses land in usage_counters after a flush", async () => {
    const tenantId = await activeTenantId(h);
    for (let i = 0; i < 3; i++) {
      const r = await h.fetch("/api/collections");
      expect(r.status).toBe(200);
    }
    const ctx = await buildContext(h.env);
    await flushUsage(ctx);
    const rows = await usageRows(ctx, tenantId, 1);
    const sessionRow = rows.find((r) => r.apiKeyId === "");
    expect(sessionRow).toBeDefined();
    // ≥ because /api/me & friends from seeding may also have been counted.
    expect(sessionRow!.requests).toBeGreaterThanOrEqual(3);
    expect(sessionRow!.day).toBe(utcDay());
  });

  test("auth endpoints are not metered", async () => {
    const tenantId = await activeTenantId(h);
    const ctx = await buildContext(h.env);
    await flushUsage(ctx);
    const before = (await usageRows(ctx, tenantId, 1)).reduce(
      (n, r) => n + r.requests,
      0,
    );
    await h.fetch("/api/auth/get-session");
    await flushUsage(ctx);
    const after = (await usageRows(ctx, tenantId, 1)).reduce(
      (n, r) => n + r.requests,
      0,
    );
    expect(after).toBe(before);
  });

  test("API-key traffic is attributed to the key's bucket", async () => {
    const tenantId = await activeTenantId(h);
    const { id, secret } = await mintKey(h);
    const r = await keyFetch(h, "/api/collections", secret);
    expect(r.status).toBe(200);
    const ctx = await buildContext(h.env);
    await flushUsage(ctx);
    const rows = await usageRows(ctx, tenantId, 1);
    const keyRow = rows.find((r2) => r2.apiKeyId === id);
    expect(keyRow?.requests).toBeGreaterThanOrEqual(1);
  });
});

describe("usage — per-key rate limit", () => {
  let h: TestHarness;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a key with rateLimitPerMinute=2 429s on the third call even with the global limiter off", async () => {
    const { secret } = await mintKey(h, { rateLimitPerMinute: 2 });
    const call = () => keyFetch(h, "/api/collections", secret);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(third.headers.get("RateLimit-Limit")).toBe("2");
  });

  test("non-admins cannot set limit knobs on their own keys", async () => {
    // Second signup = non-admin.
    await h.fetch(
      "/api/auth/sign-up/email",
      json("POST", {
        email: `plain-${Date.now()}@example.com`,
        password: "password-123",
        name: "Plain",
      }),
    );
    const res = await h.fetch(
      "/api/api-keys",
      json("POST", { name: "sneaky", rateLimitPerMinute: 1_000_000 }),
    );
    expect(res.status).toBe(403);
  });
});

describe("usage — monthly quotas + workspace caps", () => {
  let h: TestHarness;
  let tenantId: string;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
    tenantId = await activeTenantId(h);
  });
  afterAll(() => h.cleanup());

  test("a key over its monthlyQuota gets 429 QUOTA_EXCEEDED", async () => {
    const { id, secret } = await mintKey(h, { monthlyQuota: 5 });
    await seedLedger(h, { tenantId, apiKeyId: id, requests: 5 });
    resetUsageState(); // drop the cached (pre-seed) month sum
    const res = await keyFetch(h, "/api/collections", secret);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; details?: { scope?: string } } };
    expect(body.error.code).toBe("QUOTA_EXCEEDED");
    expect(body.error.details?.scope).toBe("apiKey");
    const ctx = await buildContext(h.env);
    expect(await monthUsage(ctx, tenantId, id)).toBe(5);
  });

  test("hard workspace request cap blocks key traffic but never the admin session", async () => {
    const put = await h.fetch(
      "/api/admin/usage/limits",
      json("PUT", {
        mode: "hard",
        maxRequestsPerMonth: 1,
        maxStorageBytes: null,
        maxDbRows: null,
      }),
    );
    expect(put.status).toBe(200);
    await seedLedger(h, { tenantId, requests: 10 });
    resetUsageState();

    const { secret } = await mintKey(h); // admin session request — must pass
    const blocked = await keyFetch(h, "/api/collections", secret);
    expect(blocked.status).toBe(429);
    expect(
      ((await blocked.json()) as { error: { code: string } }).error.code,
    ).toBe("QUOTA_EXCEEDED");

    const adminStill = await h.fetch("/api/collections");
    expect(adminStill.status).toBe(200);

    // soft mode: same overage, nothing blocked
    await h.fetch(
      "/api/admin/usage/limits",
      json("PUT", {
        mode: "soft",
        maxRequestsPerMonth: 1,
        maxStorageBytes: null,
        maxDbRows: null,
      }),
    );
    resetUsageState();
    const softOk = await keyFetch(h, "/api/collections", secret);
    expect(softOk.status).toBe(200);
  });
});

describe("usage — storage + row hard caps", () => {
  let h: TestHarness;
  let tenantId: string;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness();
    await seedAdmin(h);
    tenantId = await activeTenantId(h);
  });
  afterAll(() => h.cleanup());

  test("uploads are blocked once stored bytes reach the cap", async () => {
    await h.fetch(
      "/api/admin/usage/limits",
      json("PUT", {
        mode: "hard",
        maxRequestsPerMonth: null,
        maxStorageBytes: 10,
        maxDbRows: null,
      }),
    );
    resetUsageState();
    // First upload passes (0 stored so far; its own size only counts via
    // content-length, which small string bodies do carry).
    const first = await h.fetch("/api/storage/small.txt", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "0123456789ABCDEF", // 16 bytes > cap once stored
    });
    // Either the declared length already trips the cap (429) or it lands and
    // the NEXT upload trips on current-bytes — both prove the fence.
    if (first.status !== 429) {
      expect(first.status).toBe(201);
      const second = await h.fetch("/api/storage/second.txt", {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "x",
      });
      expect(second.status).toBe(429);
      expect(
        ((await second.json()) as { error: { code: string } }).error.code,
      ).toBe("QUOTA_EXCEEDED");
    }
  });

  test("item creates are blocked once the row gauge reaches the cap", async () => {
    const mk = await h.fetch(
      "/api/collections",
      json("POST", { slug: `cap_rows_${Date.now()}`, fields: [{ name: "title", type: "text" }] }),
    );
    expect(mk.status).toBe(201);
    const slug = ((await mk.json()) as { data: { slug: string } }).data.slug;

    await h.fetch(
      "/api/admin/usage/limits",
      json("PUT", {
        mode: "hard",
        maxRequestsPerMonth: null,
        maxStorageBytes: null,
        maxDbRows: 3,
      }),
    );
    await seedLedger(h, { tenantId, requests: 0, dbRows: 5 });
    resetUsageState();

    const blocked = await h.fetch(`/api/items/${slug}`, json("POST", { title: "no" }));
    expect(blocked.status).toBe(429);
    expect(
      ((await blocked.json()) as { error: { code: string } }).error.code,
    ).toBe("QUOTA_EXCEEDED");

    // Reads and updates stay open — only creates are fenced.
    const list = await h.fetch(`/api/items/${slug}`);
    expect(list.status).toBe(200);
  });
});

describe("usage — gauge sweep + env pinning", () => {
  let h: TestHarness;
  beforeAll(async () => {
    resetUsageState();
    h = makeHarness({
      USAGE_LIMIT_MODE: "hard",
      USAGE_LIMIT_REQUESTS_MONTH: "123456",
    });
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("sweepUsageGauges writes storage/rows gauges onto today's session row", async () => {
    const tenantId = await activeTenantId(h);
    const mk = await h.fetch(
      "/api/collections",
      json("POST", { slug: `gauge_${Date.now()}`, fields: [{ name: "t", type: "text" }] }),
    );
    const slug = ((await mk.json()) as { data: { slug: string } }).data.slug;
    await h.fetch(`/api/items/${slug}`, json("POST", { t: "one" }));
    await h.fetch(`/api/items/${slug}`, json("POST", { t: "two" }));

    const ctx = await buildContext(h.env);
    await sweepUsageGauges(ctx);
    const rows = await usageRows(ctx, tenantId, 1);
    const gaugeRow = rows.find((r) => r.apiKeyId === "" && r.dbRows != null);
    expect(gaugeRow).toBeDefined();
    expect(gaugeRow!.dbRows!).toBeGreaterThanOrEqual(2);
    expect(gaugeRow!.storageBytes).toBe(0);
  });

  test("USAGE_LIMIT_* env pins override settings and are reported", async () => {
    const res = await h.fetch("/api/admin/usage/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        month: string;
        limits: { mode: string; maxRequestsPerMonth: number | null };
        envPinned: string[];
      };
    };
    expect(body.data.month).toBe(utcMonth());
    expect(body.data.limits.mode).toBe("hard");
    expect(body.data.limits.maxRequestsPerMonth).toBe(123456);
    expect(body.data.envPinned).toContain("mode");
    expect(body.data.envPinned).toContain("maxRequestsPerMonth");
  });
});
