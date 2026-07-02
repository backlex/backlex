/**
 * Value normalizers for Firestore / DynamoDB documents — the driver-specific
 * value classes must be flattened to JSON-safe shapes BEFORE inference and
 * copy. Duck-typed on purpose: no driver imports, so the logic is unit-
 * testable without `@google-cloud/firestore` / `@aws-sdk/*` installed and
 * immune to driver class-identity issues across module instances.
 */

/** Firestore Timestamp: has toDate(); DocumentReference: has string path +
 *  id; GeoPoint: numeric latitude/longitude. Everything else recurses. */
const normalizeFirestoreValue = (v: unknown): unknown => {
  if (v === null || v === undefined) return v;
  if (v instanceof Date || typeof v !== "object") return v;
  const o = v as Record<string, unknown> & {
    toDate?: () => Date;
    path?: unknown;
    id?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
  if (typeof o.toDate === "function") return o.toDate(); // Timestamp
  if (typeof o.path === "string" && typeof o.id === "string") return o.path; // DocumentReference → path string
  if (typeof o.latitude === "number" && typeof o.longitude === "number") {
    return { latitude: o.latitude, longitude: o.longitude }; // GeoPoint
  }
  if (Array.isArray(v)) return v.map(normalizeFirestoreValue);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) out[k] = normalizeFirestoreValue(val);
  return out;
};

/** One Firestore document → the normalized `_id` row contract. */
export const normalizeFirestoreDoc = (
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { _id: id };
  for (const [k, v] of Object.entries(data)) {
    if (k === "_id") continue; // the document id wins the key slot
    out[k] = normalizeFirestoreValue(v);
  }
  return out;
};

/** Dynamo (unmarshalled) values: Sets → arrays, binary → dropped (a blob
 *  doesn't survive a JSON row copy — same posture as SQL bytea). */
const normalizeDynamoValue = (v: unknown): unknown => {
  if (v === null || v === undefined) return v;
  if (v instanceof Set) return [...v].map(normalizeDynamoValue);
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return undefined;
  if (Array.isArray(v)) return v.map(normalizeDynamoValue);
  if (typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = normalizeDynamoValue(val);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }
  return v;
};

/** One unmarshalled Dynamo item → the normalized `_id` row contract. The
 *  partition-key attribute is hoisted to `_id` and removed from the body. */
export const normalizeDynamoItem = (
  item: Record<string, unknown>,
  partitionKey: string,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { _id: item[partitionKey] };
  for (const [k, v] of Object.entries(item)) {
    if (k === partitionKey || k === "_id") continue;
    const n = normalizeDynamoValue(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
};
