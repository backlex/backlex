import type { GeocodeAdapter, GeocodeResult } from "@backlex/core/adapters";

/**
 * Mapbox Geocoding (v5, the `mapbox.places` endpoint).
 *
 * One thing to keep straight: Mapbox returns coordinates as GeoJSON, so
 * `center` is `[longitude, latitude]` — longitude FIRST. Reading it as
 * `[lat, lng]` produces a point that is plausibly on the map and in the wrong
 * hemisphere, which is exactly the class of bug that survives a smoke test.
 *
 * The forward endpoint takes the search text in the PATH, so it must be
 * URL-encoded; an address with a `/` in it (common in Turkish addresses —
 * "Kat 3/A") would otherwise change the endpoint being called.
 *
 * `relevance` is a real 0–1 score, so it maps straight onto `confidence`.
 *
 * Runtime-agnostic: only `fetch`.
 */

interface MapboxConfig {
  accessToken: string;
  /** Optional `language` for place names. */
  language?: string;
  /** Optional ISO-3166 alpha-2 country restriction, e.g. `"tr"`. */
  country?: string;
}

interface MapboxResponse {
  message?: string;
  features?: {
    /** `[lng, lat]` — GeoJSON order. */
    center?: [number, number];
    place_name?: string;
    relevance?: number;
  }[];
}

const BASE = "https://api.mapbox.com/geocoding/v5/mapbox.places";

export const mapboxGeocode = (cfg: MapboxConfig): GeocodeAdapter => {
  const call = async (query: string): Promise<GeocodeResult | null> => {
    const url = new URL(`${BASE}/${encodeURIComponent(query)}.json`);
    url.searchParams.set("access_token", cfg.accessToken);
    url.searchParams.set("limit", "1");
    if (cfg.language) url.searchParams.set("language", cfg.language);
    if (cfg.country) url.searchParams.set("country", cfg.country);
    const res = await fetch(url);
    // Never echo the URL — it carries the token.
    if (!res.ok) throw new Error(`Mapbox geocoding responded ${res.status}`);
    const body = (await res.json()) as MapboxResponse;
    const top = body.features?.[0];
    const center = top?.center;
    if (!center || center.length !== 2) return null;
    const [lng, lat] = center;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, formatted: top?.place_name, confidence: top?.relevance };
  };

  return {
    provider: "mapbox",
    geocode: (address) => call(address),
    // The reverse endpoint is the same path with `lng,lat` as the query — and
    // that is the one place the GeoJSON order matters on the way OUT too.
    reverse: (lat, lng) => call(`${lng},${lat}`),
  };
};
