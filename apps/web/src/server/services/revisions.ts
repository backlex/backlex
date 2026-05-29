import { and, desc, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";

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
    console.error("[revisions] failed to record", e);
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
