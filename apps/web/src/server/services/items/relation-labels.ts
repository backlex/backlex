import { and, eq, sql } from "drizzle-orm";
import type { AuthSubject } from "@backlex/core";
import { rowLabel } from "@backlex/core/row-label";
import type { Ctx } from "../../context";
import { resolvePermission } from "../permissions";
import { collectionsTable, loadCollection } from "./collection-loader";
import { readableIds } from "./row-access";
import { deserialize } from "./serialize";
import {
  fromOf,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "./sql-helpers";

/**
 * Human labels for the ids a `relation` column holds — `{ id → "News" }` — as
 * THIS caller is allowed to see them.
 *
 * An aggregate grouped by a relation groups by the stored foreign id, so its
 * labels are UUIDs; a KPI ranking read `ca5c194f-… · 1` where it meant
 * "News · 1". The label chain is the admin's own (`@backlex/core/row-label`:
 * display template → title-ish field → composed text → short id), so a
 * category reads the same here as it does in the relation picker.
 *
 * Permission is the target's, not the source's. Being allowed to count posts
 * says nothing about reading categories, so an id is only labelled when the
 * caller could have fetched that category row, and only from fields their
 * grant lets them read. Anything else is simply left out of the map — the
 * caller keeps the id, which is exactly what they could already see.
 *
 * Returns an empty map when `field` is not a single relation, its target is
 * gone, or there is nothing to label.
 */
export const relationLabels = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  collection: string,
  field: string,
  ids: readonly string[],
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
  if (wanted.length === 0) return out;

  let target;
  try {
    const source = await loadCollection(ctx, tenantId, collection);
    const def = source.fields.find((f) => f.name === field);
    if (def?.type !== "relation" || !def.to) return out;
    target = await loadCollection(ctx, tenantId, def.to);
  } catch {
    // An archived or deleted target is not an error worth failing the figure
    // over — the ranking is still right, it just keeps its ids.
    return out;
  }

  const subject = { ...auth, tenantId };
  const perm = await resolvePermission(ctx, subject, target.slug, "read");
  if (!perm.allowed) return out;
  const visible = [...(await readableIds(ctx, subject, target, perm, wanted))];
  if (visible.length === 0) return out;

  // Visibility was settled above, so this read only needs the rows — but still
  // inside the workspace: an adopted table's keys need not be unique across
  // tenants. Qualified the way `readableIds` qualifies them, for the same join.
  const joined = usesOwnershipSideTable(target);
  const tbl = sql.identifier(target.physicalTable);
  const pkRef = joined
    ? sql`${tbl}.${sql.identifier(target.pkColumn)}`
    : sql.identifier(target.pkColumn);
  const tenantWhere =
    joined && target.tenantScoped
      ? sql`${tbl}.${sql.identifier("tenant_id")} = ${tenantId}`
      : tenantFilter(target, subject);
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(target)} FROM ${fromOf(target)} ${whereOf(
      sql`${pkRef} IN (${sql.join(
        visible.map((id) => sql`${id}`),
        sql`, `,
      )})`,
      tenantWhere,
    )}`,
  );

  const t = collectionsTable(ctx.dialect);
  const meta = await (ctx.db as any)
    .select({ displayTemplate: t.displayTemplate })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, target.slug)))
    .limit(1);
  const displayTemplate = (meta[0]?.displayTemplate as string | null | undefined) ?? null;

  const readable = target.fields.filter((f) => !perm.fields || perm.fields.has(f.name));
  for (const raw of rows) {
    const id = String(raw[target.pkColumn] ?? raw.id ?? "");
    if (!id) continue;
    // Only the fields this caller may read reach the template — a label must
    // not become a way to read a column the grant withholds.
    const row: Record<string, unknown> = { id };
    for (const f of readable) row[f.name] = deserialize(raw[f.name], f.type, ctx.dialect);
    out.set(id, rowLabel(row, { displayTemplate, fields: readable }));
  }
  return out;
};
