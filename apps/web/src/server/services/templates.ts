import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import { getTemplate } from "../templates/catalog";
import { createManagedCollection } from "./collections";
import { ensureSystemRoles, type DbCtx } from "./seed";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

/** True when the workspace has no managed (non-adopted) collections yet — used
 *  to decide whether to auto-apply the cloud-selected SEED_TEMPLATE. */
export async function hasNoManagedCollections(ctx: DbCtx, tenantId: string): Promise<boolean> {
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as never as { select: Function })
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.adopted, false)))
    .limit(1);
  return rows.length === 0;
}

export interface ApplyTemplateResult {
  templateId: string;
  created: string[];
  skipped: string[];
}

/**
 * Seed a vertical template's collections into a workspace. Ensures system roles
 * exist, then creates each collection in dependency order (relation targets
 * first). Idempotent — collections that already exist are skipped, so a re-apply
 * or a partially-seeded workspace converges cleanly.
 */
export async function applyTemplate(
  ctx: DbCtx,
  tenantId: string,
  templateId: string,
): Promise<ApplyTemplateResult> {
  const template = getTemplate(templateId);
  if (!template) throw new AppError("VALIDATION", `Unknown template "${templateId}"`);

  await ensureSystemRoles(ctx, tenantId);

  const created: string[] = [];
  const skipped: string[] = [];
  for (const col of template.collections) {
    const res = await createManagedCollection(ctx, tenantId, col);
    (res.created ? created : skipped).push(res.slug);
  }
  return { templateId, created, skipped };
}
