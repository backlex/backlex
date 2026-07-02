/**
 * External-DB migration endpoints. Phase 1 ships the ingest half — the
 * introspection/plan half runs client-side in `backlex import-db` (the CLI
 * connects to the *source* database, which is usually firewalled away from
 * this server; see docs/migrating-in.md).
 *
 *   - `POST /ingest/:slug` — bulk, PK-preserving, idempotent row copy into a
 *     managed collection. Side-effect-free by design (no per-row events /
 *     revisions / FTS / vectors); see services/migrate-ingest.ts.
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

const IngestInput = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(INGEST_MAX_ROWS),
});

export const migrateRoutes = new Hono<AppBindings>()
  .use("*", requireUser, requirePlatformMw, requireAdminMw, async (c, next) => {
    if (!c.get("auth")?.tenantId) {
      throw new AppError("VALIDATION", "Active workspace required for migration");
    }
    await next();
  })
  .post("/ingest/:slug", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const slug = c.req.param("slug");
    const body = IngestInput.parse(await c.req.json());
    const collection = await loadCollection(ctx, auth.tenantId, slug);
    const result = await ingestRows(ctx, collection, auth.tenantId!, body.rows);
    await logActivity(c, {
      action: "migrate.ingest",
      collection: slug,
      payload: { received: result.received },
      response: {
        inserted: result.inserted,
        skipped: result.skipped,
        failed: result.failed.length,
        total: result.total,
      },
    });
    return c.json({ data: result });
  });
