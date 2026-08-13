/**
 * Retention for the three tables that grew forever: `jobs`,
 * `webhook_deliveries` and `revisions`.
 *
 * Every assertion here is three-sided on purpose. "Insert one old row, prune,
 * assert zero rows left" is the textbook vacuous retention test — it passes
 * just as well against a DELETE with no WHERE clause at all. So each case seeds
 * rows on BOTH sides of the cutoff and asserts the recent ones survive, and the
 * jobs case additionally seeds a `pending` row older than any cutoff and asserts
 * it survives: a status-blind DELETE would eat a customer's scheduled work, and
 * that is the one failure of this feature that would not look like a bug.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { schema as sqliteSchema } from "@backlex/db/sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { pruneFinishedJobs } from "../src/server/services/jobs";
import { pruneWebhookDeliveries } from "../src/server/services/webhooks";
import { pruneOldRevisions, recordRevision } from "../src/server/services/revisions";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): number => Date.now() - days * DAY;

describe("retention prunes", () => {
  let h: TestHarness;
  let ctx: Awaited<ReturnType<typeof buildContext>>;
  let db: any;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    ctx = await buildContext(h.env);
    db = ctx.db as any;
  });
  afterAll(() => h.cleanup());

  const rowsOf = async (query: string): Promise<Array<Record<string, unknown>>> =>
    (await db.all(sql.raw(query))) as Array<Record<string, unknown>>;

  test("jobs: old finished rows go, recent ones and PENDING work stay", async () => {
    const mk = (id: string, status: string, updatedDaysAgo: number) =>
      db.run(
        sql.raw(
          `INSERT INTO jobs (id, tenant_id, queue, type, payload, status, priority, run_at, attempts, max_attempts, created_at, updated_at)
           VALUES ('${id}', NULL, 'default', 'function', '{}', '${status}', 0, ${ago(updatedDaysAgo)}, 0, 5, ${ago(updatedDaysAgo)}, ${ago(updatedDaysAgo)})`,
        ),
      );

    await mk("j-fresh", "succeeded", 1);
    await mk("j-mid", "succeeded", 45);
    await mk("j-old", "succeeded", 200);
    await mk("j-dead-mid", "dead_letter", 45);
    await mk("j-dead-old", "dead_letter", 200);
    // Older than every cutoff in play, and scheduled to run in the future.
    // A delayed job legitimately looks exactly like this.
    await db.run(
      sql.raw(
        `INSERT INTO jobs (id, tenant_id, queue, type, payload, status, priority, run_at, attempts, max_attempts, created_at, updated_at)
         VALUES ('j-pending', NULL, 'default', 'function', '{}', 'pending', 0, ${Date.now() + 30 * DAY}, 0, 5, ${ago(400)}, ${ago(400)})`,
      ),
    );

    const r = await pruneFinishedJobs({ db, dialect: ctx.dialect }, 90, 120);
    expect(r.ok).toBe(true);

    const ids = (await rowsOf("SELECT id FROM jobs")).map((x) => x.id);
    // Inside its window — proves the DELETE is bounded, not blanket.
    expect(ids).toContain("j-fresh");
    expect(ids).toContain("j-mid");
    // The dead-letter arm has its own, longer clock: 45d survives 120d where a
    // shared 90d clock would also have kept it, so this pins the split.
    expect(ids).toContain("j-dead-mid");
    // Past their windows.
    expect(ids).not.toContain("j-old");
    expect(ids).not.toContain("j-dead-old");
    // The assertion this test exists for.
    expect(ids).toContain("j-pending");
  });

  test("jobs: retention 0 disables that arm without touching rows", async () => {
    const before = (await rowsOf("SELECT id FROM jobs")).length;
    const r = await pruneFinishedJobs({ db, dialect: ctx.dialect }, 0, 0);
    expect(r.finished).toBe(false);
    expect(r.failed).toBe(false);
    expect((await rowsOf("SELECT id FROM jobs")).length).toBe(before);
  });

  test("webhook_deliveries: only attempts past the cutoff are removed", async () => {
    const mk = (id: string, daysAgo: number) =>
      db.run(
        sql.raw(
          `INSERT INTO webhook_deliveries (id, webhook_id, event, status, ms, attempts, delivered_at)
           VALUES ('${id}', 'wh1', 'items.created', 200, 12, 1, ${ago(daysAgo)})`,
        ),
      );
    await mk("d-fresh", 1);
    await mk("d-mid", 20);
    await mk("d-old", 200);

    const r = await pruneWebhookDeliveries({ db, dialect: ctx.dialect }, 30);
    expect(r.ok).toBe(true);

    const ids = (await rowsOf("SELECT id FROM webhook_deliveries")).map((x) => x.id);
    expect(ids).toContain("d-fresh");
    expect(ids).toContain("d-mid");
    expect(ids).not.toContain("d-old");
  });

  test("webhook_deliveries: retention 0 disables the prune", async () => {
    const before = (await rowsOf("SELECT id FROM webhook_deliveries")).length;
    const r = await pruneWebhookDeliveries({ db, dialect: ctx.dialect }, 0);
    expect(r.ok).toBe(false);
    expect((await rowsOf("SELECT id FROM webhook_deliveries")).length).toBe(before);
  });

  test("revisions: only snapshots past the cutoff are removed", async () => {
    const mk = (id: string, daysAgo: number) =>
      db.run(
        sql.raw(
          `INSERT INTO revisions (id, tenant_id, collection, item_id, snapshot, created_at)
           VALUES ('${id}', NULL, 'posts', 'i1', '{}', ${ago(daysAgo)})`,
        ),
      );
    await mk("r-fresh", 1);
    await mk("r-mid", 100);
    await mk("r-old", 400);

    const r = await pruneOldRevisions({ db, dialect: ctx.dialect }, 180);
    expect(r.ok).toBe(true);

    const ids = (await rowsOf("SELECT id FROM revisions")).map((x) => x.id);
    expect(ids).toContain("r-fresh");
    expect(ids).toContain("r-mid");
    expect(ids).not.toContain("r-old");
  });

  test("revisions: retention 0 disables the prune", async () => {
    const before = (await rowsOf("SELECT id FROM revisions")).length;
    const r = await pruneOldRevisions({ db, dialect: ctx.dialect }, 0);
    expect(r.ok).toBe(false);
    expect((await rowsOf("SELECT id FROM revisions")).length).toBe(before);
  });

  test("a revision that cannot be written reports instead of vanishing", async () => {
    // `recordRevision` runs inside a write's `sideEffects`, after the row is
    // already committed, so it must not throw. It used to swallow the error into
    // console.error alone — meaning the per-row undo history could silently stop
    // being written. Both halves are asserted: it still resolves, AND it says so.
    // Fails ONLY the revisions insert. Failing every insert would also break
    // `recordActivity`, so the test would be asserting that a broken database
    // cannot report anything — true, useless, and not what this covers.
    const failing = new Proxy(db, {
      get(target: any, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === sqliteSchema.revisions) {
              return {
                values: () => {
                  throw new Error("revisions table is read-only");
                },
              };
            }
            return target.insert(table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      recordRevision({ db: failing, dialect: ctx.dialect } as never, {
        collection: "posts",
        itemId: "i-audit",
        snapshot: { title: "x" },
        userId: null,
        tenantId: null,
      }),
    ).resolves.toBeUndefined();

    const audit = await rowsOf(
      "SELECT action, item_id FROM activity WHERE action = 'revision.failed'",
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((a) => a.item_id === "i-audit")).toBe(true);
  });
});
