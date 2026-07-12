import { and, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { FieldDef } from "@backlex/db";
import { AppError } from "@backlex/core";
import { assignAppUserRoleByName, type DbCtx } from "./seed";
import { invalidateUserRoles } from "./permissions-cache";
import { nowFor } from "./items-helpers";

/**
 * Portal links — per-workspace auto-link rules between "person" collections
 * (employees, members, students, …) and the workspace end-user pool
 * (`app_users`). Stored in `app_settings` under {@link PORTAL_LINKS_KEY} as
 *
 *   [{ collection, emailField, userField: "app_user_id", role }, …]
 *
 * Two consumers:
 *   - the template engine merges an entry per person collection that declares
 *     a `portalLink` (idempotent per collection);
 *   - the app-plane user-creation paths (better-auth email/social signup and
 *     SAML/LDAP provisioning) call {@link autoLinkAppUser} so a signup whose
 *     email matches an unlinked person row gets `app_user_id` stamped and the
 *     named self-service role assigned — no admin step needed.
 */

export const PORTAL_LINKS_KEY = "portalLinks";

export interface PortalLink {
  /** Person collection slug (e.g. `employees`). */
  collection: string;
  /** Field on the person row holding the email to match (e.g. `work_email`). */
  emailField: string;
  /** Field that receives the `app_users.id` — always `app_user_id` today. */
  userField: "app_user_id";
  /** Role (by name) auto-assigned on link; skipped when it doesn't exist. */
  role: string;
}

const settingsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

/* Raw-SQL helpers (same shape as services/templates.ts — the person rows live
 * in per-collection physical tables, not in Drizzle-typed schema). */
const exec = async (ctx: DbCtx, query: unknown): Promise<void> => {
  if (ctx.dialect === "pg") {
    await (ctx.db as never as { execute: Function }).execute(query);
  } else {
    await (ctx.db as never as { run: Function }).run(query);
  }
};

const queryRows = async (
  ctx: DbCtx,
  query: unknown,
): Promise<Record<string, unknown>[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as never as { execute: Function }).execute(query);
    if (Array.isArray(r)) return r as Record<string, unknown>[];
    if (r && typeof r === "object" && "rows" in (r as object))
      return (r as { rows: Record<string, unknown>[] }).rows;
    return r as Record<string, unknown>[];
  }
  return (await (ctx.db as never as { all: Function }).all(query)) as Record<
    string,
    unknown
  >[];
};

const readSetting = async (ctx: DbCtx, tenantId: string, key: string): Promise<unknown> => {
  const st = settingsTable(ctx.dialect);
  const rows = (await (ctx.db as never as { select: Function })
    .select({ value: st.value })
    .from(st)
    .where(and(eq(st.tenantId, tenantId), eq(st.key, key)))
    .limit(1)) as { value: unknown }[];
  return rows[0]?.value;
};

const writeSetting = async (
  ctx: DbCtx,
  tenantId: string,
  key: string,
  value: unknown,
): Promise<void> => {
  const st = settingsTable(ctx.dialect);
  await (ctx.db as never as { insert: Function })
    .insert(st)
    .values({ id: crypto.randomUUID(), tenantId, key, value })
    .onConflictDoUpdate({
      target: [st.tenantId, st.key],
      set: { value, updatedAt: nowFor(ctx.dialect) },
    });
};

const isPortalLink = (v: unknown): v is PortalLink =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as PortalLink).collection === "string" &&
  (v as PortalLink).collection.length > 0 &&
  typeof (v as PortalLink).emailField === "string" &&
  (v as PortalLink).emailField.length > 0 &&
  typeof (v as PortalLink).role === "string" &&
  (v as PortalLink).role.length > 0;

/** The workspace's stored portal-link rules (malformed entries dropped). */
export const readPortalLinks = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<PortalLink[]> => {
  const raw = await readSetting(ctx, tenantId, PORTAL_LINKS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPortalLink).map((l) => ({ ...l, userField: "app_user_id" as const }));
};

/** Append a rule unless one already exists for the same collection — the
 *  admin may have edited theirs, so a re-apply never overwrites. Returns
 *  `true` when the rule was added. */
export const mergePortalLink = async (
  ctx: DbCtx,
  tenantId: string,
  link: PortalLink,
): Promise<boolean> => {
  const current = await readPortalLinks(ctx, tenantId);
  if (current.some((l) => l.collection === link.collection)) return false;
  await writeSetting(ctx, tenantId, PORTAL_LINKS_KEY, [...current, link]);
  return true;
};

interface CollectionRow {
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  softDelete: boolean | number;
}

const resolveCollection = async (
  ctx: DbCtx,
  tenantId: string,
  slug: string,
): Promise<CollectionRow | null> => {
  const t = collectionsTable(ctx.dialect);
  const rows = (await (ctx.db as never as { select: Function })
    .select({
      slug: t.slug,
      physicalTable: t.physicalTable,
      fields: t.fields,
      softDelete: t.softDelete,
    })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug), eq(t.status, "active")))
    .limit(1)) as CollectionRow[];
  return rows[0] ?? null;
};

const hasField = (col: CollectionRow, name: string): boolean =>
  (col.fields ?? []).some((f) => f.name === name);

/**
 * Point a person row's `app_user_id` at an end-user. Validates that the
 * collection exists, carries the link field, and that the row is real —
 * throws `AppError` on any of those so the admin invite flow surfaces a
 * clear error instead of silently not linking.
 */
export const linkPersonRow = async (
  ctx: DbCtx,
  tenantId: string,
  collectionSlug: string,
  itemId: string,
  appUserId: string,
): Promise<void> => {
  const col = await resolveCollection(ctx, tenantId, collectionSlug);
  if (!col) throw new AppError("VALIDATION", `Unknown collection "${collectionSlug}"`);
  if (!hasField(col, "app_user_id")) {
    throw new AppError(
      "VALIDATION",
      `Collection "${collectionSlug}" has no app_user_id field to link against`,
    );
  }
  const existing = await queryRows(
    ctx,
    sql`SELECT ${sql.identifier("id")} AS id FROM ${sql.identifier(col.physicalTable)} WHERE ${sql.identifier("id")} = ${itemId} AND ${sql.identifier("tenant_id")} = ${tenantId} LIMIT 1`,
  );
  if (!existing[0]) {
    throw new AppError("NOT_FOUND", `No "${collectionSlug}" row with id ${itemId}`);
  }
  await exec(
    ctx,
    sql`UPDATE ${sql.identifier(col.physicalTable)} SET ${sql.identifier("app_user_id")} = ${appUserId}, ${sql.identifier("updated_at")} = ${nowFor(ctx.dialect)} WHERE ${sql.identifier("id")} = ${itemId}`,
  );
};

/**
 * Auto-link a freshly-created app-plane user to matching person rows.
 *
 * For each stored portal-link rule: find the FIRST row in `collection` whose
 * `emailField` equals the new user's email (case-insensitive) and whose
 * `app_user_id` is still empty → stamp it with the user id and assign the
 * rule's role (resolved by name; silently skipped when missing).
 *
 * Best-effort by contract: every failure is logged and swallowed — this runs
 * inside sign-up / SSO-provisioning hooks and must NEVER block or fail the
 * sign-up itself.
 */
export const autoLinkAppUser = async (
  ctx: DbCtx,
  tenantId: string,
  user: { id: string; email: string },
): Promise<void> => {
  try {
    const email = user.email.trim().toLowerCase();
    if (!email) return;
    const links = await readPortalLinks(ctx, tenantId);
    for (const link of links) {
      try {
        const col = await resolveCollection(ctx, tenantId, link.collection);
        if (!col) continue;
        const userField = link.userField || "app_user_id";
        if (!hasField(col, link.emailField) || !hasField(col, userField)) continue;
        const softDeleteGuard = col.softDelete
          ? sql` AND ${sql.identifier("deleted_at")} IS NULL`
          : sql``;
        // One person row per rule: first (oldest) unlinked match wins.
        const rows = await queryRows(
          ctx,
          sql`SELECT ${sql.identifier("id")} AS id FROM ${sql.identifier(col.physicalTable)} WHERE ${sql.identifier("tenant_id")} = ${tenantId} AND lower(${sql.identifier(link.emailField)}) = ${email} AND (${sql.identifier(userField)} IS NULL OR ${sql.identifier(userField)} = ${""})${softDeleteGuard} ORDER BY ${sql.identifier("created_at")} ASC LIMIT 1`,
        );
        const rowId = rows[0]?.id;
        if (rowId == null) continue;
        await exec(
          ctx,
          sql`UPDATE ${sql.identifier(col.physicalTable)} SET ${sql.identifier(userField)} = ${user.id}, ${sql.identifier("updated_at")} = ${nowFor(ctx.dialect)} WHERE ${sql.identifier("id")} = ${String(rowId)}`,
        );
        // Role by NAME — assignAppUserRoleByName no-ops when the role is gone.
        await assignAppUserRoleByName(ctx, tenantId, user.id, link.role);
        invalidateUserRoles(tenantId, user.id);
      } catch (e) {
        console.error(
          `[portal-links] auto-link failed for "${link.collection}":`,
          (e as Error).message,
        );
      }
    }
  } catch (e) {
    console.error("[portal-links] auto-link skipped:", (e as Error).message);
  }
};
