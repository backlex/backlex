import { isRetiredValue, retiredValue, type RetireSpec } from "@backlex/db/retirement";

/**
 * Reading a collection's retirement flag, in the admin.
 *
 * The admin's `SchemaField` is a hand-maintained subset of the server's
 * `FieldDef` and deliberately does not spell out every spec key — the existing
 * order-field code reads its spec through an inline cast for the same reason.
 * What this module adds is that the FOUR places that ask the question (the
 * relation picker, the list's tab row, the row action, the list cell) ask it in
 * one place, so they cannot disagree about which column decides or which value
 * means retired.
 *
 * The predicate itself is imported from `@backlex/db/retirement` rather than
 * rewritten here: the admin greys out exactly the rows the server filters out.
 */

/** A field carrying a retirement spec, however narrowly the caller types it. */
export interface RetireFieldLike {
  name: string;
  label?: string;
  retire?: RetireSpec;
}

/**
 * The collection's retirement flag, or undefined.
 *
 * Takes anything with a `name`, since every admin call site has a different
 * narrow row type for its fields and none of them declares `retire`.
 */
export const retireFieldOf = (
  fields: ReadonlyArray<{ name: string; label?: string }> | undefined,
): RetireFieldLike | undefined =>
  (fields as ReadonlyArray<RetireFieldLike> | undefined)?.find((f) => Boolean(f.retire));

/** Whether this row is out of play, given the collection's flag. */
export const rowIsRetired = (
  row: Record<string, unknown>,
  field: RetireFieldLike | undefined,
): boolean => (field?.retire ? isRetiredValue(row[field.name], field.retire) : false);

/** The value that puts a row back in play — what "Restore" writes. */
export const liveValueOf = (field: RetireFieldLike): boolean => !retiredValue(field.retire ?? {});
