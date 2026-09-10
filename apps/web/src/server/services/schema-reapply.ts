/**
 * Bring an EXISTING workspace's physical tables forward to what the running
 * build expects.
 *
 * WHY THIS EXISTS
 *
 * `applyCollection` runs on create, patch, restore, provisioning and migrate.
 * Nothing re-applies at boot — so a workspace that upgrades keeps the physical
 * tables it had until somebody happens to edit a schema. Folded search was the
 * first feature to need this: every `text` column gains a `<name>__fold`
 * companion, and a workspace that already had its collections got none of them.
 *
 * The pass is safe by construction: additive and idempotent, it never drops or
 * rewrites a column, adopted tables are skipped because backlex never DDLs a
 * table it did not create, and inactive collections are skipped because the
 * workspace took them out of service.
 *
 * WHY IT ALSO RUNS ON A SCHEDULE
 *
 * #317 shipped the manual endpoint and left running it as a per-release chore.
 * That chore was demonstrably not done: of four live tenants, three could not
 * be swept at all (paused) and the fourth needed it and nobody had noticed.
 * Every feature that adds a column will owe the same sweep, and a follow-up
 * somebody has to remember silently does nothing when they do not.
 *
 * So `cronTick` runs it daily. Daily rather than "on upgrade" because there is
 * no upgrade EVENT inside the tenant runtime to hook — the control plane rolls
 * a Worker forward and the tenant simply starts running new code — and because
 * a schedule self-heals: a workspace paused through one release is swept when
 * it resumes, which is exactly the case the issue found. On a converged
 * workspace the pass reads each table's columns and writes nothing.
 */
import { eq } from "drizzle-orm";
import { applyCollection, type FieldDef } from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { invalidateTenantCollections } from "./collections-cache";

export interface ReapplyResult {
  applied: number;
  skipped: number;
  failed: { slug: string; error: string }[];
}

const collectionsTableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

interface DbCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

/**
 * Re-apply every managed collection in ONE workspace.
 *
 * Reports per collection rather than as a single count, because a workspace
 * with one unapplyable table must not read as a failed upgrade — and a table
 * that could not be applied must not be counted as done either.
 */
export const reapplyWorkspaceSchema = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<ReapplyResult> => {
  const t = collectionsTableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Record<string, unknown>[];

  let applied = 0;
  let skipped = 0;
  const failed: { slug: string; error: string }[] = [];
  for (const r of rows) {
    const slug = String(r.slug ?? "");
    // Adopted tables are somebody else's; an inactive collection is one the
    // workspace has taken out of service. Neither is ours to DDL.
    if (r.adopted === true || r.adopted === 1 || (r.status ?? "active") !== "active") {
      skipped += 1;
      continue;
    }
    try {
      await applyCollection(ctx.db as any, ctx.dialect, {
        table: String(r.physicalTable ?? r.physical_table ?? ""),
        fields: (r.fields ?? []) as FieldDef[],
        pkType: (r.pkType ?? r.pk_type ?? "uuid") as "uuid" | "text" | "integer",
        ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
        tenantScoped: (r.tenantScoped ?? r.tenant_scoped) !== false,
        versioned: Boolean(r.versioned),
        hasCreatedAt: (r.hasCreatedAt ?? r.has_created_at) !== false,
        hasUpdatedAt: (r.hasUpdatedAt ?? r.has_updated_at) !== false,
        softDelete: Boolean(r.softDelete ?? r.soft_delete),
        fts: Boolean(r.fts),
        adopted: false,
      });
      applied += 1;
    } catch (e) {
      // One unapplyable table must not cost the rest of the workspace its
      // upgrade — and it must not be silently counted as applied either.
      failed.push({ slug, error: (e as Error).message.slice(0, 200) });
    }
  }
  // The loader caches which companion columns a table has; a re-apply that
  // just added some would otherwise keep answering with the old set until the
  // entry expired.
  invalidateTenantCollections(tenantId);
  return { applied, skipped, failed };
};

/** Every workspace that owns at least one collection row. */
const workspaceIds = async (ctx: DbCtx): Promise<string[]> => {
  const t = collectionsTableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .selectDistinct({ tenantId: t.tenantId })
    .from(t)) as { tenantId: string | null }[];
  return rows.map((r) => r.tenantId).filter((id): id is string => Boolean(id));
};

/**
 * The scheduled sweep: every workspace on this deployment, once.
 *
 * FAILURES ARE ANNOUNCED, not counted. #317's own precondition was that "an
 * automatic sweep that leaves a permanently-failing collection behind turns a
 * number somebody reads into a line in a cron log nobody does" — so a workspace
 * with failures emits a structured WARN naming the workspace and every failing
 * slug, in the shape the plane firewall uses for a refusal. A silent tally
 * would be the same defect wearing the fix's name.
 *
 * One workspace's failure never stops the others: the per-workspace call
 * already catches per collection, and this catches around the workspace so a
 * dropped connection mid-sweep does not cost the rest of the deployment its
 * upgrade.
 */
export const reapplyAllWorkspaces = async (
  ctx: DbCtx,
): Promise<{ workspaces: number; applied: number; failed: number }> => {
  let workspaces = 0;
  let applied = 0;
  let failed = 0;
  for (const tenantId of await workspaceIds(ctx)) {
    workspaces += 1;
    try {
      const r = await reapplyWorkspaceSchema(ctx, tenantId);
      applied += r.applied;
      failed += r.failed.length;
      if (r.failed.length > 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "schema-reapply-failed",
            tenantId,
            applied: r.applied,
            failed: r.failed,
            detail:
              "these collections could not be brought forward and will fail identically on the next sweep — inspect them by hand. POST /api/admin/db/schema/reapply reports the same thing on demand.",
          }),
        );
      }
    } catch (e) {
      failed += 1;
      console.error(
        JSON.stringify({
          level: "error",
          msg: "schema-reapply-crashed",
          tenantId,
          error: (e as Error).message.slice(0, 200),
        }),
      );
    }
  }
  return { workspaces, applied, failed };
};
