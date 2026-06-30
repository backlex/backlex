/**
 * Service-level integration tests for schema versions (#9) — drives the
 * snapshot / import / branch / diff / apply engine directly against a fresh
 * harness SQLite, exercising real DDL through `applyCollection` / `dropField` /
 * `dropCollection`. Verifies the snapshot tables exist (migration applied) and
 * that apply faithfully reconciles the live schema.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tableExists } from "@backlex/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  applySchema,
  captureSnapshot,
  createBranch,
  diff,
  importSnapshot,
  listBranches,
  listSnapshots,
  loadLiveSchema,
  updateBranchHead,
} from "../src/server/services/schema-versions";
import { makeHarness, type TestHarness } from "./setup";

// dual-dialect db union — sqlite handle here.
let ctx: { db: any; dialect: "sqlite" };
let h: TestHarness;
const T = crypto.randomUUID();

const postsV1 = [
  {
    slug: "posts",
    fields: [
      { name: "title", type: "text" as const, required: true, default: "untitled" },
      { name: "body", type: "longtext" as const },
    ],
  },
];

beforeEach(() => {
  h = makeHarness();
  const client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite" };
});
afterEach(() => h.cleanup());

describe("schema-versions — import + apply (create)", () => {
  test("applying an imported snapshot creates the collection + physical table", async () => {
    const snap = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    const res = await applySchema(ctx, T, { target: { kind: "snapshot", id: snap.id } });
    expect(res.noop).toBe(false);
    expect(res.diff.counts.additive).toBeGreaterThan(0);

    const live = await loadLiveSchema(ctx, T);
    expect(live.map((c) => c.slug)).toEqual(["posts"]);
    const table = live[0]?.physicalTable as string;
    expect(await tableExists(ctx.db, "sqlite", table)).toBe(true);
  });

  test("re-applying the same snapshot is a no-op", async () => {
    const snap = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    await applySchema(ctx, T, { target: { kind: "snapshot", id: snap.id } });
    const again = await applySchema(ctx, T, { target: { kind: "snapshot", id: snap.id } });
    expect(again.noop).toBe(true);
  });
});

describe("schema-versions — diff + destructive gating", () => {
  test("additive field add applies without confirm", async () => {
    const v1 = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    await applySchema(ctx, T, { target: { kind: "snapshot", id: v1.id } });

    const v2 = await importSnapshot(ctx, T, {
      name: "v2",
      snapshot: [
        {
          slug: "posts",
          fields: [
            { name: "title", type: "text" as const, required: true, default: "untitled" },
            { name: "body", type: "longtext" as const },
            { name: "views", type: "integer" as const },
          ],
        },
      ],
    });
    const res = await applySchema(ctx, T, { target: { kind: "snapshot", id: v2.id } });
    expect(res.noop).toBe(false);
    const live = await loadLiveSchema(ctx, T);
    expect(live[0]?.fields.map((f) => f.name)).toContain("views");
  });

  test("dropping a field is blocked without confirmDestructive, allowed with it", async () => {
    const v1 = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    await applySchema(ctx, T, { target: { kind: "snapshot", id: v1.id } });

    const v2 = await importSnapshot(ctx, T, {
      name: "v2",
      snapshot: [{ slug: "posts", fields: [{ name: "title", type: "text" as const, required: true, default: "untitled" }] }],
    });
    await expect(applySchema(ctx, T, { target: { kind: "snapshot", id: v2.id } })).rejects.toThrow(
      /destructive/i,
    );

    const res = await applySchema(ctx, T, {
      target: { kind: "snapshot", id: v2.id },
      confirmDestructive: true,
    });
    expect(res.noop).toBe(false);
    expect(res.safetySnapshotId).toBeTruthy();
    const live = await loadLiveSchema(ctx, T);
    expect(live[0]?.fields.map((f) => f.name)).not.toContain("body");
  });

  test("dropping a whole collection is destructive and drops the table", async () => {
    const v1 = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    await applySchema(ctx, T, { target: { kind: "snapshot", id: v1.id } });
    const before = await loadLiveSchema(ctx, T);
    const table = before[0]?.physicalTable as string;

    const empty = await importSnapshot(ctx, T, { name: "empty", snapshot: [] });
    const res = await applySchema(ctx, T, {
      target: { kind: "snapshot", id: empty.id },
      confirmDestructive: true,
    });
    expect(res.diff.hasDestructive).toBe(true);
    expect(await loadLiveSchema(ctx, T)).toHaveLength(0);
    expect(await tableExists(ctx.db, "sqlite", table)).toBe(false);
  });
});

describe("schema-versions — snapshots + branches", () => {
  test("captureSnapshot records the live schema; list returns it", async () => {
    const v1 = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    await applySchema(ctx, T, { target: { kind: "snapshot", id: v1.id } });
    const snap = await captureSnapshot(ctx, T, { name: "checkpoint" });
    expect(snap.collectionCount).toBe(1);
    const list = await listSnapshots(ctx, T);
    expect(list.some((s) => s.name === "checkpoint")).toBe(true);
  });

  test("branch forks live; diffing the branch vs live shows the staged change", async () => {
    const v1 = await importSnapshot(ctx, T, { name: "v1", snapshot: postsV1 });
    await applySchema(ctx, T, { target: { kind: "snapshot", id: v1.id } });

    const branch = await createBranch(ctx, T, { name: "add-views" });
    expect((await listBranches(ctx, T)).length).toBe(1);

    // Stage a change on the branch head only.
    await updateBranchHead(ctx, T, branch.id, {
      data: [
        {
          slug: "posts",
          fields: [
            { name: "title", type: "text" as const, required: true, default: "untitled" },
            { name: "body", type: "longtext" as const },
            { name: "views", type: "integer" as const },
          ],
        },
      ],
    });

    const d = await diff(ctx, T, { kind: "live" }, { kind: "branch", id: branch.id });
    expect(d.diff.counts.additive).toBe(1);
    expect(d.diff.changes[0]?.field).toBe("views");

    // Live is untouched until we apply the branch.
    expect((await loadLiveSchema(ctx, T))[0]?.fields).toHaveLength(2);
    await applySchema(ctx, T, { target: { kind: "branch", id: branch.id } });
    expect((await loadLiveSchema(ctx, T))[0]?.fields).toHaveLength(3);
  });
});
