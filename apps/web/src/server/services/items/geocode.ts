import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../../context";
import { geocodableFields } from "./geo-fields";

/**
 * Filling a `geo` field in from the address columns next to it.
 *
 * This is what makes the feature reach the fifteen templates that motivated it.
 * They already hold `address`, `city` and `country` as text; asking their owners
 * to retype every row as a coordinate pair is not a migration path, so a field
 * with `geo.geocodeFrom` set derives its point from the columns that are
 * already there.
 *
 * Three rules govern when it fires, and each one exists because the opposite
 * behaviour is worse:
 *
 *  - **Never over an explicit point.** A coordinate the operator typed, or
 *    dropped a pin for, is better information than a string match. The geocode
 *    only runs when the write supplies no point at all.
 *  - **Never fatal.** A geocoder that is down, rate-limited or misconfigured
 *    must not stop someone saving a customer record. Every failure leaves the
 *    point null and the write succeeds — which is the same state the row would
 *    have been in before this feature existed.
 *  - **Never in a bulk run.** One blocking HTTP call per row, against a
 *    provider that rate-limits to roughly one request a second, turns a
 *    thousand-row CSV import into a twenty-minute request that times out
 *    halfway. Bulk paths set `skipSyncHooks` for the same reason; the backfill
 *    endpoint (`POST /api/geo/backfill`) is how those rows get their points,
 *    on a bounded budget the caller can see.
 */

/**
 * Join the configured source columns into one address string.
 *
 * Blank and missing values are dropped rather than producing `", , Türkiye"` —
 * providers score a string with empty components worse, and some return a
 * country centroid for it, which is a confidently wrong pin.
 *
 * Returns null when nothing usable is left, which is the signal not to call the
 * provider at all.
 */
export const addressStringFor = (
  field: FieldDef,
  row: Record<string, unknown>,
): string | null => {
  const parts: string[] = [];
  for (const name of field.geo?.geocodeFrom ?? []) {
    const v = row[name];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) parts.push(s);
  }
  const joined = parts.join(", ");
  return joined.length > 0 ? joined : null;
};

/**
 * Fill in every eligible `geo` field on a write payload, in place.
 *
 * `context` is the row as it will exist AFTER the write — for a create that is
 * the payload itself; for an update it is the stored row with the patch applied,
 * because a patch that changes only `city` still has to be geocoded against the
 * `address` it did not mention.
 *
 * `touched` limits the work on an update: a patch that leaves every source
 * column alone has nothing new to geocode, and re-resolving on every unrelated
 * save would spend a provider quota on nothing.
 */
export const applyAutoGeocode = async (
  ctx: Ctx,
  fields: FieldDef[],
  data: Record<string, unknown>,
  context: Record<string, unknown>,
  opts: { touched?: (field: FieldDef) => boolean } = {},
): Promise<void> => {
  const candidates = geocodableFields(fields);
  if (candidates.length === 0) return;
  // Nothing configured resolves nothing — skip the work and the log line.
  if (ctx.geocode.provider === "console") return;

  for (const f of candidates) {
    // An explicit point always wins, including an explicit null: clearing a
    // location is a decision, and re-deriving one would undo it on the spot.
    if (f.name in data) continue;
    if (opts.touched && !opts.touched(f)) continue;
    const address = addressStringFor(f, context);
    if (!address) continue;
    try {
      const hit = await ctx.geocode.geocode(address);
      if (hit) data[f.name] = { lat: hit.lat, lng: hit.lng };
    } catch (e) {
      // Provider failure — the row still saves without a point. Logged, not
      // thrown: a geocoder outage is not a reason to reject a customer record.
      //
      // The ADDRESS is deliberately not in this line. It is the composed value
      // of the row's `geocodeFrom` columns, which on the collections this
      // feature exists for is a named person's home address. This runs on the
      // write path, so an expired key or an exhausted quota would turn every
      // subsequent save into a log record holding one — and logs are shipped
      // onward by the OTLP exporter to an audience wider than the people
      // holding read permission on the collection. The field name is enough to
      // find the misconfiguration; the resident's street is not diagnostic.
      console.warn(`[geocode] ${f.name}: lookup failed — ${(e as Error).message}`);
    }
  }
};

/** True when a patch touches any of a geo field's source columns — the only
 *  case in which an update has a new address to resolve. */
export const patchTouchesSources = (
  field: FieldDef,
  patch: Record<string, unknown>,
): boolean => (field.geo?.geocodeFrom ?? []).some((name) => name in patch);
