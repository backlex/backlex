import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { validateValue, type FieldDef } from "@backlex/db";
import type { Ctx } from "../../context";
import { loadCollection, type CollectionRow } from "./collection-loader";
import { queryAll } from "./sql-helpers";

export const validateBody = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  partial: boolean,
  fieldAllow: Set<string> | null,
): void => {
  for (const f of fields) {
    if (f.computed) continue; // never required from the caller
    if (f.required && !partial && (data[f.name] === undefined || data[f.name] === null)) {
      throw new AppError("VALIDATION", `Field "${f.name}" is required`);
    }
  }
  for (const k of Object.keys(data)) {
    const def = fields.find((f) => f.name === k);
    if (!def) {
      throw new AppError("VALIDATION", `Unknown field "${k}"`);
    }
    if (def.computed) {
      throw new AppError(
        "VALIDATION",
        `Field "${k}" is computed (read-only) — drop it from your payload`,
      );
    }
    if (fieldAllow && !fieldAllow.has(k)) {
      throw new AppError("FORBIDDEN", `No permission to write field "${k}"`);
    }
    try {
      validateValue(def, data[k]);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
  }
};

/**
 * Verify that every `relation` / `relation_many` value in the payload points
 * at a real row in the target collection. Empty string and null are
 * skipped (treated as "no relation"); a missing target id throws 422.
 *
 * Batches by target slug so a payload with N `customer_id` references
 * costs one SELECT per target collection, not one per id.
 *
 * Loading the target collection through `loadCollection` keeps the lookup
 * tenant-scoped — a value pointing at a collection in another workspace
 * fails with the same "not found" wording.
 */
export const validateRelations = async (
  data: Record<string, unknown>,
  fields: FieldDef[],
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<void> => {
  const checks = new Map<string, Set<string>>();
  for (const f of fields) {
    if (f.type !== "relation" && f.type !== "relation_many") continue;
    if (!f.to) continue;
    const val = data[f.name];
    if (val === undefined || val === null || val === "") continue;
    let ids: string[] = [];
    if (f.type === "relation_many") {
      if (Array.isArray(val)) {
        ids = val
          .map((x) => (typeof x === "string" ? x : String(x ?? "")))
          .filter((x) => x !== "");
      }
    } else if (typeof val === "string") {
      ids = [val];
    }
    if (ids.length === 0) continue;
    const set = checks.get(f.to) ?? new Set<string>();
    for (const id of ids) set.add(id);
    checks.set(f.to, set);
  }
  if (checks.size === 0) return;
  for (const [slug, idSet] of checks) {
    let target: CollectionRow;
    try {
      target = await loadCollection(ctx, tenantId, slug);
    } catch {
      throw new AppError(
        "VALIDATION",
        `Relation target collection "${slug}" not found in this workspace`,
      );
    }
    const ids = [...idSet];
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${sql.identifier(target.pkColumn)} AS ${sql.identifier("__rel_id")}
          FROM ${sql.identifier(target.physicalTable)}
          WHERE ${sql.identifier(target.pkColumn)} IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    const found = new Set(rows.map((r) => String(r["__rel_id"] ?? "")));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      const sample = missing.slice(0, 3).join(", ");
      const suffix = missing.length > 3 ? ` (…and ${missing.length - 3} more)` : "";
      throw new AppError(
        "VALIDATION",
        `Relation target "${slug}" has no row(s) with id: ${sample}${suffix}`,
      );
    }
  }
};
