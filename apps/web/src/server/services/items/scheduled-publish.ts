import { and, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../../context";
import { execute, nowFor, queryAll } from "./sql-helpers";
import { deserializeRow } from "./serialize";
import { publishEvent } from "../events";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

/**
 * Auto-publish scheduled items whose `_publish_at` has passed. Called from
 * `cronTick` with the already-built ctx (same zero-infra pattern as the job
 * queue + uploads sweep). Scans every active, versioned collection's physical
 * table for due drafts, flips them to `published`, and emits a realtime
 * `published` event per row.
 *
 * The `_publish_at <= now` comparison is dialect-agnostic: `nowFor` yields an
 * ISO string on pg (round-trips to `timestamptz`) and an epoch-ms number on
 * sqlite, matching how the column is written by the publish endpoint.
 */
export const publishDueItems = async (ctx: Ctx): Promise<void> => {
  const t = collectionsTable(ctx.dialect);
  const now = nowFor(ctx.dialect);
  const cols = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.versioned, true as any), eq(t.status, "active")))) as Record<string, unknown>[];

  for (const r of cols) {
    const table = (r.physicalTable ?? r.physical_table) as string | undefined;
    if (!table) continue;
    const slug = r.slug as string;
    const fields = (r.fields as FieldDef[]) ?? [];
    const ownerScoped = Boolean(r.ownerScoped ?? r.owner_scoped);

    const dueWhere = sql`${sql.identifier("_status")} = 'draft' AND ${sql.identifier("_publish_at")} IS NOT NULL AND ${sql.identifier("_publish_at")} <= ${now}`;
    let due: Record<string, unknown>[];
    try {
      due = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${sql.identifier(table)} WHERE ${dueWhere}`,
      );
    } catch (e) {
      // A versioned collection whose physical table predates `_publish_at`
      // (mid-migration) shouldn't abort the whole sweep.
      console.error(`[scheduled-publish] scan failed for ${slug}`, e);
      continue;
    }
    if (due.length === 0) continue;

    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("_status")} = 'published', ${sql.identifier("_published_at")} = ${now}, ${sql.identifier("_publish_at")} = NULL WHERE ${dueWhere}`,
    );

    for (const row of due) {
      // Reflect the post-publish state in the emitted event.
      row._status = "published";
      row._published_at = now;
      row._publish_at = null;
      const after = deserializeRow(row, fields, ctx.dialect, ownerScoped);
      const tenantId = (row.tenant_id ?? null) as string | null;
      try {
        await publishEvent(
          ctx.env,
          `items:${slug}`,
          { event: "published", data: after },
          { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId },
        );
      } catch (e) {
        console.error(`[scheduled-publish] event emit failed for ${slug}`, e);
      }
    }
  }
};
