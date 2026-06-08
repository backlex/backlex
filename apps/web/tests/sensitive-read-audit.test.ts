/**
 * Sensitive-read audit (`auditReads` per collection → `access.read` rows).
 *
 * Covers the opt-in read-auditing feature:
 *   - a collection with `auditReads: true` records an `access.read` activity
 *     row on both the list (`GET /items/:slug`) and by-id
 *     (`GET /items/:slug/:id`) read paths;
 *   - a collection without the flag records nothing on reads;
 *   - the audit rows carry metadata only (item ids, field names, query shape,
 *     count) and never the row *values* — the whole point of the feature;
 *   - `pruneOldActivityByPrefix` trims aged `access.*` rows without touching
 *     other namespaces.
 *
 * Read auditing is fire-and-forget (runs outside the response via `keepAlive`),
 * so the integration assertions poll `/api/activity` briefly rather than
 * reading once.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  pruneOldActivityByPrefix,
  recordActivity,
} from "../src/server/services/activity";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface AccessRow {
  id: string;
  action: string;
  collection: string | null;
  itemId: string | null;
  payload: unknown;
  response: unknown;
}

/** Poll `GET /api/activity?action=access` until `predicate` holds or we give
 *  up. Read auditing is async, so a single read can race the insert. */
const waitForAccessRows = async (
  h: TestHarness,
  predicate: (rows: AccessRow[]) => boolean,
  tries = 25,
): Promise<AccessRow[]> => {
  for (let i = 0; i < tries; i++) {
    const res = await h.fetch("/api/activity?action=access&limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: AccessRow[] };
    if (predicate(body.data)) return body.data;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for access.read rows");
};

const createCollection = (h: TestHarness, slug: string, auditReads: boolean) =>
  h.fetch("/api/collections", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      slug,
      auditReads,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "secret", type: "text" },
      ],
    }),
  });

const insertItem = (h: TestHarness, slug: string, title: string, secret: string) =>
  h.fetch(`/api/items/${slug}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title, secret }),
  });

describe("sensitive read audit: access.read rows", () => {
  let h: TestHarness;
  const audited = `aud_${Date.now()}`;
  const plain = `plain_${Date.now()}`;
  // A value we should NEVER find inside an access-audit row — proves the audit
  // stores metadata only, not the row body.
  const SECRET = "ssn-000-00-0000";
  let auditedId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    expect((await createCollection(h, audited, true)).status).toBe(201);
    expect((await createCollection(h, plain, false)).status).toBe(201);

    const ins = await insertItem(h, audited, "patient-row", SECRET);
    expect(ins.status).toBe(201);
    auditedId = ((await ins.json()) as { data: { id: string } }).data.id;

    const insPlain = await insertItem(h, plain, "plain-row", SECRET);
    expect(insPlain.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("list + by-id reads on an audited collection each record one access.read", async () => {
    // by-id
    const byId = await h.fetch(`/api/items/${audited}/${auditedId}`);
    expect(byId.status).toBe(200);
    // list
    const list = await h.fetch(`/api/items/${audited}`);
    expect(list.status).toBe(200);

    const rows = await waitForAccessRows(
      h,
      (rs) => rs.filter((r) => r.collection === audited).length >= 2,
    );
    const mine = rows.filter((r) => r.collection === audited);

    // Every row is namespaced `access.read`.
    for (const r of mine) expect(r.action).toBe("access.read");

    // The by-id read names the viewed item; the list read leaves itemId null.
    expect(mine.some((r) => r.itemId === auditedId)).toBe(true);
    expect(mine.some((r) => r.itemId === null)).toBe(true);
  });

  test("audit rows carry metadata only — never the row values", async () => {
    const rows = await waitForAccessRows(
      h,
      (rs) => rs.filter((r) => r.collection === audited).length >= 2,
    );
    for (const r of rows.filter((x) => x.collection === audited)) {
      const blob = JSON.stringify({ payload: r.payload, response: r.response });
      // The secret field value must not appear anywhere in the audit row.
      expect(blob.includes(SECRET)).toBe(false);
      // ...and we never store a response body for reads at all.
      expect(r.response).toBeNull();
    }
  });

  test("a collection without auditReads records nothing on reads", async () => {
    const byId = await h.fetch(`/api/items/${plain}`);
    expect(byId.status).toBe(200);
    // Give any (erroneous) async write a chance to land, then assert none did.
    await new Promise((r) => setTimeout(r, 120));
    const res = await h.fetch("/api/activity?action=access&limit=200");
    const body = (await res.json()) as { data: AccessRow[] };
    expect(body.data.some((r) => r.collection === plain)).toBe(false);
  });
});

describe("sensitive read audit: prefix retention prune", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("pruneOldActivityByPrefix deletes only aged access.* rows", async () => {
    const ctx = await buildContext(h.env);
    const dbCtx = { db: ctx.db, dialect: ctx.dialect };
    const DAY = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - 60 * DAY); // 60 days old
    const fresh = new Date(); // now

    // Two aged access rows, one fresh access row, and one aged *item* row
    // (different namespace — must survive a prefix-scoped prune).
    await recordActivity(dbCtx, { userId: null, action: "access.read", collection: "posts", payload: { x: 1 } });
    await recordActivity(dbCtx, { userId: null, action: "item.create", collection: "posts", payload: { x: 1 } });
    // Backdate the two rows we want gone via the admin SQL console.
    const backdate = (action: string, ts: number) =>
      h.fetch("/api/admin/db/sql/run?writes=1", {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
        body: JSON.stringify({
          sql: `UPDATE activity SET created_at = ${ts} WHERE action = '${action}'`,
        }),
      });
    expect((await backdate("access.read", old.getTime())).status).toBe(200);
    expect((await backdate("item.create", old.getTime())).status).toBe(200);
    // A fresh access row that must be kept.
    await recordActivity(dbCtx, { userId: null, action: "access.read", collection: "fresh", payload: { x: 1 } });
    void fresh;

    const res = await pruneOldActivityByPrefix(dbCtx, 30, "access.");
    expect(res.ok).toBe(true);

    const after = await h.fetch("/api/activity?limit=200");
    const rows = ((await after.json()) as { data: { action: string; collection: string | null }[] }).data;
    // Aged access row gone; fresh access row kept; aged item row untouched.
    expect(rows.some((r) => r.action === "access.read" && r.collection === "posts")).toBe(false);
    expect(rows.some((r) => r.action === "access.read" && r.collection === "fresh")).toBe(true);
    expect(rows.some((r) => r.action === "item.create" && r.collection === "posts")).toBe(true);
  });
});
