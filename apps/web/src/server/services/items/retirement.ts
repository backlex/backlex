import { AppError } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import { findRetireField, retiredValue, type RetireSpec } from "@backlex/db/retirement";
import { performUpdate, type ResolvedPerm, type WriteEnv } from "./write";

/**
 * Taking a row out of play, and putting it back.
 *
 * The pure half (the spec, which value means retired, how a stored value is
 * read) lives in `@backlex/db/retirement`; this module is the verb.
 *
 * There is very little of it on purpose. `retire` is a write of one boolean on
 * one named row, which is exactly what `performUpdate` already does — so this
 * resolves the flag, builds the patch, and delegates. What that buys is not
 * brevity but correctness, and each of these came from a previous feature
 * getting it wrong by hand:
 *
 *  - the caller's row scope (`perm.whereSql`) narrows the update, so retiring a
 *    row a role cannot see 404s rather than succeeding;
 *  - the update FIELD allow-list is enforced, so a role explicitly refused a
 *    `PATCH` of `active` is refused this verb too, with a 403 rather than a 200
 *    that changed nothing;
 *  - revisions, the activity row, the realtime event, the flow triggers and the
 *    webhooks all fire, because they fire for every update.
 *
 * A hand-written `UPDATE … SET active = 0` would have had none of those, and
 * would have been the fourth copy of a write path this codebase has had to
 * consolidate.
 */

/** An item's retirement flag, paired with its spec. */
export interface RetireField {
  field: FieldDef;
  spec: RetireSpec;
}

/**
 * The collection's retirement flag, or a 422 naming the collection.
 *
 * Refuses rather than no-ops: a caller that asked to retire a row in a
 * collection with no flag has a wrong idea about the schema, and answering
 * `{ok: true}` would confirm it.
 */
export const requireRetireField = (collection: { slug: string; fields: FieldDef[] }): RetireField => {
  const field = findRetireField(collection.fields);
  if (!field?.retire) {
    throw new AppError(
      "VALIDATION",
      `Collection "${collection.slug}" has no retirement flag — declare \`retire\` on a boolean field first`,
    );
  }
  return { field, spec: field.retire };
};

/**
 * Retire a row, or restore one.
 *
 * Idempotent by construction: retiring an already-retired row writes the value
 * it already holds. That is deliberate rather than short-circuited — the write
 * still records an activity row, which is what an operator clicking "Retire" a
 * second time is entitled to see, and which a `304`-style no-op would hide.
 *
 * Unlike `reorder`, this is applied WITHIN the caller's scope rather than
 * refused when the scope is partial, and the difference is the question #48
 * settled: does the operation COUPLE the rows? Renumbering a filtered subset
 * collides with the rows it skipped, so a partial grant has no coherent answer
 * there. Retirement is independent per row, so retiring the rows a role can see
 * is complete and correct.
 */
export const setRetired = async (
  env: WriteEnv,
  id: string,
  retired: boolean,
  perm: ResolvedPerm,
): Promise<{ data: Record<string, unknown>; field: string; retired: boolean }> => {
  const { field, spec } = requireRetireField(env.collection);
  const live = !retiredValue(spec);
  const res = await performUpdate(
    env,
    id,
    { [field.name]: retired ? retiredValue(spec) : live },
    perm,
    {},
  );
  for (const fx of res.sideEffects) await fx();
  return { data: res.data ?? {}, field: field.name, retired };
};
