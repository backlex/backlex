import { sql } from "drizzle-orm";
import { AppError, type AuthSubject } from "@backlex/core";
import {
  findRetireField,
  isLocalized,
  isRetiredValue,
  matchesCondition,
  rangeOrderError,
  type RetireSpec,
  validateValue,
  type FieldDef,
} from "@backlex/db";
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
  // A declared period must be ordered. Enforced here rather than as a
  // `validation.rule` the admin hand-writes, because it is the same rule every
  // time and most of the twenty-eight template pairs never carried one — the
  // point of declaring a range is not having to restate what a period is.
  //
  // Runs against the same fully-merged proposed row the cross-field rules do,
  // which is what makes it correct on a patch that sets only one endpoint.
  for (const f of fields) {
    if (!f.range) continue;
    const problem = rangeOrderError(f.name, f.range, row);
    if (problem) throw new AppError("VALIDATION", problem);
  }
  for (const f of fields) {
    const rule = f.validation?.rule;
    if (!rule) continue;
    // Advisory rules don't block — see collectFieldWarnings.
    if (f.validation?.severity && f.validation.severity !== "error") continue;
    if (!matchesCondition(row, rule, subject)) {
      throw new AppError(
        "VALIDATION",
        f.validation?.message ?? `Field "${f.name}" failed its validation rule`,
      );
    }
  }
};

export interface FieldWarning {
  field: string;
  severity: "warning" | "info";
  message: string;
}

/**
 * Gather advisory (warning/info) validation failures for a fully-resolved row.
 * Reuses the exact per-value ({@link validateValue}) and cross-field
 * (`validation.rule`) checks by forcing them to run, catching the throw, and
 * recording the message instead of rejecting. The write path attaches the
 * result to the response so a client can surface soft hints without blocking.
 */
export const collectFieldWarnings = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  subject: AuthSubject,
): FieldWarning[] => {
  const warnings: FieldWarning[] = [];
  for (const f of fields) {
    const sev = f.validation?.severity;
    if (sev !== "warning" && sev !== "info") continue;
    // Per-value checks: run them as if they were errors, then downgrade.
    const forced = { ...f, validation: { ...f.validation, severity: "error" as const } };
    try {
      validateValue(forced, row[f.name]);
    } catch (e) {
      warnings.push({ field: f.name, severity: sev, message: (e as Error).message });
      continue; // one hint per field is enough
    }
    const rule = f.validation?.rule;
    if (rule && !matchesCondition(row, rule, subject)) {
      warnings.push({
        field: f.name,
        severity: sev,
        message: f.validation?.message ?? `Field "${f.name}" failed its validation rule`,
      });
    }
  }
  return warnings;
};

export const validateBody = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  partial: boolean,
  fieldAllow: Set<string> | null,
): void => {
  for (const f of fields) {
    // Computed + auto-filled columns are system-managed — never required from,
    // nor writable by, the caller. `localized` fields are pulled out into the
    // sidecar split before this runs (and are validated per-locale there); v1
    // does not enforce `required` per-locale, so skip them here too.
    if (f.computed || f.rollup || f.sequence || f.onCreate || f.onUpdate || isLocalized(f)) {
      continue;
    }
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
    if (def.rollup) {
      throw new AppError(
        "VALIDATION",
        `Field "${k}" is a rollup of "${def.rollup.from}" (read-only) — change the ${def.rollup.from} rows instead`,
      );
    }
    if (def.sequence) {
      // Rejected on update as well as create, and that is the point: a document
      // number the holder can edit after the fact is not a document number.
      // Refusing the write is also what keeps the counter honest — an edited
      // value would collide with one the counter is still going to issue.
      throw new AppError(
        "VALIDATION",
        `Field "${k}" is a sequence (server-issued, read-only) — drop it from your payload`,
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
 * at a real row in the target collection — and, when that collection declares a
 * retirement flag, at one that is still in play. Empty string and null are
 * skipped (treated as "no relation"); a missing target id throws 422, and so
 * does a retired one unless the target's flag says `references: "allow"`.
 *
 * Batches by target slug so a payload with N `customer_id` references
 * costs one SELECT per target collection, not one per id.
 *
 * Loading the target collection through `loadCollection` keeps the lookup
 * tenant-scoped — a value pointing at a collection in another workspace
 * fails with the same "not found" wording.
 *
 * **Only values the write NAMES are judged.** This function has always read
 * `data`, so a PATCH that does not mention a relation leaves it alone and no
 * stored reference is ever re-validated. That is what makes the refusal safe:
 * retiring a product does not invalidate a single past order, it only stops the
 * next one from being written against it.
 *
 * There is deliberately **no per-write escape hatch** — no `skipRetiredCheck`
 * on `WriteEnv` — and the reason is worth keeping. The obvious candidates for
 * one are the paths that write HISTORY rather than new work (template seeding,
 * `migrate-ingest`, a restore), and every one of them writes its rows with a
 * raw INSERT and never reaches this function at all. A flag whose only callers
 * turn out not to exist is `skipSyncHooks`, whose doc comment has claimed bulk
 * paths set it since the day it was added and which no caller has ever set. The
 * escape that DOES exist is declared on the field, visible in the schema, and
 * per-target: `RetireSpec.references: "allow"`.
 */
export const validateRelations = async (
  data: Record<string, unknown>,
  fields: FieldDef[],
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<void> => {
  // Keyed by target slug so the existence SELECT still batches. `via` is keyed
  // by FIELD rather than the other way round for two reasons: insertion order
  // is the declaration order of `fields`, so a refusal names the boxes in the
  // order the form shows them, and a payload with two relations into one
  // collection (`ship_to` and `bill_to` → `addresses`) can be told apart —
  // naming both when only one is retired points the operator at the wrong box.
  const checks = new Map<string, { ids: Set<string>; via: Map<string, Set<string>> }>();
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
    const entry = checks.get(f.to) ?? { ids: new Set<string>(), via: new Map<string, Set<string>>() };
    // Which ids arrived on which field, kept so a refusal can name the box the
    // operator filled rather than only the collection behind it — and only the
    // box that actually holds a retired row.
    const seen = entry.via.get(f.name) ?? new Set<string>();
    for (const id of ids) {
      entry.ids.add(id);
      seen.add(id);
    }
    entry.via.set(f.name, seen);
    checks.set(f.to, entry);
  }
  if (checks.size === 0) return;
  for (const [slug, { ids: idSet, via }] of checks) {
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
    // The retirement flag rides along on the existence SELECT that already had
    // to run. One statement answers both questions, so refusing a reference to
    // a retired row costs nothing on the write path.
    const retireField = findRetireField(target.fields);
    const checkRetired = Boolean(retireField?.retire && retireField.retire.references !== "allow");
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${sql.identifier(target.pkColumn)} AS ${sql.identifier("__rel_id")}${
        checkRetired && retireField
          ? sql`, ${sql.identifier(retireField.name)} AS ${sql.identifier("__rel_retired")}`
          : sql``
      }
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
    if (!checkRetired || !retireField?.retire) continue;
    const retired = rows
      .filter((r) => isRetiredValue(r["__rel_retired"], retireField.retire as RetireSpec))
      .map((r) => String(r["__rel_id"] ?? ""));
    if (retired.length > 0) {
      const sample = retired.slice(0, 3).join(", ");
      const suffix = retired.length > 3 ? ` (…and ${retired.length - 3} more)` : "";
      // Only the fields that actually carry one of the retired ids. Row order
      // out of the database is not deterministic, so the names are taken from
      // `via` — whose insertion order is the field declaration order — rather
      // than from the order the retired rows came back in.
      const retiredIds = new Set(retired);
      const where = [...via]
        .filter(([, ids]) => [...ids].some((id) => retiredIds.has(id)))
        .map(([name]) => name)
        .join(", ");
      throw new AppError(
        "VALIDATION",
        `"${where}" points at a retired row in "${slug}": ${sample}${suffix} — restore the row, or pick one that is still in play`,
      );
    }
  }
};

/**
 * Verify that every `interface: "user"` field value in the payload points at a
 * real `app_users` row in the active workspace. The mirror of
 * {@link validateRelations} for the app-user link field: empty string and null
 * are skipped (treated as "no link"), a missing id throws 422, and all ids are
 * batched into one SELECT. Suspended end-users are still valid link targets —
 * suspension gates sign-in, not references. The tenant filter keeps the check
 * workspace-scoped, so an id from another workspace's pool fails the same way
 * a bogus id does.
 */
export const validateAppUserLinks = async (
  data: Record<string, unknown>,
  fields: FieldDef[],
  ctx: Ctx,
  tenantId: string | null | undefined,
): Promise<void> => {
  const idSet = new Set<string>();
  for (const f of fields) {
    if (f.interface !== "user") continue;
    const val = data[f.name];
    if (val === undefined || val === null || val === "") continue;
    idSet.add(String(val));
  }
  if (idSet.size === 0) return;
  if (!tenantId) {
    throw new AppError(
      "VALIDATION",
      "Active tenant could not be resolved; cannot link a workspace end-user",
    );
  }
  const ids = [...idSet];
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier("id")} FROM ${sql.identifier("app_users")}
        WHERE ${sql.identifier("tenant_id")} = ${tenantId}
        AND ${sql.identifier("id")} IN (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})`,
  );
  const found = new Set(rows.map((r) => String(r["id"] ?? "")));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(", ");
    const suffix = missing.length > 3 ? ` (…and ${missing.length - 3} more)` : "";
    throw new AppError(
      "VALIDATION",
      `No workspace end-user with id: ${sample}${suffix}`,
    );
  }
};
