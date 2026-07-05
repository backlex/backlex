/**
 * Backup / restore — the full admin lifecycle against the real storage
 * adapter (fs in tests) and the real dump/restore services:
 *
 *   run manual backup → tracked row → download the JSONL → delete data →
 *   restore (confirm-gated) → deleted rows come back, edits survive
 *   (restore is additive: ON CONFLICT DO NOTHING never overwrites).
 *
 * Plus the schedule config round-trip and the admin gate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const SLUG = "bk_notes";
let h: TestHarness;
let itemA: string;
let itemB: string;
let backupId: string;

interface BackupRow {
  id: string;
  status: string;
  tableCount: number;
  size: number;
  label: string | null;
  storageKey: string;
}

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const create = await h.fetch("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: SLUG,
      fields: [{ name: "title", type: "text", required: true }],
    }),
  });
  if (create.status !== 201) throw new Error(`collection create failed: ${create.status}`);
  const mk = async (title: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (r.status !== 201) throw new Error(`item create failed: ${r.status}`);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  itemA = await mk("keep-me");
  itemB = await mk("delete-me");
});

afterAll(() => h.cleanup());

describe("manual backup", () => {
  test("starts empty, then POST /backups/now produces a done row", async () => {
    const empty = ((await (await h.fetch("/api/admin/db/backups")).json()) as {
      data: BackupRow[];
    }).data;
    expect(empty).toEqual([]);

    const run = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "before-disaster" }),
    });
    expect(run.status).toBe(201);
    const row = ((await run.json()) as { data: BackupRow }).data;
    backupId = row.id;
    expect(row.status).toBe("done");
    expect(row.label).toBe("before-disaster");
    expect(row.tableCount).toBeGreaterThan(0);
    expect(row.size).toBeGreaterThan(0);

    const list = ((await (await h.fetch("/api/admin/db/backups")).json()) as {
      data: BackupRow[];
    }).data;
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(backupId);
  });

  test("download streams the JSONL dump containing our data", async () => {
    const res = await h.fetch(`/api/admin/db/backups/${backupId}/download`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Every line is a {table, row} JSON envelope.
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines.slice(0, 5)) {
      const parsed = JSON.parse(line) as { table?: string; row?: unknown };
      expect(typeof parsed.table).toBe("string");
      expect(parsed.row).toBeDefined();
    }
    expect(text).toContain('"delete-me"');
    expect(text).toContain('"keep-me"');
    // System tables ride along (collections metadata is what makes restore
    // able to recreate physical tables).
    expect(lines.some((l) => (JSON.parse(l) as { table: string }).table === "collections")).toBe(true);
  });
});

describe("restore", () => {
  test("requires the X-Backlex-Confirm header", async () => {
    const res = await h.fetch(`/api/admin/db/backups/${backupId}/restore`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("404 for an unknown backup id", async () => {
    const res = await h.fetch("/api/admin/db/backups/no-such-backup/restore", {
      method: "POST",
      headers: { "X-Backlex-Confirm": "yes" },
    });
    expect(res.status).toBe(404);
  });

  test("brings deleted rows back and never overwrites edits", async () => {
    // Disaster: one row deleted, one row edited AFTER the backup.
    const del = await h.fetch(`/api/items/${SLUG}/${itemB}`, { method: "DELETE" });
    expect(del.ok).toBe(true);
    const edit = await h.fetch(`/api/items/${SLUG}/${itemA}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "edited-after-backup" }),
    });
    expect(edit.ok).toBe(true);

    const res = await h.fetch(`/api/admin/db/backups/${backupId}/restore`, {
      method: "POST",
      headers: { "X-Backlex-Confirm": "yes" },
    });
    expect(res.status).toBe(200);
    const result = ((await res.json()) as {
      data: { tableCount: number; rowCount: number; skipped: number };
    }).data;
    expect(result.rowCount).toBeGreaterThan(0);

    // The deleted row is back with its original content…
    const restored = await h.fetch(`/api/items/${SLUG}/${itemB}`);
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { data: { title: string } }).data.title).toBe("delete-me");
    // …and the post-backup edit was NOT clobbered by the older dump.
    const kept = await h.fetch(`/api/items/${SLUG}/${itemA}`);
    expect(((await kept.json()) as { data: { title: string } }).data.title).toBe(
      "edited-after-backup",
    );
  });
});

describe("backup schedule config", () => {
  test("defaults to off/7 and round-trips a PUT", async () => {
    const def = ((await (await h.fetch("/api/admin/db/backups/config")).json()) as {
      data: { schedule: string; retain: number };
    }).data;
    expect(def).toEqual({ schedule: "off", retain: 7, retainDays: null });

    const put = await h.fetch("/api/admin/db/backups/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: "daily", retain: 3 }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: unknown }).data).toEqual({
      schedule: "daily",
      retain: 3,
      retainDays: null,
    });
    const after = ((await (await h.fetch("/api/admin/db/backups/config")).json()) as {
      data: unknown;
    }).data;
    expect(after).toEqual({ schedule: "daily", retain: 3, retainDays: null });

    // Age rule round-trips too; explicit null turns it back off.
    const days = await h.fetch("/api/admin/db/backups/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retainDays: 14 }),
    });
    expect(((await days.json()) as { data: unknown }).data).toEqual({
      schedule: "daily",
      retain: 3,
      retainDays: 14,
    });
    const off = await h.fetch("/api/admin/db/backups/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retainDays: null }),
    });
    expect(((await off.json()) as { data: { retainDays: number | null } }).data.retainDays).toBeNull();
  });

  test("rejects an invalid schedule value", async () => {
    const res = await h.fetch("/api/admin/db/backups/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: "hourly" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("admin gate", () => {
  test("non-admin users get 403 on every backup endpoint", async () => {
    const member = makeHarness({ SQLITE_PATH: h.env.SQLITE_PATH });
    const res = await member.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `bk-member-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Member",
      }),
    });
    expect(res.ok).toBe(true);
    expect((await member.fetch("/api/admin/db/backups")).status).toBe(403);
    expect(
      (await member.fetch("/api/admin/db/backups/now", { method: "POST" })).status,
    ).toBe(403);
    expect(
      (
        await member.fetch(`/api/admin/db/backups/${backupId}/restore`, {
          method: "POST",
          headers: { "X-Backlex-Confirm": "yes" },
        })
      ).status,
    ).toBe(403);
  });
});
