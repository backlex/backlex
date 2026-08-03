import type { GeocodeAdapter } from "@backlex/core/adapters";

/**
 * The no-provider adapter — what a workspace gets when no geocoder is
 * configured.
 *
 * It resolves nothing, and that is deliberate. Storage falls back to the local
 * filesystem and vector search falls back to SQLite because those are
 * algorithms we can supply; a geocoder is a *dataset*, and there is no offline
 * one to fall back on. Guessing (a country centroid, the first row of some
 * built-in table) would put pins in real places that are wrong, which is worse
 * than an empty field an operator can see is empty.
 *
 * So it logs what was asked and returns `null` — the same "found nothing"
 * answer a real provider gives for an unplaceable address, which is the outcome
 * every caller already handles.
 */
export const consoleGeocode = (): GeocodeAdapter => ({
  provider: "console",
  async geocode(address) {
    // The address itself is not logged — it is somebody's home address on the
    // collections this feature targets, and a log line is read by more people
    // than a row is. Its LENGTH is enough to tell an empty compose from a real
    // one, which is the only thing this line is diagnostic for.
    console.log(`[geocode] no provider configured — cannot resolve an address (${address.length} chars)`);
    return null;
  },
  async reverse() {
    console.log("[geocode] no provider configured — cannot reverse a point");
    return null;
  },
});
