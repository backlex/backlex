/**
 * Geocoding — turning a written address into a point, and back.
 *
 * The adapter exists because fifteen of the schema templates already hold an
 * address as text, and asking their owners to retype it as coordinates is not a
 * migration path. A `geo` field with `geocodeFrom` set fills itself in from the
 * columns that are already there.
 *
 * Like `SMSAdapter`, a deployment resolves to exactly ONE provider — there is
 * no composite. Unlike storage or vector, there is no self-hosted default: a
 * geocoder is a dataset, not an algorithm, so the only honest fallback is the
 * `console` adapter, which resolves nothing and says so.
 */

export type GeocodeProvider = "nominatim" | "google" | "mapbox" | "console";

/** A geocoding result — the point, plus what the provider thought it matched. */
export interface GeocodeResult {
  lat: number;
  lng: number;
  /**
   * The provider's canonical rendering of the place it matched, which is often
   * not the string that was sent. Worth surfacing: it is the only way an
   * operator can tell "Springfield" resolved to the wrong Springfield.
   */
  formatted?: string;
  /**
   * Rough confidence, 0–1, when the provider expresses one. Providers disagree
   * about what the number means, so it is advisory — used to LABEL a result in
   * the admin, never to silently discard one.
   */
  confidence?: number;
}

export interface GeocodeAdapter {
  /**
   * Resolve a written address to a point. Returns `null` when the provider
   * found nothing — an address it cannot place is a normal outcome, not an
   * error, and a write that requested a geocode still succeeds without one.
   *
   * Throws only when the PROVIDER failed (network, auth, quota). The caller
   * distinguishes: a null is recorded and moved past, a throw is surfaced.
   */
  geocode(address: string): Promise<GeocodeResult | null>;
  /**
   * The inverse — a point to the address it falls in. Optional: not every
   * provider offers it, and nothing in the write path depends on it (it backs
   * the admin's "what is here?" affordance when a pin is dragged).
   */
  reverse?(lat: number, lng: number): Promise<GeocodeResult | null>;
  /** Which provider this is, for diagnostics and the admin's status panel. */
  readonly provider: GeocodeProvider;
}
