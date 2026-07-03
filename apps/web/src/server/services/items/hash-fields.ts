import { hashSecret, isSecretHash } from "@backlex/auth";
import type { FieldDef } from "@backlex/db";

/**
 * Write-path transform for `hash`-typed fields. Runs *after* `validateBody`
 * (so plaintext length/pattern rules already applied) and *before* the row is
 * serialized/inserted, on the shared payload object every write surface holds:
 * REST `performCreate`/`performUpdate` and the GraphQL create/update resolvers
 * all call this so a hash field can never reach the DB as plaintext from any
 * surface.
 *
 * Per hash field present in the payload:
 *  - `null` / `undefined` / `""` → delete the key. On update this means
 *    "leave the existing digest untouched"; on create the field's `required`
 *    check already fired in `validateBody` for a truly-missing value.
 *  - already a stored digest (`isSecretHash`) → pass through unchanged, so a
 *    migration / restore that feeds pre-hashed rows doesn't double-hash.
 *  - any other value → scrypt-hash the stringified plaintext.
 *
 * `keyOf` maps a field def to the key the payload uses — REST keys by
 * `f.name`, GraphQL by `camel(f.name)`.
 */
export const hashIncomingFields = async (
  data: Record<string, unknown>,
  fields: FieldDef[],
  keyOf: (f: FieldDef) => string = (f) => f.name,
): Promise<void> => {
  for (const f of fields) {
    if (f.type !== "hash") continue;
    const key = keyOf(f);
    if (!(key in data)) continue;
    const value = data[key];
    if (value === null || value === undefined || value === "") {
      delete data[key];
      continue;
    }
    const plain = String(value);
    data[key] = isSecretHash(plain) ? plain : await hashSecret(plain);
  }
};

/**
 * Scrub every present `hash` field to `null` in place. Call this right after the
 * row is persisted so the digest can't leak from the in-memory payload into the
 * write response, the realtime event, the audit-log payload, or embed/FTS text.
 * Mirrors the read-path masking in `deserialize`, keeping the digest DB-only.
 */
export const scrubHashFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  keyOf: (f: FieldDef) => string = (f) => f.name,
): void => {
  for (const f of fields) {
    if (f.type !== "hash") continue;
    const key = keyOf(f);
    if (key in data) data[key] = null;
  }
};

/**
 * Delete every `private` field from the write payload in place, right after the
 * row is persisted. A private column is stored + writable but must never leave
 * through an API surface — dropping it here keeps it out of the write response,
 * the realtime event, the audit-log payload, and embed/FTS text. Mirrors the
 * read-path omission in `deserializeRow` / the GraphQL row builder. Unlike hash
 * (masked to `null`) the key is removed entirely, so the field is simply absent.
 */
export const scrubPrivateFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  keyOf: (f: FieldDef) => string = (f) => f.name,
): void => {
  for (const f of fields) {
    if (!f.private) continue;
    delete data[keyOf(f)];
  }
};
