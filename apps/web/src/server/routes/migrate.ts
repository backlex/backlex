/**
 * External-DB migration endpoints (docs/migrating-in.md).
 *
 *   Phase 1 — `POST /ingest/:slug`: bulk, PK-preserving, idempotent row copy
 *   into a managed collection, driven by the `backlex import-db` CLI pump
 *   (side-effect-free by design; see services/migrate-ingest.ts).
 *
 *   Phase 2 — server-side connector for sources the SERVER can reach:
 *     - `GET/POST /sources`, `DELETE /sources/:id`, `POST /sources/:id/test`
 *     - `GET /sources/:id/tables`, `POST /sources/:id/plan`
 *     - `GET/POST /runs`, `GET /runs/:id`, `POST /runs/:id/cancel|resume`
 *   Runs execute in bounded slices on the scheduler tick (lease-reclaimed,
 *   resumable); see services/migrate.ts.
 *
 * Mounted at `/api/admin/migrate` from `app.ts`. Same operator gate as the
 * other schema-mutating surfaces (`/api/collections` DDL, `/api/admin/db`):
 * signed-in + platform plane + admin role + active workspace.
 */
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requireAdminMw, requirePlatformMw } from "../services/roles/guards";
import { logActivity } from "../services/activity";
import { loadCollection } from "../services/items/collection-loader";
import { INGEST_MAX_ROWS, ingestRows } from "../services/migrate-ingest";
import {
  buildSourcePlan,
  cancelRun,
  createSource,
  deleteSource,
  getRun,
  listRuns,
  listSources,
  listSourceTables,
  resumeRun,
  startRun,
  testSource,
} from "../services/migrate";
import { readJson, readJsonOr } from "../lib/body";

const IngestInput = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(INGEST_MAX_ROWS),
  /** `upsert` (the `--since` delta path) overwrites rows whose PK already
   *  exists — created_at/tenant_id keep their original values. Default
   *  `insert` skips conflicts (idempotent first copy / resume). */
  mode: z.enum(["insert", "upsert"]).optional().default("insert"),
});

const SourceInput = z.object({
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2000),
});

const PlanInput = z.object({
  tables: z.array(z.string().min(1)).max(500).optional(),
});

const RunInput = z.object({
  sourceId: z.string().min(1),
  plan: z.unknown(),
});

export const migrateRoutes = new Hono<AppBindings>()
  .use("*", requireUser, requirePlatformMw, requireAdminMw, async (c, next) => {
    if (!c.get("auth")?.tenantId) {
      throw new AppError("VALIDATION", "Active workspace required for migration");
    }
    await next();
  })
  // ── Sources ─────────────────────────────────────────────────────────────
  .get("/sources", async (c) => {
    const data = await listSources(c.get("ctx"), c.get("auth").tenantId!);
    return c.json({ data });
  })
  .post("/sources", async (c) => {
    const body = SourceInput.parse(await readJson(c.req));
    const auth = c.get("auth");
    const data = await createSource(c.get("ctx"), auth.tenantId!, {
      ...body,
      createdBy: auth.userId,
    });
    await logActivity(c, {
      action: "migrate.source.create",
      collection: "system_migrate",
      itemId: data.id,
      payload: { name: data.name },
    });
    return c.json({ data }, 201);
  })
  .delete("/sources/:id", async (c) => {
    await deleteSource(c.get("ctx"), c.get("auth").tenantId!, c.req.param("id"));
    await logActivity(c, {
      action: "migrate.source.delete",
      collection: "system_migrate",
      itemId: c.req.param("id"),
    });
    return c.json({ ok: true });
  })
  .post("/sources/:id/test", async (c) => {
    const data = await testSource(c.get("ctx"), c.get("auth").tenantId!, c.req.param("id"));
    return c.json({ data });
  })
  .get("/sources/:id/tables", async (c) => {
    const data = await listSourceTables(
      c.get("ctx"),
      c.get("auth").tenantId!,
      c.req.param("id"),
    );
    return c.json({ data });
  })
  .post("/sources/:id/plan", async (c) => {
    const body = PlanInput.parse(await readJsonOr(c.req, {}));
    const data = await buildSourcePlan(
      c.get("ctx"),
      c.get("auth").tenantId!,
      c.req.param("id"),
      body.tables,
    );
    return c.json({ data });
  })
  // ── Runs ────────────────────────────────────────────────────────────────
  .get("/runs", async (c) => {
    const data = await listRuns(c.get("ctx"), c.get("auth").tenantId!);
    return c.json({ data });
  })
  .post("/runs", async (c) => {
    const body = RunInput.parse(await readJson(c.req));
    const auth = c.get("auth");
    const data = await startRun(c.get("ctx"), auth.tenantId!, {
      sourceId: body.sourceId,
      plan: body.plan,
      createdBy: auth.userId,
    });
    await logActivity(c, {
      action: "migrate.run.start",
      collection: "system_migrate",
      itemId: data.id as string,
      payload: { sourceId: body.sourceId },
    });
    return c.json({ data }, 201);
  })
  .get("/runs/:id", async (c) => {
    const data = await getRun(c.get("ctx"), c.get("auth").tenantId!, c.req.param("id"));
    return c.json({ data });
  })
  .post("/runs/:id/cancel", async (c) => {
    const data = await cancelRun(c.get("ctx"), c.get("auth").tenantId!, c.req.param("id"));
    await logActivity(c, {
      action: "migrate.run.cancel",
      collection: "system_migrate",
      itemId: c.req.param("id"),
    });
    return c.json({ data });
  })
  .post("/runs/:id/resume", async (c) => {
    const data = await resumeRun(c.get("ctx"), c.get("auth").tenantId!, c.req.param("id"));
    await logActivity(c, {
      action: "migrate.run.resume",
      collection: "system_migrate",
      itemId: c.req.param("id"),
    });
    return c.json({ data });
  })
  // ── Ingest (Phase 1 — the CLI pump's write path) ────────────────────────
  .post("/ingest/:slug", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const slug = c.req.param("slug");
    const body = IngestInput.parse(await readJson(c.req));
    const collection = await loadCollection(ctx, auth.tenantId, slug);
    const result = await ingestRows(ctx, collection, auth.tenantId!, body.rows, {
      mode: body.mode,
    });
    await logActivity(c, {
      action: "migrate.ingest",
      collection: slug,
      payload: { received: result.received, mode: body.mode },
      response: {
        inserted: result.inserted,
        skipped: result.skipped,
        updated: result.updated,
        failed: result.failed.length,
        total: result.total,
      },
    });
    return c.json({ data: result });
  });
