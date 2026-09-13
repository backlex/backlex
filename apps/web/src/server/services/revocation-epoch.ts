/**
 * A revocation signal every isolate can hear, so a signed-out device stops
 * being served by the isolates that did not handle the sign-out.
 *
 * WHAT THIS EXISTS TO FIX (#319)
 *
 * `middleware/session.ts` answers an authenticated request from a per-isolate
 * `TtlLru` keyed on the signed session cookie, because better-auth's
 * `getSession` costs ~2 D1 round-trips. `revoke-others` deletes the session row
 * and calls `invalidateSession`, which clears that cache — but only in the
 * isolate that served the revoke. Cloudflare spawns isolates at colo scale, and
 * every OTHER one keeps serving the revoked cookie until its own entry lapses.
 *
 * That is the half `routes/auth/admin.ts` says it "cannot close from here".
 * This closes it.
 *
 * HOW, AND WHY IT IS NOT A DURABLE OBJECT
 *
 * One monotonic number in `app_settings` under the `_global` tier. Revocation
 * bumps it; a reader compares it against the epoch each cache entry was stored
 * with, and treats anything older as a miss — which falls through to the
 * authoritative session read.
 *
 * A Durable Object was the obvious reach (`RATE_LIMIT` is the precedent) and is
 * the wrong tool here. It would need a new class, a `[[migrations]]` entry, a
 * binding in four deploy configs, and a second code path for the three runtimes
 * that have no DO — and it would buy nothing this does not: the poll below is
 * what bounds the staleness, not the storage behind it. `app_settings` already
 * exists on both dialects and behaves identically on Workers, Bun, Vercel and
 * Netlify, so there is one path to reason about and the ordinary test harness
 * drives it.
 *
 * WHAT IT COSTS, AND WHAT IT DOES NOT BUY
 *
 * The read is memoized per isolate for `EPOCH_TTL_MS`, so a busy isolate makes
 * ONE extra SELECT per second no matter how much traffic it serves, and a cold
 * one makes exactly one. It does not scale with request rate.
 *
 * And it is a bound, not a zero: a device can be served for up to
 * `EPOCH_TTL_MS` after the revocation commits, because that is how long a
 * neighbouring isolate may go on believing a stale epoch. Anything claiming
 * "immediate" would have to consult a shared store on EVERY request, which is
 * the cost the session cache exists to avoid. ~90s → ~1s is the honest figure.
 */
import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
/** The minimum this file needs. Narrower than `Ctx` on purpose: the app-plane
 *  reader (`middleware/session.ts::appSessionOwner`) is handed exactly this
 *  shape by `routes/realtime/index.ts` and cannot produce a full `Ctx`. */
interface EpochCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

/** The `app_settings` row this lives in. `_global` is the instance-wide tier's
 *  sentinel — an ordinary value, so it conflicts like any other key and the
 *  upsert below is race-free. See `routes/settings.ts`. */
const GLOBAL = "_global";
const KEY = "sessionRevocationEpoch";

/**
 * How long an isolate may go on trusting its last reading.
 *
 * This IS the revocation lag, so it is the only number worth arguing about.
 * One second costs at most one SELECT per isolate per second — invisible next
 * to the ~2 D1 round-trips it saves on every cache hit in that same second.
 * Lowering it approaches "a read per request", which is the thing the session
 * cache exists to prevent; raising it re-opens the window this closes.
 */
export const EPOCH_TTL_MS = 1_000;

const table = (dialect: string) =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

/** Per-isolate memo. Module-level on purpose — it must survive across requests
 *  in the same isolate, which is the entire point. */
let memo: { value: number; readAt: number } | null = null;

/** Reset the memo. Tests only: an isolate is long-lived in production and this
 *  would defeat the poll. */
export const __resetEpochMemo = (): void => {
  memo = null;
};

/**
 * The current epoch, read at most once per {@link EPOCH_TTL_MS} per isolate.
 *
 * Returns `null` when it cannot be read. The caller treats that as "do not
 * trust the cache" and falls through to the session read — degraded (an extra
 * read per request) rather than either unsafe or down. A blanket refusal would
 * be a blackout on a transient DB blip; serving from a cache that might be
 * stale is the thing this file exists to stop.
 */
export const revocationEpoch = async (ctx: EpochCtx): Promise<number | null> => {
  const now = Date.now();
  if (memo && now - memo.readAt < EPOCH_TTL_MS) return memo.value;
  const t = table(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select({ value: t.value })
      .from(t)
      .where(and(eq(t.tenantId, GLOBAL), eq(t.key, KEY)))
      .limit(1)) as { value: unknown }[];
    // Absent is a legitimate reading, not a failure: an instance where nothing
    // has ever been revoked has no row, and 0 is older than every stamp.
    const value = Number(rows[0]?.value ?? 0);
    memo = { value: Number.isFinite(value) ? value : 0, readAt: now };
    return memo.value;
  } catch {
    return null;
  }
};

/**
 * Bump the epoch so every isolate drops its cached sessions within
 * {@link EPOCH_TTL_MS}.
 *
 * `Date.now()` rather than an increment: it needs no read-modify-write, so two
 * concurrent revocations cannot lose one another, and a clock that jumps
 * backwards costs at most a stale window rather than a permanently-low
 * counter. `Math.max` against the memo keeps it monotonic within an isolate
 * even then.
 *
 * Deliberately GLOBAL rather than per-user. A per-user epoch would need a read
 * keyed on the user, i.e. one that cannot be shared across requests, which puts
 * the read back on the hot path. Revocations are rare and a flush costs one
 * session read per live cookie, so the blunt instrument is the cheap one.
 */
export const bumpRevocationEpoch = async (ctx: EpochCtx): Promise<void> => {
  const t = table(ctx.dialect);
  const value = Math.max(Date.now(), (memo?.value ?? 0) + 1);
  const updatedAt = new Date();
  await (ctx.db as any)
    .insert(t)
    .values({ id: crypto.randomUUID(), tenantId: GLOBAL, key: KEY, value, updatedAt })
    .onConflictDoUpdate({ target: [t.tenantId, t.key], set: { value, updatedAt } });
  // The revoking isolate should not wait out its own poll.
  memo = { value, readAt: Date.now() };
};
