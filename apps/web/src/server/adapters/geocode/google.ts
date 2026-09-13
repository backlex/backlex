import type { GeocodeAdapter, GeocodeResult } from "@backlex/core/adapters";

/**
 * Google Geocoding API.
 *
 * The load-bearing detail is that **HTTP 200 is not success**. Every outcome
 * comes back as 200 with a `status` string in the body, and the difference
 * between them is the difference between "this address does not exist" and
 * "your billing is switched off":
 *
 *  - `OK` — matched.
 *  - `ZERO_RESULTS` — genuinely nothing there. A null, not an error: the write
 *    that asked for it still succeeds.
 *  - anything else (`REQUEST_DENIED`, `OVER_QUERY_LIMIT`, `INVALID_REQUEST`,
 *    `UNKNOWN_ERROR`) — the provider or the account, not the address. These
 *    must throw, or a workspace with an expired key would quietly record every
 *    address it owns as unplaceable and never find out.
 *
 * Google reports no confidence score, so `confidence` is left unset rather than
 * synthesised from `location_type` — an invented number that other providers'
 * real ones would be compared against is worse than an absent one.
 *
 * Runtime-agnostic: only `fetch`.
 */

interface GoogleConfig {
  apiKey: string;
  /** Optional `language` for the formatted address. */
  language?: string;
  /** Optional ISO-3166 country bias, e.g. `"tr"`. */
  region?: string;
}

interface GoogleResponse {
  status?: string;
  error_message?: string;
  results?: {
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
  }[];
}

const BASE = "https://maps.googleapis.com/maps/api/geocode/json";

const readBody = (body: GoogleResponse): GeocodeResult | null => {
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status !== "OK") {
    throw new Error(
      `Google geocoding failed: ${body.status ?? "unknown"}${body.error_message ? ` — ${body.error_message}` : ""}`,
    );
  }
  const top = body.results?.[0];
  const lat = top?.geometry?.location?.lat;
  const lng = top?.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng, formatted: top?.formatted_address };
};

export const googleGeocode = (cfg: GoogleConfig): GeocodeAdapter => {
  const call = async (params: Record<string, string>): Promise<GeocodeResult | null> => {
    const url = new URL(BASE);
    url.searchParams.set("key", cfg.apiKey);
    if (cfg.language) url.searchParams.set("language", cfg.language);
    if (cfg.region) url.searchParams.set("region", cfg.region);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url);
    // A transport-level failure still has to be distinguishable from
    // ZERO_RESULTS — never log the URL, it carries the key.
    if (!res.ok) throw new Error(`Google geocoding responded ${res.status}`);
    return readBody((await res.json()) as GoogleResponse);
  };

  return {
    provider: "google",
    geocode: (address) => call({ address }),
    reverse: (lat, lng) => call({ latlng: `${lat},${lng}` }),
  };
};
