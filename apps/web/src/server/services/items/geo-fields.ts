import { type FieldDef, parseGeoPoint } from "@backlex/db";

/**
 * Rewrite every present `geo` value in a write payload to canonical
 * `{ lat, lng }`, in place.
 *
 * Four input shapes are accepted (a GeoJSON `[lng, lat]` pair, `latitude` /
 * `longitude`, a pasted `"lat,lng"` string, and the canonical object — see
 * `parseGeoPoint`), and exactly one is stored. Normalizing inside `serialize`
 * alone would fix the COLUMN and nothing else: `performCreate` builds its
 * response, its realtime event, its activity-log entry and its embed/FTS text
 * out of the in-memory payload, not out of the row it just wrote. A client that
 * posted a GeoJSON pair got that same array back in the 201, saw a different
 * shape on the next read, and — through the changefeed — replicated the
 * un-normalized one into its offline store.
 *
 * So this runs on the payload, right after validation, for the same reason
 * `hashIncomingFields` does: whatever the rest of the write path sees should
 * already be what the database will hold.
 *
 * Silently skips values it cannot parse. `validateBody` has already rejected
 * those with a 422 naming the field; re-throwing here would only turn a precise
 * error into a vaguer one.
 */
export const normalizeGeoFields = (
  data: Record<string, unknown>,
  fields: FieldDef[],
): void => {
  for (const f of fields) {
    if (f.type !== "geo") continue;
    const value = data[f.name];
    if (value === undefined || value === null || value === "") continue;
    try {
      data[f.name] = parseGeoPoint(value);
    } catch {
      // Already reported by validateBody.
    }
  }
};

/** The `geo` fields of a collection that can fill themselves in from an
 *  address — the ones carrying a non-empty `geo.geocodeFrom`. */
export const geocodableFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => f.type === "geo" && (f.geo?.geocodeFrom?.length ?? 0) > 0);

/**
 * Validate + normalize a write payload's `geo` values, in place, under an
 * arbitrary key naming.
 *
 * REST reaches geo values through `validateBody` (shape) and
 * {@link normalizeGeoFields} (canonical form), because it goes through
 * `performCreate`. **GraphQL does neither**: its create and update resolvers
 * hand-build their own SQL and their `validateInput` only checks presence and
 * writability — it never calls `validateValue`. So on that surface a latitude
 * of 91 reached `serialize`, failed to parse, and was stored verbatim, where
 * `_near` would read it as NULL and quietly never match the row.
 *
 * `keyOf` exists because GraphQL names fields in camelCase while the field
 * definitions are snake_case. Same reason `scrubHashFields` takes one.
 *
 * @throws Error naming the field, for the caller to wrap in its own error type.
 */
export const validateAndNormalizeGeo = (
  data: Record<string, unknown>,
  fields: FieldDef[],
  keyOf: (f: FieldDef) => string = (f) => f.name,
): void => {
  for (const f of fields) {
    if (f.type !== "geo") continue;
    const key = keyOf(f);
    const value = data[key];
    if (value === undefined || value === null || value === "") continue;
    try {
      data[key] = parseGeoPoint(value);
    } catch (e) {
      throw new Error(`${f.name}: ${(e as Error).message}`);
    }
  }
};
