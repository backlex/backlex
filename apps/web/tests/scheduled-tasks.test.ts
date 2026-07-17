/**
 * Scheduled-task queue (`services/scheduled-tasks.ts`) — the persistence
 * behind long `delay` flow continuations, drained by the scheduler's
 * `cronTick`.
 *
 * The claim semantics are the whole point: `claimDueTasks` marks a row
 * `claimed_at = now` when it hands it out, so a second claim (a concurrent /
 * later tick) must NOT return it again. Rows are only removed by
 * `deleteTask` (the caller does that after a successful resume).
 *
 * The last block drives the real `cronTick` end-to-end over an enqueued
 * flow-continuation and asserts the continuation's `item.create` landed.
 */
import { afterEach, beforeEach, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext, type Ctx } from "../src/server/context";
import {
  claimDueTasks,
  deleteTask,
  enqueueTask,
  type ResumePayload,
} from "../src/server/services/scheduled-tasks";
import { cronTick } from "../src/server/services/scheduler";

const JSON_HEADERS = { "Content-Type": "application/json" };

const makePayload = (marker: string): ResumePayload => ({
  kind: "flow-continuation",
  flowName: marker,
  remainingOps: [{ type: "log", message: marker } as any],
  data: { marker },
  authSubject: { userId: null, email: null, roles: [] },
  last: null,
});

const taskRows = (dbPath: string) => {
  const client = new Database(dbPath);
  try {
    return client
      .query("SELECT id, claimed_at as claimedAt FROM scheduled_tasks")
      .all() as Array<{ id: string; claimedAt: number | null }>;
  } finally {
    client.close();
  }
};

describe("scheduled-tasks — enqueue / claim / delete semantics", () => {
  let h: TestHarness;
  let ctx: Ctx;

  beforeEach(async () => {
    h = makeHarness();
    ctx = await buildContext(h.env);
  });
  afterEach(() => h.cleanup());

  test("a due task is claimed exactly once; a second claim returns nothing", async () => {
    const payload = makePayload("claim-once");
    const { id } = await enqueueTask(ctx, {
      runAt: new Date(Date.now() - 1_000),
      payload,
    });

    const first = await claimDueTasks(ctx);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe(id);
    // Payload round-trips through the JSON column intact (parsed, not a string).
    expect(first[0]!.payload).toEqual(payload);
    expect(first[0]!.tenantId).toBeNull();
    expect(first[0]!.flowId).toBeNull();

    // The dedupe contract: the row is now marked claimed, so a second tick
    // must NOT hand it out again — even though it's still in the table.
    const second = await claimDueTasks(ctx);
    expect(second).toHaveLength(0);
    const rows = taskRows(h.env.SQLITE_PATH as string);
    expect(rows).toHaveLength(1); // claim does NOT delete
    expect(rows[0]!.claimedAt).not.toBeNull();
  });

  test("a not-yet-due task is not claimed", async () => {
    await enqueueTask(ctx, {
      runAt: new Date(Date.now() + 60_000),
      payload: makePayload("future"),
    });
    expect(await claimDueTasks(ctx)).toHaveLength(0);
    // Still unclaimed and intact for when it comes due.
    const rows = taskRows(h.env.SQLITE_PATH as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimedAt).toBeNull();
  });

  test("only due tasks are claimed when due and future tasks coexist", async () => {
    const due = await enqueueTask(ctx, {
      runAt: new Date(Date.now() - 500),
      payload: makePayload("due"),
    });
    await enqueueTask(ctx, {
      runAt: new Date(Date.now() + 60_000),
      payload: makePayload("later"),
    });

    const claimed = await claimDueTasks(ctx);
    expect(claimed.map((r) => r.id)).toEqual([due.id]);
  });

  test("enqueue persists tenantId / flowId; deleteTask removes the row", async () => {
    const { id } = await enqueueTask(ctx, {
      tenantId: "tenant-1",
      flowId: "flow-1",
      runAt: new Date(Date.now() - 1_000),
      payload: makePayload("del"),
    });

    const claimed = await claimDueTasks(ctx);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.tenantId).toBe("tenant-1");
    expect(claimed[0]!.flowId).toBe("flow-1");

    await deleteTask(ctx, id);
    expect(taskRows(h.env.SQLITE_PATH as string)).toHaveLength(0);
    expect(await claimDueTasks(ctx)).toHaveLength(0);
  });
});

describe("scheduled-tasks — cronTick drains flow continuations", () => {
  let h: TestHarness;
  let ctx: Ctx;
  let tenantId: string;
  const slug = `notes_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(create.status).toBe(201);

    const client = new Database(h.env.SQLITE_PATH as string);
    try {
      tenantId = (
        client.query("SELECT id FROM tenants WHERE slug = 'default'").get() as { id: string }
      ).id;
    } finally {
      client.close();
    }
    ctx = await buildContext(h.env);
  });
  afterAll(() => h.cleanup());

  test("a due continuation is resumed (item.create runs) and the row is deleted", async () => {
    const payload: ResumePayload = {
      kind: "flow-continuation",
      flowName: "resume-e2e",
      remainingOps: [
        { type: "item.create", collection: slug, data: { title: "resumed-by-tick" } } as any,
      ],
      data: {},
      authSubject: { userId: null, email: null, roles: [], tenantId },
      last: null,
    };
    await enqueueTask(ctx, {
      tenantId,
      runAt: new Date(Date.now() - 1_000),
      payload,
    });

    await cronTick(h.env);

    // The continuation's effect: the row exists in the collection.
    const res = await h.fetch(`/api/items/${slug}`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: Array<{ title: string }> }).data;
    expect(rows.some((r) => r.title === "resumed-by-tick")).toBe(true);

    // Successful resume deletes the task — nothing left to claim or re-run.
    expect(taskRows(h.env.SQLITE_PATH as string)).toHaveLength(0);
    await cronTick(h.env);
    const again = await h.fetch(`/api/items/${slug}`);
    const rows2 = ((await again.json()) as { data: Array<{ title: string }> }).data;
    expect(rows2.filter((r) => r.title === "resumed-by-tick")).toHaveLength(1); // no double-run
  });

  test("an unknown payload kind is dropped by the tick (not retried forever)", async () => {
    await enqueueTask(ctx, {
      runAt: new Date(Date.now() - 1_000),
      payload: { kind: "bogus" } as unknown as ResumePayload,
    });
    expect(taskRows(h.env.SQLITE_PATH as string)).toHaveLength(1);

    await cronTick(h.env);
    expect(taskRows(h.env.SQLITE_PATH as string)).toHaveLength(0);
  });

  test("a future continuation survives the tick untouched", async () => {
    const { id } = await enqueueTask(ctx, {
      tenantId,
      runAt: new Date(Date.now() + 60_000),
      payload: {
        kind: "flow-continuation",
        flowName: "not-yet",
        remainingOps: [
          { type: "item.create", collection: slug, data: { title: "too-early" } } as any,
        ],
        data: {},
        authSubject: { userId: null, email: null, roles: [], tenantId },
        last: null,
      },
    });

    await cronTick(h.env);

    const rows = taskRows(h.env.SQLITE_PATH as string);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0]!.claimedAt).toBeNull();

    const res = await h.fetch(`/api/items/${slug}`);
    const items = ((await res.json()) as { data: Array<{ title: string }> }).data;
    expect(items.some((r) => r.title === "too-early")).toBe(false);

    await deleteTask(ctx, id); // leave the table clean for other tests
  });
});
