// Shared locale + time-zone helpers. Used by the workspace settings route
// (`routes/settings.ts`), the per-user preferences route (`routes/account.ts`)
// and the settings service so validation stays identical everywhere.
import { z } from "@hono/zod-openapi";

/** Fallback locale when neither the user nor the workspace has set one. */
export const DEFAULT_LOCALE = "en";
/** Fallback IANA time zone when neither the user nor the workspace set one. */
export const DEFAULT_TIMEZONE = "UTC";

/**
 * True when `tz` is an IANA time-zone name the runtime's Intl engine knows.
 * `Intl.DateTimeFormat` throws a `RangeError` for an unknown zone — the same
 * check works identically on Bun, Node and Cloudflare Workers.
 */
export const isValidTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** BCP-47-ish locale tag: a 2–3 letter language plus optional subtags
 *  (script / region / variant). Deliberately permissive — we only guard
 *  against junk, not validate every registered tag. */
export const localeCode = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, "Invalid locale code");

/** An IANA time-zone name accepted by the runtime's Intl engine. */
export const timeZoneCode = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Unknown IANA time zone");
