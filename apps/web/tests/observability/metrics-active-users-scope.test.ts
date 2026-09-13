/**
 * The "active users" tile counts THIS workspace, not the deployment.
 *
 * `metrics.ts` read `SELECT user_id, created_at FROM sessions WHERE created_at
 * >= …` with no tenant clause at all, so a workspace admin's active-user count
 * was every signed-in person on the instance. Strictly larger than the
 * `activity` leak beside it, which Faz 4 closed. See #332.
 *
 * `sessions` is a global better-auth table with no `tenant_id`, so this is not
 * a missing predicate — it is a join, and which join decides what the number
 * MEANS. The decision recorded here: the tile counts **people administering
 * this workspace**, i.e. `tenant_members`. App-plane end-users have no
 * membership row and are deliberately not in it; a workspace's end-user count
 * is a different tile, and inventing it silently would change a number an
 * operator reads off a dashboard.
 *
 * The assertion is cross-tenant on purpose: one signed-in user per workspace,
 * and each workspace's tile must see exactly its own. A count that merely
 * "looks right" for a single tenant is what shipped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const json = { "Content-Type": "application/json" };

describe("the active-users tile", () => {
  let h: TestHarness;
  let otherUserId = "";

  const runSql = async (statement: string, writes = false) => {
    const res = await h.fetch(`/api/admin/db/sql/run${writes ? "?writes=1" : ""}`, {
      method: "POST",
      headers: writes ? { ...json, "x-backlex-confirm": "yes" } : json,
      body: JSON.stringify({ sql: statement }),
    });
    if (![200, 201].includes(res.status)) {
      throw new Error(`SQL ${res.status}: ${await res.text()} — for: ${statement.slice(0, 120)}`);
    }
    const body = (await res.json()) as { data: { rows: Record<string, unknown>[] }[] };
    return body.data[0]?.rows ?? [];
  };

  const activeUsers = async (): Promise<number> => {
    const res = await h.fetch("/api/admin/metrics/overview?range=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totals: { activeUsers: number } } };
    return body.data.totals.activeUsers;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // A second workspace with its own member and its own live session. The
    // session table is GLOBAL, so before the fix this row counted towards the
    // first workspace's tile.
    otherUserId = `u-other-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await runSql(
      `INSERT INTO tenants (id, slug, name, created_at, updated_at)
       VALUES ('t-other', 'other', 'Other', ${now}, ${now})`,
      true,
    );
    await runSql(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES ('${otherUserId}', 'Other', 'other@example.test', 0, ${now}, ${now})`,
      true,
    );
    await runSql(
      `INSERT INTO tenant_members (id, tenant_id, user_id, email, role, status, created_at, updated_at)
       VALUES ('m-other', 't-other', '${otherUserId}', 'other@example.test', 'admin', 'active', ${now}, ${now})`,
      true,
    );
    await runSql(
      `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
       VALUES ('s-other', '${otherUserId}', 'tok-other', ${now + 86400000}, ${now}, ${now})`,
      true,
    );
  });
  afterAll(() => h.cleanup());

  test("the other workspace's session really is in the global table", async () => {
    // Without this the test below could pass because the fixture never landed,
    // which is the same green as a correctly scoped query.
    const rows = await runSql(`SELECT user_id FROM sessions WHERE id = 's-other'`);
    expect(rows).toHaveLength(1);
    // And it is NOT a member of the workspace under test.
    const mine = await runSql(
      `SELECT user_id FROM tenant_members WHERE user_id = '${otherUserId}' AND tenant_id != 't-other'`,
    );
    expect(mine).toEqual([]);
  });

  test("a member of another workspace is not counted here", async () => {
    const n = await activeUsers();
    // The seeded admin's own session is the one that belongs to this workspace.
    // Before the fix this was 2 — the other workspace's session included.
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBe(1);
  });
});
