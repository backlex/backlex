/**
 * Regressions from the 2026-07 architecture audit. Each block pins one defect
 * that shipped and is now fixed; see docs/architecture.md and the inline
 * comments on the fixes themselves for the full reasoning.
 *
 *   1. `runBackup` dumped `tenants` / `users` / `user_roles` / `permissions`
 *      UNFILTERED into a per-workspace backup, because it detected "does this
 *      table have a tenant_id column?" by catching the SQL error and retrying
 *      without a WHERE. A workspace admin's downloadable backup therefore
 *      carried every other workspace's user directory and permission matrix.
 *
 *   2. `restoreBackup` tenant-filtered only the `collections` bucket; every
 *      other table was inserted verbatim with its ORIGINAL tenant_id.
 *
 *   3. The public surfaces (`/api/webhook/:flowId`, `/api/public/*`) were
 *      metered under `auth.tenantId`. An anonymous request has no identity, so
 *      `tenantMiddleware` falls back to the DEFAULT workspace — meaning every
 *      public hit was billed to the wrong tenant on a multi-workspace instance,
 *      and the owning workspace's monthly cap never applied to its own public
 *      surfaces. The flow trigger additionally had no rate limit at all,
 *      despite being able to spend money (SMS / push / AI / functions).
 *
 *   4. The cron sweep throttles were per-isolate `let` counters, so on every
 *      serverless runtime they reset to 0 each tick and never engaged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
});

afterAll(() => h.cleanup());

/**
 * Hit the app with NO session cookie. `h.fetch` replays the admin cookie jar,
 * which would give the request an authenticated identity — and these routes are
 * precisely the ones whose behaviour differs when the caller is anonymous.
 */
const anonFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers ?? {});
  headers.set("Origin", h.env.APP_URL!);
  if (!headers.has("X-Forwarded-For")) headers.set("X-Forwarded-For", "203.0.113.7");
  return h.app.fetch(new Request(`${h.env.APP_URL}${path}`, { ...init, headers }));
};

/** Read every `{table,row}` line out of a stored backup artifact. */
const readDump = async (
  storageKey: string,
): Promise<{ table: string; row: Record<string, unknown> }[]> => {
  const { buildContext } = await import("../src/server/context");
  const ctx = await buildContext(h.env);
  const file = await ctx.storage.get(storageKey);
  if (!file) throw new Error(`backup artifact missing: ${storageKey}`);
  const text = await new Response(file.body).text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { table: string; row: Record<string, unknown> });
};

describe("backup is scoped to one workspace (audit finding 1)", () => {
  test("a foreign workspace's users, roles and permissions stay out of the dump", async () => {
    const { buildContext } = await import("../src/server/context");
    const { runBackup } = await import("../src/server/services/backup");
    const ctx = await buildContext(h.env);
    const db = ctx.db as any;
    const sqliteSchema = (await import("@backlex/db/sqlite")).schema;

    // The workspace we back up.
    const mineRows = (await db.select().from(sqliteSchema.tenants)) as {
      id: string;
    }[];
    const mine = mineRows[0]!.id;

    // A second, unrelated workspace with its own user, role and permission.
    const other = crypto.randomUUID();
    const otherUser = crypto.randomUUID();
    const otherRole = crypto.randomUUID();
    await db.insert(sqliteSchema.tenants).values({
      id: other,
      slug: `other-${other.slice(0, 8)}`,
      name: "Other workspace",
    });
    await db.insert(sqliteSchema.users).values({
      id: otherUser,
      email: `outsider-${otherUser.slice(0, 8)}@example.com`,
    });
    await db.insert(sqliteSchema.tenantMembers).values({
      id: crypto.randomUUID(),
      tenantId: other,
      userId: otherUser,
      email: `outsider-${otherUser.slice(0, 8)}@example.com`,
      role: "owner",
    });
    await db
      .insert(sqliteSchema.roles)
      .values({ id: otherRole, tenantId: other, name: "outsider-role" });
    await db
      .insert(sqliteSchema.userRoles)
      .values({ userId: otherUser, roleId: otherRole });
    await db.insert(sqliteSchema.permissions).values({
      id: crypto.randomUUID(),
      roleId: otherRole,
      collection: "secrets",
      action: "read",
    });

    const storageKey = `backups/${mine}/scope-test.jsonl`;
    await runBackup(ctx, { tenantId: mine, storageKey });
    const dump = await readDump(storageKey);

    const idsFor = (table: string): unknown[] =>
      dump.filter((l) => l.table === table).map((l) => l.row.id);

    // The four tables that used to fall through to an unfiltered SELECT.
    expect(idsFor("tenants")).not.toContain(other);
    expect(idsFor("tenants")).toContain(mine);
    expect(idsFor("users")).not.toContain(otherUser);
    expect(
      dump
        .filter((l) => l.table === "user_roles")
        .map((l) => l.row.role_id ?? l.row.roleId),
    ).not.toContain(otherRole);
    expect(
      dump
        .filter((l) => l.table === "permissions")
        .map((l) => l.row.role_id ?? l.row.roleId),
    ).not.toContain(otherRole);
  });
});

describe("restore refuses foreign-workspace rows (audit finding 2)", () => {
  test("a row carrying another tenant_id is skipped, not written verbatim", async () => {
    const { buildContext } = await import("../src/server/context");
    const { restoreBackup } = await import("../src/server/services/backup");
    const ctx = await buildContext(h.env);
    const db = ctx.db as any;
    const sqliteSchema = (await import("@backlex/db/sqlite")).schema;

    const mine = ((await db.select().from(sqliteSchema.tenants)) as { id: string }[])[0]!
      .id;
    const foreignFlow = crypto.randomUUID();
    const storageKey = "backups/restore-scope-test.jsonl";
    // A dump whose only payload belongs to some other workspace. The row is
    // deliberately COMPLETE (every NOT NULL column present) so it would insert
    // cleanly if nothing rejected it — otherwise this test would pass merely
    // because the insert failed a constraint.
    await ctx.storage.put({
      key: storageKey,
      body: new TextEncoder().encode(
        JSON.stringify({
          table: "flows",
          row: {
            id: foreignFlow,
            tenant_id: crypto.randomUUID(),
            name: "not-mine",
            trigger: "webhook",
            operations: "[]",
            active: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        }),
      ),
      contentType: "application/x-ndjson",
    });

    const result = await restoreBackup(ctx, { storageKey, tenantId: mine });
    expect(result.rowCount).toBe(0);

    const landed = (await db
      .select()
      .from(sqliteSchema.flows)
      .where((await import("drizzle-orm")).eq(sqliteSchema.flows.id, foreignFlow))) as
      unknown[];
    expect(landed).toHaveLength(0);
  });
});

describe("public flow trigger is metered and throttled (audit finding 3)", () => {
  test("a trigger bills the flow's workspace and the endpoint has a budget", async () => {
    const { buildContext } = await import("../src/server/context");
    const { resetUsageState, flushUsage } = await import("../src/server/services/usage");
    const ctx = await buildContext(h.env);
    const db = ctx.db as any;
    const sqliteSchema = (await import("@backlex/db/sqlite")).schema;
    const { eq } = await import("drizzle-orm");

    // The flow lives in a SECOND workspace — the whole point. An anonymous
    // request resolves to the DEFAULT workspace in `tenantMiddleware`, so a
    // test whose flow sits in the default workspace can't tell correct
    // attribution apart from the fallback.
    const defaultTenant = ((await db.select().from(sqliteSchema.tenants)) as {
      id: string;
    }[])[0]!.id;
    const ownerTenant = crypto.randomUUID();
    await db.insert(sqliteSchema.tenants).values({
      id: ownerTenant,
      slug: `owner-${ownerTenant.slice(0, 8)}`,
      name: "Flow owner workspace",
    });
    const flowId = crypto.randomUUID();
    await db.insert(sqliteSchema.flows).values({
      id: flowId,
      tenantId: ownerTenant,
      name: "audit-trigger",
      trigger: "webhook",
      active: true,
      operations: [],
    });

    // Measure a DELTA per workspace — earlier requests in this suite already
    // billed the default workspace, so a bare "a counter exists" assertion
    // would hold even with the mis-attribution bug present.
    const billed = async (tid: string): Promise<number> => {
      await flushUsage(ctx);
      const rows = (await db
        .select()
        .from(sqliteSchema.usageCounters)
        .where(eq(sqliteSchema.usageCounters.tenantId, tid))) as {
        requests: number;
      }[];
      return rows.reduce((n, r) => n + Number(r.requests ?? 0), 0);
    };

    resetUsageState();
    const ownerBefore = await billed(ownerTenant);
    const defaultBefore = await billed(defaultTenant);
    const res = await anonFetch(`/api/webhook/${flowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);

    // The workspace that OWNS the flow pays for the run…
    expect(await billed(ownerTenant)).toBeGreaterThan(ownerBefore);
    // …and the default workspace, which the anonymous request merely fell back
    // to, is not charged for someone else's flow.
    expect(await billed(defaultTenant)).toBe(defaultBefore);
  });

  test("the per-flow budget eventually rejects a hot loop", async () => {
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const db = ctx.db as any;
    const sqliteSchema = (await import("@backlex/db/sqlite")).schema;
    const tenantId = ((await db.select().from(sqliteSchema.tenants)) as {
      id: string;
    }[])[0]!.id;
    const flowId = crypto.randomUUID();
    await db.insert(sqliteSchema.flows).values({
      id: flowId,
      tenantId,
      name: "audit-burst",
      trigger: "webhook",
      active: true,
      operations: [],
    });

    // The per-IP budget is 30/min; drive past it and assert we get throttled
    // rather than running the flow an unbounded number of times.
    let sawRateLimit = false;
    for (let i = 0; i < 45; i += 1) {
      const r = await anonFetch(`/api/webhook/${flowId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (r.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe("cron sweep throttles survive a fresh instance (audit finding 4)", () => {
  test("a claimed window is not re-claimed by a second caller", async () => {
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const { cronTick } = await import("../src/server/services/scheduler");
    const db = ctx.db as any;
    const sqliteSchema = (await import("@backlex/db/sqlite")).schema;
    const { eq } = await import("drizzle-orm");

    const now = new Date();
    await cronTick(h.env, now);

    const watermarkFor = async (id: string): Promise<number | null> => {
      const rows = (await db
        .select()
        .from(sqliteSchema.appSettings)
        .where(eq(sqliteSchema.appSettings.id, id))) as { value: unknown }[];
      const v = rows[0]?.value;
      return typeof v === "number" ? v : null;
    };

    // The tick persists its claim, so the throttle is readable by any other
    // instance — this is exactly what the old module-level `let` could not do.
    const first = await watermarkFor("__sweep__activity-prune");
    expect(first).not.toBeNull();

    // A second tick a minute later must NOT re-claim the 24h window.
    await cronTick(h.env, new Date(now.getTime() + 60_000));
    expect(await watermarkFor("__sweep__activity-prune")).toBe(first);
  });
});
