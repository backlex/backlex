/**
 * Geo fields — a place a row is at, and the ability to ask what is near.
 *
 * Everything in this module is PURE: the point grammar, the radius grammar, and
 * the distance arithmetic. Compiling the `_near` operator to SQL needs Drizzle
 * and lives in `permission.ts`; keeping the two apart is what lets the admin
 * validate a coordinate, format it, and compute a distance from the row it
 * already holds — without a round trip, and without drifting from the numbers
 * the server filtered on.
 *
 * It carries no imports, which is why `@backlex/db/geo` is its own package
 * export: reaching it through the package root would drag the migration bundles
 * — and their `*.sql` imports — into the browser build.
 *
 * ## The shape of the problem
 *
 * Forty-five columns across fifteen of the twenty-seven schema templates are an
 * address: `address`, `city`, `postal_code`, `country`, on venues, warehouses,
 * clinics, properties, customers and technicians. Every one of them was `text`,
 * which is fine for printing on an invoice and useless for the question those
 * collections actually get asked — *which of these is near me*. There was no
 * coordinate type, no distance operator, and nothing that turned a written
 * address into a point, so "the three nearest technicians" was a full export
 * and a loop in the caller.
 *
 * ## Why the arithmetic looks like this
 *
 * The distance model is **equirectangular projection**: flatten the patch of
 * globe around the query origin, then use Pythagoras on it. It is a few tenths
 * of a percent off great-circle distance at the radii anyone filters on (see
 * {@link GEO_ACCURACY_NOTE}), and — the point — it needs nothing but `+`, `-`,
 * `*` and a `CASE`.
 *
 * That matters because the alternatives are not portable. PostGIS is a Postgres
 * extension and there is no D1 equivalent. Haversine needs `sin`/`cos`/`asin`,
 * and SQLite only has those when it was compiled with
 * `SQLITE_ENABLE_MATH_FUNCTIONS` — which is a property of whichever build the
 * deploy target happens to link, not something a query can check. The same is
 * true of `sqrt`, so **nothing here ever takes a square root**: the filter
 * compares SQUARED distance against SQUARED radius, and the sort orders by
 * squared distance. Squaring is monotonic over non-negative reals, so both
 * answers are identical to the ones a real distance would give, and the whole
 * feature runs on arithmetic every SQL engine has had since the 1980s.
 *
 * Every trigonometric term is therefore evaluated HERE, in JavaScript, against
 * the query origin — which is one point, known before the query is built. What
 * reaches SQL is a handful of bound constants.
 *
 * @module
 */

/** A point on the earth. The stored shape of a `geo` field, and the only one. */
export interface GeoPoint {
  /** Degrees north, −90…90. */
  lat: number;
  /** Degrees east, −180…180. */
  lng: number;
}

/**
 * Mean earth radius in kilometres (IUGG). The same figure haversine
 * implementations use; it is what makes {@link DEG_KM} the scale factor between
 * a degree of latitude and a kilometre.
 */
export const EARTH_RADIUS_KM = 6371.0088;

/**
 * Kilometres per degree of latitude — `EARTH_RADIUS_KM * π / 180`.
 *
 * Also kilometres per degree of LONGITUDE at the equator; away from it, scaled
 * by `cos(latitude)`. That single factor is the whole of the projection.
 */
export const DEG_KM = (EARTH_RADIUS_KM * Math.PI) / 180;

/**
 * How wrong the flat-earth shortcut is, in one sentence — quoted verbatim by
 * `docs/geo.md` so the documentation cannot claim an accuracy the code does not
 * deliver.
 */
export const GEO_ACCURACY_NOTE =
  "Distances use an equirectangular projection around the query origin: within about 0.1% of great-circle distance at a 50 km radius, about 0.5% at 300 km, and increasingly optimistic beyond that or above 85° latitude.";

/** Units accepted by {@link parseRadiusKm}, and their value in kilometres. */
const RADIUS_UNITS: Record<string, number> = {
  km: 1,
  m: 0.001,
  mi: 1.609344,
  // Nautical miles — the unit marine and aviation datasets are written in.
  nmi: 1.852,
};

/** `12`, `12km`, `800 m`, `5mi`, `3 nmi`. A bare number means kilometres. */
const RADIUS_RE = /^\s*(\d+(?:\.\d+)?)\s*(km|m|mi|nmi)?\s*$/i;

/**
 * Parse a radius into kilometres.
 *
 * Accepts a number (kilometres) or a string with an optional unit suffix. The
 * unit is part of the wire format rather than a separate parameter because a
 * bare number is ambiguous in exactly the way that produces a filter which
 * silently matches a thousand times too much: `500` is a sensible radius in
 * metres and an absurd one in kilometres, and nothing downstream can tell which
 * the caller meant.
 *
 * @throws Error when the input is not a positive, finite radius.
 */
export const parseRadiusKm = (raw: unknown): number => {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error("radius must be a positive number of kilometres");
    }
    return raw;
  }
  if (typeof raw !== "string") {
    throw new Error("radius must be a number or a string like \"5km\"");
  }
  const m = RADIUS_RE.exec(raw);
  if (!m) {
    throw new Error(
      `invalid radius "${raw}" — expected a number with an optional unit (km, m, mi, nmi)`,
    );
  }
  const value = Number(m[1]);
  const unit = (m[2] ?? "km").toLowerCase();
  const factor = RADIUS_UNITS[unit];
  if (factor === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid radius "${raw}"`);
  }
  return value * factor;
};

/**
 * Coerce an unvalidated value into a {@link GeoPoint}, or throw.
 *
 * Four shapes are accepted, because four are what arrive in practice:
 *
 *  - `{ lat, lng }` — the canonical one, and what reads back;
 *  - `{ latitude, longitude }` — what geocoding APIs and GeoJSON-adjacent
 *    exports emit, and what `packages/migrate` already normalizes Firestore
 *    GeoPoints into;
 *  - `[lng, lat]` — GeoJSON coordinate order, which is longitude FIRST. It is
 *    accepted only in array form precisely because the array form is the one
 *    GeoJSON uses; an object never gets its keys reordered by convention;
 *  - `"lat,lng"` — a pasted pair, the form a map site puts on the clipboard.
 *
 * A CSV import or an adopted column hands us strings, so numeric strings are
 * coerced. `null`, `undefined` and `""` are NOT handled here — they mean "no
 * location" and callers check for them first.
 *
 * @throws Error with a message naming what was wrong.
 */
export const parseGeoPoint = (raw: unknown): GeoPoint => {
  const num = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return Number.NaN;
  };

  let lat: number;
  let lng: number;

  if (typeof raw === "string") {
    // Also the form a stored JSON string arrives in when an adopted TEXT column
    // was written by something other than this API.
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("must be a coordinate pair — got unparseable JSON");
      }
      return parseGeoPoint(parsed);
    }
    const parts = trimmed.split(",");
    if (parts.length !== 2) {
      throw new Error('must be a coordinate pair like "41.0082,28.9784"');
    }
    lat = num(parts[0]);
    lng = num(parts[1]);
  } else if (Array.isArray(raw)) {
    if (raw.length !== 2) {
      throw new Error("must be a [lng, lat] pair of two numbers");
    }
    // GeoJSON order: longitude first.
    lng = num(raw[0]);
    lat = num(raw[1]);
  } else if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const latRaw = o.lat !== undefined ? o.lat : o.latitude;
    const lngRaw = o.lng !== undefined ? o.lng : (o.lon !== undefined ? o.lon : o.longitude);
    if (latRaw === undefined || lngRaw === undefined) {
      throw new Error("must have `lat` and `lng`");
    }
    lat = num(latRaw);
    lng = num(lngRaw);
  } else {
    throw new Error("must be a coordinate pair");
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("`lat` and `lng` must both be numbers");
  }
  if (lat < -90 || lat > 90) {
    throw new Error(`latitude ${lat} is out of range (−90…90)`);
  }
  if (lng < -180 || lng > 180) {
    throw new Error(`longitude ${lng} is out of range (−180…180)`);
  }
  // Normalize −0 away so two equal points stringify identically (and so a
  // round-trip through JSON never turns "0" into "-0").
  return { lat: lat === 0 ? 0 : lat, lng: lng === 0 ? 0 : lng };
};

/** {@link parseGeoPoint} without the throw — `null` when the value isn't one. */
export const tryParseGeoPoint = (raw: unknown): GeoPoint | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return parseGeoPoint(raw);
  } catch {
    return null;
  }
};

/**
 * The shortest signed difference between two longitudes, in degrees.
 *
 * Plain subtraction is wrong across the antimeridian: 179°E and 179°W are 2°
 * apart, not 358°. Both this and the SQL the compiler emits fold the difference
 * the same way, so the JS predicate (realtime, permission simulator) and the
 * database agree about a row in Fiji.
 */
export const lngDelta = (lng: number, origin: number): number => {
  const d = lng - origin;
  if (d > 180) return d - 360;
  if (d < -180) return d + 360;
  return d;
};

/**
 * Great-circle-ish distance between two points, in kilometres.
 *
 * The JS twin of the SQL expression — same projection, same origin-derived
 * scale factor, so a row the query returned and a row the client measured agree
 * to the last decimal. The SDK re-exports this so a caller can label rows with
 * their distance without the server having to project a synthetic column into
 * every response (the row already carries its coordinates; the caller already
 * knows the origin it asked about).
 */
export const distanceKm = (a: GeoPoint, b: GeoPoint): number => {
  const scale = lngScaleAt(b.lat);
  const dLat = a.lat - b.lat;
  const dLng = lngDelta(a.lng, b.lng) * scale;
  return DEG_KM * Math.sqrt(dLat * dLat + dLng * dLng);
};

/**
 * `cos(latitude)` — how much a degree of longitude shrinks at this latitude.
 *
 * Clamped to a small positive floor. At the poles the true factor is 0, which
 * would collapse the longitude term entirely and make every meridian the same
 * place; the floor keeps the expression well-behaved there. Anything within
 * ~600 m of a pole is in a regime this projection does not model anyway, which
 * {@link GEO_ACCURACY_NOTE} says out loud.
 */
export const lngScaleAt = (lat: number): number =>
  Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);

/**
 * Everything the SQL compiler needs to emit a `_near` predicate, precomputed.
 *
 * The compiler binds these as parameters and never calls a trig function, a
 * square root, or a math extension. `maxDistSq` is the squared radius in
 * DEGREES-of-latitude units, which is the same space `lat`/`lng * lngScale`
 * live in — so the comparison is `dLat² + (dLng·s)² <= maxDistSq` with no unit
 * conversion in the database at all.
 */
export interface GeoNearPlan {
  lat: number;
  lng: number;
  /** Radius as the caller expressed it, in kilometres. Reported in errors. */
  radiusKm: number;
  /** `cos(lat)`, floored. See {@link lngScaleAt}. */
  lngScale: number;
  /** `(radiusKm / DEG_KM)²` — the right-hand side of the comparison. */
  maxDistSq: number;
}

/** The `_near` operand as it appears in the filter DSL. */
export interface GeoNearValue {
  lat: number;
  lng: number;
  /** Kilometres, or a string with a unit (`"5km"`, `"800m"`, `"3mi"`). */
  radius: number | string;
}

/**
 * Validate a `_near` operand and precompute its {@link GeoNearPlan}.
 *
 * Accepts the same origin shapes {@link parseGeoPoint} does, so
 * `{ _near: { lat, lng, radius } }` and `{ _near: { latitude, longitude,
 * radius } }` both work.
 *
 * @throws Error when the origin or the radius is not usable.
 */
export const planNear = (raw: unknown): GeoNearPlan => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("`_near` must be an object with `lat`, `lng` and `radius`");
  }
  const o = raw as Record<string, unknown>;
  if (o.radius === undefined) {
    throw new Error("`_near` needs a `radius` (e.g. 5, \"5km\", \"800m\")");
  }
  const origin = parseGeoPoint(o);
  const radiusKm = parseRadiusKm(o.radius);
  const maxDeg = radiusKm / DEG_KM;
  return {
    lat: origin.lat,
    lng: origin.lng,
    radiusKm,
    lngScale: lngScaleAt(origin.lat),
    maxDistSq: maxDeg * maxDeg,
  };
};

/**
 * Squared projected distance from a point to a plan's origin, in the same units
 * as {@link GeoNearPlan.maxDistSq}.
 *
 * The JS twin of the SQL expression, used by the in-memory predicate so
 * realtime filtering and the permission simulator answer `_near` exactly as the
 * database does.
 */
export const nearDistSq = (point: GeoPoint, plan: GeoNearPlan): number => {
  const dLat = point.lat - plan.lat;
  const dLng = lngDelta(point.lng, plan.lng) * plan.lngScale;
  return dLat * dLat + dLng * dLng;
};

/** Whether a point falls inside a plan's radius. */
export const isNear = (point: GeoPoint, plan: GeoNearPlan): boolean =>
  nearDistSq(point, plan) <= plan.maxDistSq;

/**
 * Human-readable coordinates — 5 decimal places, which resolves to about a
 * metre and is where a stored point stops meaning anything. Shared by the admin
 * table cell and the CSV export so both render a point the same way.
 */
export const formatGeoPoint = (point: GeoPoint, decimals = 5): string =>
  `${point.lat.toFixed(decimals)}, ${point.lng.toFixed(decimals)}`;

/**
 * A geo field's configuration.
 *
 * Both members are optional: a bare `geo` field is a pair of numbers a human
 * types or a map click fills in, and that is the common case.
 */
export interface GeoSpec {
  /**
   * Text fields whose values are joined (comma-separated, blanks dropped) and
   * handed to the geocoding provider when the point itself was not supplied on
   * a write.
   *
   * This is what makes the fifteen address-carrying templates work without
   * anyone retyping their data as coordinates: the row already has `address`,
   * `city` and `country`, so the point can be derived from them. It fires only
   * when the caller sent no point — an explicit coordinate is never overwritten
   * by a guess, because the guess is worse than what the operator typed.
   */
  geocodeFrom?: string[];
  /**
   * Initial map centre for a row that has no point yet, so an admin editing a
   * clinic in Ankara does not start every pin in the Gulf of Guinea. Purely a
   * UI default — it is never written to a row.
   */
  defaultCenter?: GeoPoint;
}

/**
 * Reject a malformed {@link GeoSpec} at schema-save time.
 *
 * `fieldNames` is the collection's other field names; naming a source column
 * that does not exist is the mistake worth catching here, because its only
 * other symptom is a geocode that silently never fires.
 *
 * @throws Error naming the problem.
 */
export const validateGeoSpec = (spec: GeoSpec, fieldNames: readonly string[]): void => {
  if (spec.geocodeFrom !== undefined) {
    if (!Array.isArray(spec.geocodeFrom) || spec.geocodeFrom.length === 0) {
      throw new Error("`geocodeFrom` must be a non-empty array of field names");
    }
    const known = new Set(fieldNames);
    for (const name of spec.geocodeFrom) {
      if (typeof name !== "string" || !name) {
        throw new Error("`geocodeFrom` entries must be field names");
      }
      if (known.size > 0 && !known.has(name)) {
        throw new Error(`\`geocodeFrom\` names an unknown field: ${name}`);
      }
    }
  }
  if (spec.defaultCenter !== undefined) {
    // Throws with its own message when the pair is unusable.
    parseGeoPoint(spec.defaultCenter);
  }
};
