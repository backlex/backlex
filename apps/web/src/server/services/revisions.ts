import { and, desc, eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.revisions : sqlite.schema.revisions;

export interface RevisionRow {
  id: string;
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
  },
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  try {
    const latest = await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.collection, input.collection), eq(t.itemId, input.itemId)))
      .orderBy(desc(t.createdAt))
      .limit(1);
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
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
): Promise<RevisionRow[]> => {
  const t = tableFor(ctx.dialect);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.collection, collection), eq(t.itemId, itemId)))
    .orderBy(desc(t.createdAt))) as RevisionRow[];
};

export const getRevision = async (
  ctx: DbCtx,
  id: string,
): Promise<RevisionRow | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as RevisionRow[];
  return rows[0] ?? null;
};
