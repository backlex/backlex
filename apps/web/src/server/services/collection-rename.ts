// Slug-rename cascade. Triggered from collections PATCH when the user
// changes a collection's slug (the physical table name is independent and
// is NOT renamed). Updates every place where the slug is stored as data:
//
//   - permissions.collection            (RBAC rules)
//   - revisions.collection              (snapshots)
//   - comments.collection               (item-level comments)
//   - activity.collection               (audit log)
//   - webhooks.events[]                 (`items:<slug>...` patterns)
//   - functions.pattern                 (`items:<slug>...` triggers)
//   - flows.operations[].collection     (item.{create,update,delete} steps)
//   - flows.trigger                     (`items:<slug>...` if event-triggered)
//   - collections.fields[].to           (relation fields targeting the slug)
//
// JSON columns are read, mutated in JS, and written back row-by-row so the
// transformation logic stays portable across PG and SQLite (neither dialect
// has a clean SQL way to deep-update arbitrary nested JSON in our
// drizzle-beta version).
//
// Returned counts feed the activity log so admins can see what moved.

import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Dialect } from "@backlex/db";

export interface RenameCounts {
  permissions: number;
  revisions: number;
  comments: number;
  activity: number;
  webhooks: number;
  functions: number;
  flows: number;
  relations: number;
}

const t = (dialect: Dialect) => (dialect === "pg" ? pg.schema : sqlite.schema);

/** Replace `items:<oldSlug>(:...)?` patterns with the new slug. Patterns that
 *  don't reference the slug pass through untouched. */
const renamePattern = (
  pattern: string,
  oldSlug: string,
  newSlug: string,
): string => {
  const parts = pattern.split(":");
  if (parts[0] === "items" && parts[1] === oldSlug) {
    parts[1] = newSlug;
    return parts.join(":");
  }
  return pattern;
};

const renameOperations = (
  ops: unknown,
  oldSlug: string,
  newSlug: string,
): { changed: boolean; next: unknown } => {
  if (!Array.isArray(ops)) return { changed: false, next: ops };
  let changed = false;
  const next = ops.map((step) => {
    if (!step || typeof step !== "object") return step;
    const s = step as Record<string, unknown>;
    // Step shapes: { type: 'item.create'|'item.update'|'item.delete',
    //                collection: string, ... }
    if (typeof s.collection === "string" && s.collection === oldSlug) {
      changed = true;
      return { ...s, collection: newSlug };
    }
    return step;
  });
  return { changed, next };
};

/**
 * Performs the cascade. Runs each table sequentially (no nested transaction
 * — drizzle-beta on D1 doesn't expose a unified `db.transaction` for our
 * union). Each step is idempotent: re-running with the same args is a no-op.
 */
export const cascadeSlugRename = async (
  db: any,
  dialect: Dialect,
  tenantId: string,
  oldSlug: string,
  newSlug: string,
): Promise<RenameCounts> => {
  const s = t(dialect);
  const counts: RenameCounts = {
    permissions: 0,
    revisions: 0,
    comments: 0,
    activity: 0,
    webhooks: 0,
    functions: 0,
    flows: 0,
    relations: 0,
  };

  // 1) permissions: no tenant column, scoped via role. A role only ever
  //    belongs to one tenant in our setup, but to keep this defensive and
  //    not bleed across tenants, scope the update via the role join.
  const permRows = await db
    .select({ id: s.permissions.id, roleId: s.permissions.roleId })
    .from(s.permissions)
    .where(eq(s.permissions.collection, oldSlug));
  for (const p of permRows) {
    // role tenant-scoping: only update if this role is reachable by the
    // requesting tenant. Roles table doesn't carry tenant_id either in this
    // build — system-roles cross tenants. So we update unconditionally.
    await db.update(s.permissions).set({ collection: newSlug }).where(eq(s.permissions.id, p.id));
    counts.permissions++;
  }

  // 2) revisions
  const revRows = await db
    .select({ id: s.revisions.id })
    .from(s.revisions)
    .where(and(eq(s.revisions.tenantId, tenantId), eq(s.revisions.collection, oldSlug)));
  for (const r of revRows) {
    await db.update(s.revisions).set({ collection: newSlug }).where(eq(s.revisions.id, r.id));
    counts.revisions++;
  }

  // 3) comments
  const cmtRows = await db
    .select({ id: s.comments.id })
    .from(s.comments)
    .where(and(eq(s.comments.tenantId, tenantId), eq(s.comments.collection, oldSlug)));
  for (const c of cmtRows) {
    await db.update(s.comments).set({ collection: newSlug }).where(eq(s.comments.id, c.id));
    counts.comments++;
  }

  // 4) activity (audit) — preserves history under the new slug so log
  //    queries filtered by the active slug stay accurate.
  const actRows = await db
    .select({ id: s.activity.id })
    .from(s.activity)
    .where(and(eq(s.activity.tenantId, tenantId), eq(s.activity.collection, oldSlug)));
  for (const a of actRows) {
    await db.update(s.activity).set({ collection: newSlug }).where(eq(s.activity.id, a.id));
    counts.activity++;
  }

  // 5) webhooks.events[] — string array of patterns
  const hooks = await db
    .select({ id: s.webhooks.id, events: s.webhooks.events })
    .from(s.webhooks)
    .where(eq(s.webhooks.tenantId, tenantId));
  for (const h of hooks) {
    const events = (h.events as string[]) ?? [];
    let changed = false;
    const next = events.map((p) => {
      const renamed = renamePattern(p, oldSlug, newSlug);
      if (renamed !== p) changed = true;
      return renamed;
    });
    if (changed) {
      await db.update(s.webhooks).set({ events: next }).where(eq(s.webhooks.id, h.id));
      counts.webhooks++;
    }
  }

  // 6) functions.pattern — single string pattern
  const fns = await db
    .select({ id: s.functions.id, pattern: s.functions.pattern })
    .from(s.functions)
    .where(eq(s.functions.tenantId, tenantId));
  for (const fn of fns) {
    if (typeof fn.pattern !== "string") continue;
    const renamed = renamePattern(fn.pattern, oldSlug, newSlug);
    if (renamed !== fn.pattern) {
      await db.update(s.functions).set({ pattern: renamed }).where(eq(s.functions.id, fn.id));
      counts.functions++;
    }
  }

  // 7) flows: operations[].collection + trigger pattern
  const flowsRows = await db
    .select({
      id: s.flows.id,
      operations: s.flows.operations,
      trigger: s.flows.trigger,
    })
    .from(s.flows)
    .where(eq(s.flows.tenantId, tenantId));
  for (const f of flowsRows) {
    const opsResult = renameOperations(f.operations, oldSlug, newSlug);
    const newTrigger = typeof f.trigger === "string"
      ? renamePattern(f.trigger, oldSlug, newSlug)
      : f.trigger;
    const triggerChanged = newTrigger !== f.trigger;
    if (opsResult.changed || triggerChanged) {
      await db
        .update(s.flows)
        .set({
          ...(opsResult.changed ? { operations: opsResult.next } : {}),
          ...(triggerChanged ? { trigger: newTrigger } : {}),
        })
        .where(eq(s.flows.id, f.id));
      counts.flows++;
    }
  }

  // 8) relation fields on other collections: `fields[].to` stores the target
  //    slug as data, so without this rewrite every relation pointing at the
  //    renamed collection keeps a dead slug and expansion/lookups go blind.
  //    Counted per collection row touched (includes self-relations).
  const colRows = await db
    .select({ id: s.collections.id, fields: s.collections.fields })
    .from(s.collections)
    .where(eq(s.collections.tenantId, tenantId));
  for (const col of colRows) {
    const fields = Array.isArray(col.fields) ? (col.fields as unknown[]) : [];
    let changed = false;
    const next = fields.map((field) => {
      if (!field || typeof field !== "object") return field;
      const f = field as Record<string, unknown>;
      if (f.type === "relation" && f.to === oldSlug) {
        changed = true;
        return { ...f, to: newSlug };
      }
      return field;
    });
    if (changed) {
      await db.update(s.collections).set({ fields: next }).where(eq(s.collections.id, col.id));
      counts.relations++;
    }
  }

  // 9) template seed manifest (`templateSampleSeeds` app_settings): keyed by
  //    slug, so a rename must move the key or clear-samples silently orphans
  //    the seeded rows. Not counted — internal bookkeeping, not user data.
  const manifestRows = await db
    .select({ id: s.appSettings.id, value: s.appSettings.value })
    .from(s.appSettings)
    .where(
      and(eq(s.appSettings.tenantId, tenantId), eq(s.appSettings.key, "templateSampleSeeds")),
    );
  const manifestRow = manifestRows[0];
  const manifest = manifestRow?.value;
  if (
    manifestRow &&
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    Object.hasOwn(manifest, oldSlug)
  ) {
    const next = { ...(manifest as Record<string, unknown>) };
    const ids = next[oldSlug];
    delete next[oldSlug];
    // A (rare) existing entry under the new slug merges rather than clobbers.
    const existing = Array.isArray(next[newSlug]) ? (next[newSlug] as unknown[]) : [];
    next[newSlug] = [...existing, ...(Array.isArray(ids) ? ids : [])];
    await db
      .update(s.appSettings)
      .set({ value: next, updatedAt: dialect === "pg" ? new Date() : Date.now() })
      .where(eq(s.appSettings.id, manifestRow.id));
  }

  return counts;
};
