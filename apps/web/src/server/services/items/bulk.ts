import { AppError, type AuthSubject } from "@backlex/core";
import type { FieldType } from "@backlex/db";
import type { Ctx } from "../../context";
import type { CollectionRow } from "./collection-loader";
import { validateBody, validateRelations } from "./validate";
import { performUpdate, type ResolvedPerm, type WriteEnv } from "./write";

/**
 * Max keys a single bulk-update may touch. Bounds the per-row work the request
 * queues (each key is one SELECT + UPDATE + side-effects, same as N single
 * PATCHes). The admin's selection-driven UI stays well under this; callers that
 * need more should page their selection.
 */
export const BULK_UPDATE_MAX = 1000;

/**
 * Field types we refuse to bulk-set in v1. These are structured / multi-value /
 * localized shapes where "set the same value on N rows" is ambiguous or
 * destructive (a single JSON blob, file key, relation_many array, or i18n map
 * fanned out across a whole selection). Single-record PATCH still accepts them;
 * this guard only narrows the bulk surface. `computed` fields are already
 * rejected by `validateBody`. Scalar + single-relation types pass through.
 */
const BULK_BLOCKED_TYPES = new Set<FieldType>(["json", "file", "relation_many"]);

export interface BulkUpdateRowResult {
  id: string;
  ok: boolean;
  error?: { code: string; message: string };
}

export interface BulkUpdateResult {
  /** Distinct keys processed (after de-duplication). */
  total: number;
  /** Rows actually written. */
  updated: number;
  /** Rows that failed — permission/row-scope filtered (NOT_FOUND) or write error. */
  failed: number;
  results: BulkUpdateRowResult[];
}

export interface RunBulkUpdateParams {
  ctx: Ctx;
  auth: AuthSubject;
  collection: CollectionRow;
  /** Selected primary keys to update. */
  keys: string[];
  /** Shared patch applied to every key (only the named fields change). */
  data: Record<string, unknown>;
  /** Resolved `update` permission for the collection (from requirePermission). */
  perm: ResolvedPerm;
  /** The fields the caller may READ back — what each row's response is
   *  projected through. See `WriteEnv.readFields`. */
  readFields: Set<string> | null;
  meta: Record<string, unknown>;
  durationMs: () => number;
  locale: string | null;
}

/**
 * Apply ONE shared patch to a list of selected item ids. The shared `data` is
 * validated + guarded ONCE up front (so a bad payload is a single clean 422,
 * not N identical row failures); each key then runs through `performUpdate` so
 * row-level permissions (`whereSql`), field allow-lists, i18n merge, revisions,
 * and the realtime/vector/fts/audit side-effects stay byte-identical to a single
 * PATCH. A pure `UPDATE … WHERE id IN (…)` would be cheaper but would silently
 * drop those per-row side-effects, so we iterate instead.
 *
 * Partial-success: a key the caller can't write (filtered by `whereSql` or
 * tenant scope) surfaces as a per-row `NOT_FOUND` and is counted in `failed`;
 * the rest still commit. No request-level transaction — mirrors the non-atomic
 * batch endpoint.
 */
export const runBulkUpdate = async (params: RunBulkUpdateParams): Promise<BulkUpdateResult> => {
  const { ctx, auth, collection, data, perm, readFields } = params;

  if (Object.keys(data).length === 0) {
    throw new AppError("VALIDATION", "Bulk update requires at least one field in `data`");
  }

  // Guard the bulk surface to scalar / single-relation fields before touching
  // any row. Unknown / computed / field-permission errors are surfaced by the
  // shared validateBody pass below.
  for (const key of Object.keys(data)) {
    const def = collection.fields.find((f) => f.name === key);
    if (def && BULK_BLOCKED_TYPES.has(def.type)) {
      throw new AppError(
        "VALIDATION",
        `Field "${key}" (${def.type}) cannot be bulk-edited — update it per record`,
      );
    }
  }

  // Validate the shared patch once: a structural / permission error here fails
  // the whole request (422/403) instead of failing every row identically.
  validateBody(data, collection.fields, true, perm.fields);
  await validateRelations(data, collection.fields, ctx, auth.tenantId);

  // De-duplicate while preserving the caller's order.
  const uniqueKeys = [...new Set(params.keys)];

  const baseEnv = (): WriteEnv => ({
    ctx,
    collection,
    userId: auth.userId,
    tenantId: auth.tenantId,
    roles: auth.roles,
    // `email` and the org triple were both missing here, and this factory is
    // the one the write-condition check reaches through bulk update, its
    // GraphQL twin and the MCP tool. Their absence broke it in BOTH directions
    // on this surface: `$org.id` resolved to null, so a member's bulk update of
    // their OWN in-org row was refused while the identical single-row PATCH
    // succeeded, AND `org_id: null` was accepted — the exact escape PATCH
    // answers 403 for. A false denial and a false permit from one omission.
    email: auth.email ?? null,
    orgId: auth.orgId ?? null,
    orgRole: auth.orgRole ?? null,
    orgIds: auth.orgIds ?? [],
    meta: params.meta,
    impersonatedBy: params.auth.impersonatedBy ?? null,
    impersonationReadOnly: params.auth.impersonationReadOnly ?? false,
    durationMs: params.durationMs,
    locale: params.locale,
    readFields,
  });

  const results: BulkUpdateRowResult[] = [];
  for (const id of uniqueKeys) {
    try {
      const res = await performUpdate(baseEnv(), id, { ...data }, perm);
      for (const fx of res.sideEffects) await fx();
      results.push({ id, ok: true });
    } catch (e) {
      const error =
        e instanceof AppError
          ? { code: e.code, message: e.message }
          : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
      results.push({ id, ok: false, error });
    }
  }

  const updated = results.filter((r) => r.ok).length;
  return { total: uniqueKeys.length, updated, failed: uniqueKeys.length - updated, results };
};
