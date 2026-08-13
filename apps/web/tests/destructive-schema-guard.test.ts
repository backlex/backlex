/**
 * Destructive schema operations: impact reporting, the confirm gate, and the
 * pre-drop data snapshot that makes them recoverable.
 *
 * Two vacuity traps this file is written around.
 *
 * 1. Asserting "the drop is refused without the header" against an EMPTY
 *    collection passes for the wrong reason — the gate is conditional, so an
 *    empty column is supposed to drop freely — and never exercises the
 *    snapshot at all. Every gate assertion here runs against a column that
 *    actually holds values.
 * 2. Asserting "a refusal returned 403" without checking the column is still
 *    there would pass for a route that refuses AND drops. Each refusal is
 *    paired with a read-back.
 *
 * The last test is the one that matters most: it goes through
 * `POST /api/schema/apply`, NOT the collections route. That path reaches the
 * same `dropField`/`dropCollection` from REST, the SDK, the CLI, MCP and
 * GraphQL, so a guard implemented in the DELETE handler would cover none of it.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { restoreBackup } from "../src/server/services/backup";

const json = { "content-type": "application/json" };
const confirmed = { ...json, "x-backlex-confirm": "yes" };

describe("destructive schema guard", () => {
  let h: TestHarness;
  const slug = `guard_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "notes", type: "text" },
          { name: "scratch", type: "text" },
        ],
      }),
    });
    expect(made.status).toBe(201);
    // Three rows; `notes` set on two of them. The asymmetry is the point — it
    // is what distinguishes `rows` from `nonNull`.
    for (const row of [
      { title: "A", notes: "keep-me" },
      { title: "B", notes: "and-me" },
      { title: "C" },
    ]) {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(row),
      });
      expect(r.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  test("dry run reports rows and non-null separately, and changes nothing", async () => {
    const res = await h.fetch(`/api/collections/${slug}/fields/notes?dryRun=1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      rows: number;
      nonNull: number;
      table: string;
    };
    expect(body.dryRun).toBe(true);
    expect(body.rows).toBe(3);
    expect(body.nonNull).toBe(2);
    // A `COUNT(*)`-for-both bug would make these equal and the test would still
    // "pass" on each individually.
    expect(body.nonNull).not.toBe(body.rows);

    // Nothing touched: the field is still readable on an item.
    const list = await h.fetch(`/api/items/${slug}?limit=10`);
    const items = ((await list.json()) as { data: Array<Record<string, unknown>> }).data;
    expect(items.some((i) => i.notes === "keep-me")).toBe(true);
  });

  test("dropping a column WITH data is refused without the confirm header", async () => {
    const res = await h.fetch(`/api/collections/${slug}/fields/notes`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { details?: { nonNull?: number } } };
    // The refusal names the number, so an operator knows what they are deciding.
    expect(body.error?.details?.nonNull).toBe(2);

    // The other half: refused AND not dropped.
    const list = await h.fetch(`/api/items/${slug}?limit=10`);
    const items = ((await list.json()) as { data: Array<Record<string, unknown>> }).data;
    expect(items.some((i) => i.notes === "keep-me")).toBe(true);
  });

  test("an EMPTY column still drops with no header — the compat carve-out", async () => {
    // Pinned deliberately. CI, template automation and dev scripts drop
    // scaffolding columns without ceremony, and tightening this to "always
    // confirm" would break them. If someone changes the gate to unconditional,
    // this is what says so.
    const res = await h.fetch(`/api/collections/${slug}/fields/scratch`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; nonNull: number; snapshotId: string | null };
    expect(body.ok).toBe(true);
    expect(body.nonNull).toBe(0);
    // Nothing was at risk, so nothing was archived.
    expect(body.snapshotId).toBeNull();
  });

  test("a confirmed drop snapshots the values, and the restore puts them back", async () => {
    const res = await h.fetch(`/api/collections/${slug}/fields/notes`, {
      method: "DELETE",
      headers: confirmed,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshotId: string | null; nonNull: number };
    expect(body.nonNull).toBe(2);
    expect(body.snapshotId).toBeTruthy();

    // The column is gone.
    const gone = await h.fetch(`/api/items/${slug}?limit=10`);
    const goneItems = ((await gone.json()) as { data: Array<Record<string, unknown>> }).data;
    expect(goneItems.every((i) => i.notes === undefined)).toBe(true);

    // Recovery: re-add the field, then restore the snapshot in overwrite mode
    // narrowed to this one table. A plain additive restore CANNOT do this — the
    // rows still exist, so `ON CONFLICT DO NOTHING` skips every one and the
    // column comes back empty.
    const readd = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({
        fields: [
          { name: "title", type: "text", required: true },
          { name: "notes", type: "text" },
        ],
      }),
    });
    expect(readd.status).toBe(200);

    const ctx = await buildContext(h.env);
    const rows = (await (ctx.db as any).all(
      sql.raw(`SELECT storage_key FROM backups WHERE id = '${body.snapshotId}'`),
    )) as Array<{ storage_key: string }>;
    expect(rows[0]?.storage_key).toBeTruthy();

    // The physical table is `c_<tenantPrefix12>_<slug>`, not `c_<slug>` — read
    // it rather than reconstructing it, or `onlyTables` silently matches nothing
    // and the restore reports a cheerful zero.
    const meta = (await (ctx.db as any).all(
      sql.raw(`SELECT tenant_id, physical_table FROM collections WHERE slug = '${slug}'`),
    )) as Array<{ tenant_id: string; physical_table: string }>;
    const table = meta[0]!.physical_table;

    const restored = await restoreBackup(ctx, {
      storageKey: rows[0]!.storage_key,
      tenantId: meta[0]?.tenant_id ?? null,
      mode: "overwrite",
      onlyTables: [table],
    });
    expect(restored.overwritten).toBe(2); // exactly the `nonNull` the drop reported

    // By VALUE, not by count — a restore that put back two empty strings would
    // satisfy a count assertion.
    const back = await h.fetch(`/api/items/${slug}?limit=10`);
    const backItems = ((await back.json()) as { data: Array<Record<string, unknown>> }).data;
    const notes = backItems.map((i) => i.notes).filter(Boolean).sort();
    expect(notes).toEqual(["and-me", "keep-me"]);
  });

  test("deleting a collection WITH rows is refused, then snapshots when confirmed", async () => {
    const dry = await h.fetch(`/api/collections/${slug}?dryRun=1`, { method: "DELETE" });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { rows: number }).rows).toBe(3);

    const refused = await h.fetch(`/api/collections/${slug}`, { method: "DELETE" });
    expect(refused.status).toBe(403);
    // Refused AND still there.
    const still = await h.fetch(`/api/collections/${slug}`);
    expect(still.status).toBe(200);

    const done = await h.fetch(`/api/collections/${slug}`, {
      method: "DELETE",
      headers: confirmed,
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { rows: number; snapshotId: string | null };
    expect(body.rows).toBe(3);
    expect(body.snapshotId).toBeTruthy();
  });

  test("an EMPTY collection deletes with no header", async () => {
    const empty = `guard_empty_${Date.now()}`;
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug: empty, fields: [{ name: "t", type: "text" }] }),
    });
    expect(made.status).toBe(201);
    const res = await h.fetch(`/api/collections/${empty}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: number }).rows).toBe(0);
  });
});

/**
 * The guard is not route-local.
 *
 * `POST /api/schema/apply` reaches the same `dropField` through
 * `services/schema-versions.ts::executeDiff`, and it is reachable from REST, the
 * SDK, the CLI, MCP and GraphQL. Before this wave its only safety net was
 * `captureSnapshot`, which records the schema SHAPE and none of the data — so an
 * apply that dropped a column was exactly as unrecoverable as the route was, and
 * a fix living in the DELETE handler would have missed all of it.
 */
describe("schema apply captures data too", () => {
  let h: TestHarness;
  const slug = `applyguard_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "secret", type: "text" },
        ],
      }),
    });
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "A", secret: "do-not-lose-me" }),
    });
  });
  afterAll(() => h.cleanup());

  test("a destructive apply writes a pre-drop backup", async () => {
    // Author a target schema that simply lacks `secret`, then apply it. The
    // diff engine reads that as a `field.drop`, which is the destructive change
    // this test is about.
    const target = await h.fetch("/api/admin/schema/snapshots/import", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "without-secret",
        snapshot: [
          {
            slug,
            adopted: false,
            ownerScoped: false,
            tenantScoped: true,
            versioned: false,
            softDelete: false,
            fts: false,
            fields: [{ name: "title", type: "text", required: true }],
          },
        ],
      }),
    });
    expect(target.status).toBe(201);
    const targetId = ((await target.json()) as { data: { id: string } }).data.id;

    const applied = await h.fetch("/api/admin/schema/apply", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        target: { kind: "snapshot", id: targetId },
        confirmDestructive: true,
      }),
    });
    expect(applied.status).toBe(200);
    const body = ((await applied.json()) as {
      data: { dataSnapshotIds: string[]; safetySnapshotId: string | null };
    }).data;

    // The schema safety snapshot already existed; the DATA one is what this
    // wave added, and asserting both keeps the two from being confused.
    expect(body.safetySnapshotId).toBeTruthy();
    expect(body.dataSnapshotIds.length).toBeGreaterThan(0);

    const ctx = await buildContext(h.env);
    const rows = (await (ctx.db as any).all(
      sql.raw(
        `SELECT kind, status FROM backups WHERE id = '${body.dataSnapshotIds[0]}'`,
      ),
    )) as Array<{ kind: string; status: string }>;
    expect(rows[0]?.kind).toBe("pre-drop");
    expect(rows[0]?.status).toBe("done");
  });
});
