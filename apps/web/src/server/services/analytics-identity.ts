/**
 * Cookieless visitor identity for the web tag.
 *
 * The tag stores nothing on the visitor's device — no cookie, no
 * `localStorage`, no `sessionStorage`. The visitor id is derived server-side
 * from things the request already carries, and it changes every UTC midnight.
 *
 * ── Why the salt is DERIVED and not generated ──────────────────────────────
 * Plausible, the design this follows, keeps a random daily salt in one
 * process's memory. That works because it is one process. backlex answers the
 * same workspace from many Workers isolates and many serverless invocations,
 * and a per-process random salt would give one visitor a DIFFERENT id in each
 * of them — identity would shatter within a single day, in a way that looks
 * like traffic growth rather than a bug. So the salt is a pure function of a
 * server secret and the UTC day: every isolate independently computes the same
 * value, and it still rotates.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 * The operator holds the secret, so the operator could in principle recompute
 * an id from an IP and user-agent they already had. That makes this
 * **pseudonymous, not anonymous**, and the docs must say the second word and
 * not the first. What it does buy is real: no device storage, no consent
 * banner for it, and no id that survives the day.
 *
 * Consequences to state rather than hide:
 *  - At 00:00 UTC every visitor becomes new, and a session spanning midnight
 *    splits in two.
 *  - Rotating `ANALYTICS_SALT` resets every visitor identity at once.
 *  - Cohort retention and multi-day funnels cannot use these ids — see
 *    `durableOnly()` in `analytics.ts`.
 */
import type { Env } from "../env";
import { utcDay } from "./analytics";

/** `sha256` → lowercase hex. */
const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

/**
 * Per-isolate memo of the day's salt.
 *
 * Keyed by day so the entry for a stale day is replaced rather than served —
 * a long-lived isolate crossing midnight must not keep yesterday's salt, which
 * would leave that isolate's visitors mismatched against every other isolate's
 * for the rest of the day.
 */
let saltCache: { day: string; value: string } | null = null;

export const dailySalt = async (env: Env, nowMs: number): Promise<string> => {
  const day = utcDay(nowMs);
  if (saltCache?.day === day) return saltCache.value;

  // `ANALYTICS_SALT` lets an operator rotate visitor identity without touching
  // the auth secret. Falling back to `AUTH_SECRET` means the feature works out
  // of the box; both are server-side secrets that never leave the process.
  const secret = env.ANALYTICS_SALT || env.AUTH_SECRET || "";
  const value = await sha256Hex(`backlex-analytics-salt:${secret}:${day}`);
  saltCache = { day, value };
  return value;
};

/** Test seam: drop the memo so a spec can cross a day boundary in-process. */
export const __resetSaltCacheForTests = (): void => {
  saltCache = null;
};

/**
 * The visitor id for one request, in the cookieless lane.
 *
 * The IP and user-agent are inputs to a hash and are never stored — no column
 * on `analytics_events` holds either. Truncated to 32 hex chars (128 bits),
 * which is far past collision concerns for a day's traffic and keeps the
 * column narrow on the highest-volume table in the product.
 *
 * `siteId` is mixed in so the same person visiting two of a workspace's sites
 * is two visitors rather than one — matching what a per-property analytics
 * tool reports, and avoiding a cross-site identifier we have no reason to
 * build.
 */
export const dailyVisitorId = async (
  env: Env,
  opts: { tenantId: string | null; siteId: string; ip: string | null; userAgent: string | null },
  nowMs: number,
): Promise<string> => {
  const salt = await dailySalt(env, nowMs);
  const parts = [
    salt,
    opts.tenantId ?? "_default",
    opts.siteId,
    opts.ip ?? "no-ip",
    (opts.userAgent ?? "no-ua").slice(0, 512),
  ];
  return (await sha256Hex(parts.join("|"))).slice(0, 32);
};
