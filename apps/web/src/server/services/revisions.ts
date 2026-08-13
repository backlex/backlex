import { and, desc, eq, lt } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";
import { recordActivity } from "./activity";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.revisions : sqlite.schema.revisions;

export interface RevisionRow {
  id: string;
  tenantId: string | null;
  collection: string;
  itemId: string;
  parentRevisionId: string | null;
  snapshot: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date | number;
}

export const recordRevision = async (
  ctx: DbCtx,
  input: {
    collection: string;
    itemId: string;
    snapshot: Record<string, unknown>;
    userId: string | null;
    tenantId?: string | null;
  },
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  try {
    // "Latest" parent must also live in the same workspace — otherwise we
    // could chain a revision under another tenant's row when slugs collide
    // across workspaces.
    const latestWhere = input.tenantId
      ? and(
          eq(t.collection, input.collection),
          eq(t.itemId, input.itemId),
          eq(t.tenantId, input.tenantId),
        )
      : and(eq(t.collection, input.collection), eq(t.itemId, input.itemId));
    // Runs on every write. `revisions_item_created_idx` puts `created_at` on the
    // same key prefix this filters by, so it is an index-only backwards scan
    // rather than a sort over a per-item set that only ever grows.
    const latest = await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(latestWhere)
      .orderBy(desc(t.createdAt))
      .limit(1);
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId ?? null,
      collection: input.collection,
      itemId: input.itemId,
      parentRevisionId: latest[0]?.id ?? null,
      snapshot: input.snapshot,
      createdBy: input.userId,
    });
  } catch (e) {
    // The catch has to stay: this runs inside the `sideEffects` array of a write
    // that has ALREADY committed its row, so throwing would turn a successful
    // write into a 500. But swallowing it silently meant the per-row undo
    // history could stop being written and nothing would ever say so — which
    // matters more now that a pre-drop snapshot leans on revisions being there.
    console.error("[revisions] failed to record", e);
    try {
      await recordActivity(ctx as never, {
        userId: input.userId,
        tenantId: input.tenantId ?? null,
        action: "revision.failed",
        collection: input.collection,
        itemId: input.itemId,
        payload: { error: (e as Error).message?.slice(0, 500) ?? "unknown" },
      });
    } catch {
      /* the audit row is the fallback; there is no third place to report to */
    }
  }
};

/**
 * Delete revision rows past their retention window.
 *
 * `revisions` is the fastest-growing table backlex writes — a full-row JSON
 * snapshot on every update — and nothing pruned it before. The default is
 * deliberately long (180 days) because this is also the per-row undo path, and
 * a pruned revision is still recoverable from any backup taken before the prune:
 * `revisions` is inside `SYSTEM_TABLES_*`, so it rides along in every dump.
 *
 * Same signature and failure shape as `pruneOldSpans`: `0` disables, errors are
 * logged and reported rather than thrown.
 */
export const pruneOldRevisions = async (
  ctx: DbCtx,
  retentionDays: number,
): Promise<{ cutoff: Date; ok: boolean }> => {
  const days = Math.floor(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return { cutoff: new Date(0), ok: false };
  const t = tableFor(ctx.dialect);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    await (ctx.db as any).delete(t).where(lt(t.createdAt, cutoff));
    return { cutoff, ok: true };
  } catch (e) {
    console.error("[revisions] prune failed", e);
    return { cutoff, ok: false };
  }
};

export const listRevisions = async (
  ctx: DbCtx,
  collection: string,
  itemId: string,
  tenantId?: string | null,
): Promise<RevisionRow[]> => {
  const t = tableFor(ctx.dialect);
  const where = tenantId
    ? and(
        eq(t.collection, collection),
        eq(t.itemId, itemId),
        eq(t.tenantId, tenantId),
      )
    : and(eq(t.collection, collection), eq(t.itemId, itemId));
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.createdAt))) as RevisionRow[];
};

export const getRevision = async (
  ctx: DbCtx,
  id: string,
  tenantId?: string | null,
): Promise<RevisionRow | null> => {
  const t = tableFor(ctx.dialect);
  const where = tenantId
    ? and(eq(t.id, id), eq(t.tenantId, tenantId))
    : eq(t.id, id);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)
    .limit(1)) as RevisionRow[];
  return rows[0] ?? null;
};
