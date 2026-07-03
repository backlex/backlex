import { sql } from "drizzle-orm";
import { AppError, type AuthSubject } from "@backlex/core";
import { matchesCondition, validateValue, type FieldDef } from "@backlex/db";
import type { Ctx } from "../../context";
import { loadCollection, type CollectionRow } from "./collection-loader";
import { queryAll } from "./sql-helpers";

/** Treat undefined / null / "" as "no value" for a conditional-required check. */
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "";

/**
 * Enforce the server-side effects of per-field {@link FieldCondition}s against a
 * fully-resolved row (create: the proposed body; update: the merged before+patch
 * row). Today that's the `required` effect: when a condition's `rule` matches the
 * row and the field is empty, reject with 422. `readonly` / `hidden` are UI-only
 * and intentionally not gated here. `$user.*` in a rule resolves via `subject`.
 */
export const enforceFieldConditions = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  subject: AuthSubject,
): void => {
  for (const f of fields) {
    if (!f.conditions?.length) continue;
    for (const cond of f.conditions) {
      if (!cond.required) continue;
      if (matchesCondition(row, cond.rule, subject) && isEmpty(row[f.name])) {
        const why = cond.name ? ` (${cond.name})` : "";
        throw new AppError(
          "VALIDATION",
          `Field "${f.name}" is required when its condition matches${why}`,
        );
      }
    }
  }
};

/**
 * Enforce per-field cross-field `validation.rule`s against a fully-resolved row
 * (create: the proposed body; update: the merged before+patch row). A rule is a
 * filter over the whole row — the row is valid only when it matches. Sibling
 * values are referenced with `"$field.<name>"` on the comparison side, e.g.
 * `{ end_date: { _gte: "$field.start_date" } }`. On failure we throw the field's
 * `validation.message` when set, else a generated message. `$user.*` resolves
 * via `subject`. Per-value checks live in `validateValue`; this handles only the
 * rules that need to see other fields.
 */
export const enforceValidationRules = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  subject: AuthSubject,
): void => {
  for (const f of fields) {
    const rule = f.validation?.rule;
    if (!rule) continue;
    if (!matchesCondition(row, rule, subject)) {
      throw new AppError(
        "VALIDATION",
        f.validation?.message ?? `Field "${f.name}" failed its validation rule`,
      );
    }
  }
};

export const validateBody = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  partial: boolean,
  fieldAllow: Set<string> | null,
): void => {
  for (const f of fields) {
    // Computed + auto-filled columns are system-managed — never required from,
    // nor writable by, the caller.
    if (f.computed || f.onCreate || f.onUpdate) continue;
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
    if (def.onCreate || def.onUpdate) {
      throw new AppError(
        "VALIDATION",
        `Field "${k}" is auto-filled (read-only) — drop it from your payload`,
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
