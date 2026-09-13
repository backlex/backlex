import type { GeocodeAdapter, GeocodeResult } from "@backlex/core/adapters";

/**
 * Nominatim — the OpenStreetMap geocoder. The default when a workspace wants
 * geocoding without signing up for anything.
 *
 * Two things about it shape this adapter, and both are policy rather than API
 * detail:
 *
 *  - **The public instance requires an identifying `User-Agent`** and bans
 *    clients that do not send one. `userAgent` is therefore not optional in
 *    spirit; it defaults to a string naming this software and the deployment's
 *    own URL, which is what the usage policy asks for.
 *  - **It is rate-limited to roughly one request a second**, and bulk
 *    geocoding is explicitly not allowed on the public instance. That is why
 *    `GEOCODE_URL` exists: a workspace geocoding more than occasionally is
 *    expected to point at its own Nominatim, and the code path is identical.
 *
 * Runtime-agnostic: only `fetch`.
 */

interface NominatimConfig {
  /** Base URL of the Nominatim instance. Defaults to the public one. */
  url?: string;
  /** Identifying UA, per the usage policy. */
  userAgent: string;
  /** Optional `accept-language` for the returned `display_name`. */
  language?: string;
}

const DEFAULT_URL = "https://nominatim.openstreetmap.org";

/** One row of Nominatim's JSON. `lat`/`lon` arrive as STRINGS. */
interface NominatimRow {
  lat?: string;
  lon?: string;
  display_name?: string;
  /** Present on `search`, absent on `reverse`. 0–1, its own notion of quality. */
  importance?: number;
}

const toResult = (row: NominatimRow | undefined): GeocodeResult | null => {
  if (!row) return null;
  const lat = Number(row.lat);
  const lng = Number(row.lon);
  // A row whose coordinates don't parse is indistinguishable from no row: the
  // caller must not get a `{ lat: NaN }` that serializes into a column.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    formatted: row.display_name,
    confidence: typeof row.importance === "number" ? row.importance : undefined,
  };
};

export const nominatimGeocode = (cfg: NominatimConfig): GeocodeAdapter => {
  const base = (cfg.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = { "user-agent": cfg.userAgent };
  if (cfg.language) headers["accept-language"] = cfg.language;

  const call = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("format", "jsonv2");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // A provider failure, not a "not found" — the caller surfaces this rather
      // than recording an address as unplaceable.
      throw new Error(`Nominatim responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  };

  return {
    provider: "nominatim",
    async geocode(address) {
      const body = (await call("/search", { q: address, limit: "1" })) as NominatimRow[];
      return toResult(Array.isArray(body) ? body[0] : undefined);
    },
    async reverse(lat, lng) {
      // `reverse` answers with a single object, not an array — and with an
      // `{ error }` object when the point is in the ocean.
      const body = (await call("/reverse", { lat: String(lat), lon: String(lng) })) as
        | NominatimRow
        | { error?: unknown };
      if (body && typeof body === "object" && "error" in body) return null;
      return toResult(body as NominatimRow);
    },
  };
};
