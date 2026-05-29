import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";

export const filesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.files : sqlite.schema.files;

export const foldersTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.folders : sqlite.schema.folders;

/**
 * Look up the folder whose name matches `name` for this tenant; create one
 * if it doesn't exist. Migration-friendly: lets an upload at
 * `photos/2024/spring/beach.jpg` auto-organize into a folder named
 * `photos/2024/spring` without the client pre-creating it.
 *
 * Uniqueness on `(tenant_id, name)` isn't enforced at the DB level yet, so
 * two parallel uploads racing on the same path may briefly insert dupes —
 * acceptable v1 trade-off; both rows still resolve to a valid folder.
 */
export async function findOrCreateFolderByName(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  name: string,
  ownerId: string | null,
): Promise<string> {
  const t = foldersTable(ctx.dialect);
  const existing = (await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.name, name)))
    .limit(1)) as { id: string }[];
  if (existing[0]) return existing[0].id;
  const id = crypto.randomUUID();
  await (ctx.db as any).insert(t).values({
    id,
    name,
    parentId: null,
    ownerId,
    tenantId,
  });
  return id;
}

/** Derive a folder-name path from a logical key. Returns null for files at
 *  the root (no "/" before the file name). */
export function folderNameFromKey(logicalKey: string): string | null {
  const lastSlash = logicalKey.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return logicalKey.slice(0, lastSlash);
}
