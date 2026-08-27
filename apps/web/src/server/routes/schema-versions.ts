/**
 * Schema versions REST surface — migration diffing / schema branching (#9).
 * Mounted at `/api/admin/schema`. Every route is DDL-gated (signed-in +
 * platform plane + admin) exactly like `/api/collections`, since applying a
 * diff mutates the physical schema. The heavy lifting lives in
 * services/schema-versions.ts; these handlers are thin validate-and-delegate.
 */
import { AppError } from "@backlex/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../app";
import { logActivity } from "../services/activity";
import { requireUser } from "../middleware/session";
import { requireAdminMw, requirePlatformMw } from "../services/roles/guards";
import {
  applySchema,
  captureSnapshot,
  createBranch,
  deleteBranch,
  deleteSnapshot,
  diff,
  getBranch,
  getSnapshot,
  importSnapshot,
  listBranches,
  listSnapshots,
  type SchemaRef,
  updateBranchHead,
} from "../services/schema-versions";
import { readJson } from "../lib/body";

const DDL_GATE = [requireUser, requirePlatformMw, requireAdminMw] as const;

const requireTenant = (c: { get: (k: string) => unknown }): string => {
  const tenantId = (c.get("auth") as { tenantId?: string } | undefined)?.tenantId;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const userIdOf = (c: { get: (k: string) => unknown }): string | null =>
  (c.get("auth") as { userId?: string } | undefined)?.userId ?? null;

// `storage` rides along so a destructive apply can capture the DATA it is about
// to destroy, not just the schema shape. Without it `applySchema` still runs but
// reports `dataSnapshotIds: []`, which is the honest answer rather than a
// safety net that silently isn't there.
const ctxOf = (c: { get: (k: string) => unknown }) => {
  const { db, dialect, storage } = c.get("ctx") as {
    db: unknown;
    dialect: "pg" | "sqlite";
    storage: never;
  };
  return { db, dialect, storage };
};

const RefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live") }),
  z.object({ kind: z.literal("snapshot"), id: z.string().min(1) }),
  z.object({ kind: z.literal("branch"), id: z.string().min(1) }),
]) as z.ZodType<SchemaRef>;

// A field definition inside an imported snapshot. Loose on purpose — the
// service runs the canonical `validateFields` before anything is stored.
const FieldSchema = z
  .object({ name: z.string(), type: z.string() })
  .passthrough();

const SnapshotCollectionSchema = z
  .object({
    slug: z.string(),
    fields: z.array(FieldSchema).default([]),
  })
  .passthrough();

export const schemaVersionsRoutes = new Hono<AppBindings>()
  // ── Snapshots ──────────────────────────────────────────────────────────
  .get("/snapshots", ...DDL_GATE, async (c) => {
    const data = await listSnapshots(ctxOf(c), requireTenant(c));
    return c.json({ data });
  })
  .post("/snapshots", ...DDL_GATE, async (c) => {
    const body = z
      .object({ name: z.string().min(1).max(120), note: z.string().max(2000).nullable().optional() })
      .parse(await readJson(c.req));
    const snap = await captureSnapshot(ctxOf(c), requireTenant(c), {
      name: body.name,
      note: body.note ?? null,
      createdBy: userIdOf(c),
    });
    return c.json({ data: snap }, 201);
  })
  .post("/snapshots/import", ...DDL_GATE, async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        note: z.string().max(2000).nullable().optional(),
        // Both shapes: a bare collections array (what an export was before
        // config joined, and what every existing caller sends) or a whole
        // document. Accepting only the array would mean an export this very
        // service produces could not be imported back — which is the loop the
        // endpoint exists for.
        snapshot: z.union([
          z.array(SnapshotCollectionSchema),
          z.object({
            collections: z.array(SnapshotCollectionSchema),
            // Loose here on purpose: the service checks each entry has a natural
            // key and names a known resource, and the resource itself validates
            // its own shape when the apply reaches it.
            config: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
          }),
        ]),
      })
      .parse(await readJson(c.req));
    const snap = await importSnapshot(ctxOf(c), requireTenant(c), {
      name: body.name,
      note: body.note ?? null,
      // Loosely-parsed above; the service runs the canonical validateFields.
      snapshot: body.snapshot as never,
      createdBy: userIdOf(c),
    });
    return c.json({ data: snap }, 201);
  })
  .get("/snapshots/:id", ...DDL_GATE, async (c) => {
    const data = await getSnapshot(ctxOf(c), requireTenant(c), c.req.param("id"));
    return c.json({ data });
  })
  .delete("/snapshots/:id", ...DDL_GATE, async (c) => {
    await deleteSnapshot(ctxOf(c), requireTenant(c), c.req.param("id"));
    return c.json({ ok: true });
  })
  // ── Branches ───────────────────────────────────────────────────────────
  .get("/branches", ...DDL_GATE, async (c) => {
    const data = await listBranches(ctxOf(c), requireTenant(c));
    return c.json({ data });
  })
  .post("/branches", ...DDL_GATE, async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(64),
        note: z.string().max(2000).nullable().optional(),
        fromSnapshotId: z.string().nullable().optional(),
      })
      .parse(await readJson(c.req));
    const branch = await createBranch(ctxOf(c), requireTenant(c), {
      name: body.name,
      note: body.note ?? null,
      fromSnapshotId: body.fromSnapshotId ?? null,
      createdBy: userIdOf(c),
    });
    return c.json({ data: branch }, 201);
  })
  .get("/branches/:id", ...DDL_GATE, async (c) => {
    const data = await getBranch(ctxOf(c), requireTenant(c), c.req.param("id"));
    return c.json({ data });
  })
  .patch("/branches/:id/head", ...DDL_GATE, async (c) => {
    const body = z
      .object({
        data: z.array(SnapshotCollectionSchema).optional(),
        fromSnapshotId: z.string().nullable().optional(),
        name: z.string().max(120).optional(),
      })
      .parse(await readJson(c.req));
    const branch = await updateBranchHead(ctxOf(c), requireTenant(c), c.req.param("id"), {
      // Loosely-parsed above; the service normalizes + runs validateFields.
      data: body.data as never,
      fromSnapshotId: body.fromSnapshotId ?? null,
      name: body.name,
      createdBy: userIdOf(c),
    });
    return c.json({ data: branch });
  })
  .delete("/branches/:id", ...DDL_GATE, async (c) => {
    await deleteBranch(ctxOf(c), requireTenant(c), c.req.param("id"));
    return c.json({ ok: true });
  })
  // ── Diff + apply ─────────────────────────────────────────────────────────
  .post("/diff", ...DDL_GATE, async (c) => {
    const body = z.object({ from: RefSchema, to: RefSchema }).parse(await readJson(c.req));
    const data = await diff(ctxOf(c), requireTenant(c), body.from, body.to);
    return c.json({ data });
  })
  .post("/apply", ...DDL_GATE, async (c) => {
    const body = z
      .object({ target: RefSchema, confirmDestructive: z.boolean().optional() })
      .parse(await readJson(c.req));
    const tenantId = requireTenant(c);
    const result = await applySchema(ctxOf(c), tenantId, {
      target: body.target,
      confirmDestructive: body.confirmDestructive,
      createdBy: userIdOf(c),
    });
    if (!result.noop) {
      await logActivity(c, {
        action: "update",
        collection: "system_schema",
        itemId: body.target.kind === "live" ? "live" : body.target.id,
        payload: {
          target: body.target,
          confirmDestructive: Boolean(body.confirmDestructive),
          counts: result.diff.counts,
        },
        response: { applied: result.applied.length, safetySnapshotId: result.safetySnapshotId },
      });
    }
    return c.json({ data: result });
  });
