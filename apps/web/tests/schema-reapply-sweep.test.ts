/**
 * The schema re-apply runs on a schedule, not only when somebody remembers.
 *
 * #317 shipped the manual endpoint and left running it as a per-release chore.
 * When that issue came back to check: of four live tenants, three could not be
 * swept at all (paused) and the fourth needed it and nobody had noticed. Every
 * feature that adds a column to managed tables owes the same sweep, so a
 * follow-up that has to be remembered per release does nothing on the releases
 * where it is not.
 *
 * What is asserted here is the property the cron depends on and the endpoint
 * test cannot show: the sweep reaches EVERY workspace on the deployment, not
 * just the caller's, and one workspace's failure does not cost the others
 * theirs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildContext } from "../src/server/context";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  reapplyAllWorkspaces,
  reapplyWorkspaceSchema,
} from "../src/server/services/schema-reapply";
import { invalidateTenantCollections } from "../src/server/services/collections-cache";

const J = { "content-type": "application/json" };

describe("the scheduled re-apply reaches every workspace", () => {
  let h: TestHarness;
  let ctx: { db: unknown; dialect: "pg" | "sqlite" };
  /** (tenantId, physicalTable) for a collection in each of two workspaces. */
  let own: { tenantId: string; table: string };
  let other: { tenantId: string; table: string };

  const post = (path: string, b: unknown, tenant?: string) =>
    h.fetch(path, {
      method: "POST",
      headers: { ...J, ...(tenant ? { "X-Backlex-Tenant": tenant } : {}) },
      body: JSON.stringify(b),
    });

  /** Writes need both the query flag AND the confirm header — the admin SQL
   *  surface is read-only until a caller says twice that it means it. */
  const runSql = async (statement: string, tenant?: string) => {
    const res = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...J, "x-backlex-confirm": "yes", ...(tenant ? { "X-Backlex-Tenant": tenant } : {}) },
      body: JSON.stringify({ sql: statement }),
    });
    expect([200, 201]).toContain(res.status);
  };

  const makeCollection = async (slug: string, tenant?: string) => {
    const made = await post(
      "/api/collections",
      { slug, fields: [{ name: "name", type: "text" }] },
      tenant,
    );
    expect(made.status, `create ${slug}`).toBe(201);
    const meta = (await made.json()) as {
      data: { physicalTable: string; tenantId?: string; tenant_id?: string };
    };
    return {
      tenantId: (meta.data.tenantId ?? meta.data.tenant_id) as string,
      table: meta.data.physicalTable,
    };
  };

  /** Make a table look like one from before the companion column existed. */
  const stripCompanion = async (t: { tenantId: string; table: string }) => {
    await runSql(`ALTER TABLE "${t.table}" DROP COLUMN "name__fold"`);
    invalidateTenantCollections(t.tenantId);
  };

  const hasCompanion = async (table: string): Promise<boolean> => {
    if (ctx.dialect === "pg") {
      const r = (await (ctx.db as any).execute(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = 'name__fold'`,
      )) as unknown;
      const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
      return rows.length > 0;
    }
    const rows = (await (ctx.db as any).all(
      sql.raw(`PRAGMA table_info("${table}")`),
    )) as { name: string }[];
    return rows.some((c) => c.name === "name__fold");
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h, "sweep-admin@example.test");
    const built = await buildContext(h.env);
    ctx = { db: built.db, dialect: built.dialect };

    own = await makeCollection("sweep_own");

    // A SECOND workspace, owned by the same operator so the fixture stays
    // small. What matters is that its collection is not the caller's — the
    // manual endpoint only ever sees `auth.tenantId`, so a sweep that reused
    // its scoping would silently do nothing for everybody else.
    const ws = await post("/api/tenants", { name: "Sweep Other" });
    expect(ws.status).toBe(201);
    const created = ((await ws.json()) as { data: { slug: string } }).data;
    other = await makeCollection("sweep_other", created.slug);
    expect(other.tenantId).not.toBe(own.tenantId);
  });
  afterAll(() => h.cleanup());

  test("one workspace's pass leaves the other workspace alone", async () => {
    await stripCompanion(own);
    await stripCompanion(other);
    expect(await hasCompanion(own.table)).toBe(false);
    expect(await hasCompanion(other.table)).toBe(false);

    const r = await reapplyWorkspaceSchema(ctx, own.tenantId);
    expect(r.failed).toEqual([]);
    expect(r.applied).toBeGreaterThan(0);

    expect(await hasCompanion(own.table)).toBe(true);
    // The half that makes the scheduled sweep necessary: a per-workspace call
    // is exactly as wide as the workspace that made it.
    expect(await hasCompanion(other.table)).toBe(false);
  });

  test("the sweep reaches both, without being told which", async () => {
    await stripCompanion(own);
    expect(await hasCompanion(own.table)).toBe(false);
    expect(await hasCompanion(other.table)).toBe(false);

    const r = await reapplyAllWorkspaces(ctx);
    expect(r.workspaces).toBeGreaterThanOrEqual(2);
    expect(r.failed).toBe(0);

    expect(await hasCompanion(own.table)).toBe(true);
    expect(await hasCompanion(other.table)).toBe(true);
  });

  test("it is idempotent — a second pass writes nothing and still reports clean", async () => {
    // The property the daily cadence rests on. If a converged workspace were
    // not a no-op this could not run on a timer at all.
    const first = await reapplyAllWorkspaces(ctx);
    const second = await reapplyAllWorkspaces(ctx);
    expect(second.failed).toBe(0);
    expect(second.workspaces).toBe(first.workspaces);
    expect(await hasCompanion(own.table)).toBe(true);
  });

  test("a workspace whose table is gone does not cost the others their sweep", async () => {
    // The precondition #317 set on automating this: an automatic sweep that
    // leaves a permanently-failing collection behind turns a number somebody
    // reads into a line in a cron log nobody does. So the failure is contained
    // AND announced — `reapplyAllWorkspaces` emits a `schema-reapply-failed`
    // warn naming the workspace and every failing slug.
    await stripCompanion(own);
    // Point the other workspace's collection at a VIEW. `applyCollection` can
    // add a column to a table and not to a view, so this is a collection that
    // fails identically on every sweep — the "permanently stuck" shape #360
    // found on the canary tenant, reproduced without needing that defect.
    await runSql(`CREATE VIEW "sweep_broken_view" AS SELECT 1 AS id`);
    await runSql(
      `UPDATE "collections" SET "physical_table" = 'sweep_broken_view' WHERE "slug" = 'sweep_other'`,
    );
    invalidateTenantCollections(other.tenantId);

    // The failure has to be OBSERVABLE, not merely contained. A guard that
    // matches nothing reports success, and this repo has shipped that before —
    // so the warn line is asserted rather than trusted.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...parts: unknown[]) => warned.push(parts.map(String).join(" "));
    let r: Awaited<ReturnType<typeof reapplyAllWorkspaces>>;
    try {
      r = await reapplyAllWorkspaces(ctx);
    } finally {
      console.warn = realWarn;
    }

    expect(r.failed).toBeGreaterThan(0);
    const line = warned.find((w) => w.includes("schema-reapply-failed"));
    expect(line, "a failing workspace must announce itself").toBeDefined();
    // Naming the workspace AND the slug is the difference between a line
    // somebody can act on and a number in a log nobody reads.
    expect(line).toContain(other.tenantId);
    expect(line).toContain("sweep_other");

    // The healthy workspace was still brought forward.
    expect(await hasCompanion(own.table)).toBe(true);
  });
});
