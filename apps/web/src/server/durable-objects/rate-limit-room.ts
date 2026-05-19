/**
 * Centralized fixed-window rate-limit counter, one Durable Object per logical
 * key (the limiter key — `auth:signin:<ip>`, `pub:<channel>:<ip>`, …).
 *
 * The in-memory limiter in `lib/rate-limit.ts` is per-isolate; Cloudflare can
 * spin up many isolates per colo and rotate them aggressively, so an attacker
 * who scatters requests across isolates effectively gets `max × isolates` of
 * budget before any single counter notices. Routing each `(key, window)`
 * through a Durable Object collapses the count back to a single authoritative
 * counter — every request for the same key lands in the same DO, regardless
 * of which isolate served the incoming HTTP request.
 *
 * Protocol: POST /check with `{ max, windowMs }` → `{ allowed, remaining,
 * resetAt }`. The DO stores one row (`"w"`) and schedules an alarm to delete
 * it once the window expires so storage stays bounded.
 *
 * Falls back to in-memory on runtimes without the `RATE_LIMIT` binding (Bun,
 * Vercel, Netlify, tests) — see `lib/rate-limit.ts::rateLimitOk`.
 */

interface Window {
  count: number;
  /** Epoch ms at which the window expires. */
  resetAt: number;
}

interface CheckRequest {
  max: number;
  windowMs: number;
}

interface CheckResponse {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/** How long after `resetAt` to fire the GC alarm. A small buffer avoids a
 *  race where the alarm fires before a final in-flight check sees the row. */
const ALARM_LAG_MS = 1_000;

export class RateLimitRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/check" || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    let body: CheckRequest;
    try {
      body = (await req.json()) as CheckRequest;
    } catch {
      return new Response("invalid body", { status: 400 });
    }
    const max = Number(body.max);
    const windowMs = Number(body.windowMs);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      return new Response("invalid max/windowMs", { status: 400 });
    }

    const now = Date.now();
    const existing = await this.state.storage.get<Window>("w");

    // No live window — start fresh and arm the GC alarm.
    if (!existing || existing.resetAt <= now) {
      const next: Window = { count: 1, resetAt: now + windowMs };
      await this.state.storage.put("w", next);
      await this.state.storage.setAlarm(next.resetAt + ALARM_LAG_MS);
      return Response.json({
        allowed: true,
        remaining: Math.max(0, max - 1),
        resetAt: next.resetAt,
      } satisfies CheckResponse);
    }

    // Window exhausted — reject without incrementing further (so a flood
    // doesn't extend the effective rejection beyond `resetAt`).
    if (existing.count >= max) {
      return Response.json({
        allowed: false,
        remaining: 0,
        resetAt: existing.resetAt,
      } satisfies CheckResponse);
    }

    const next: Window = { count: existing.count + 1, resetAt: existing.resetAt };
    await this.state.storage.put("w", next);
    return Response.json({
      allowed: true,
      remaining: Math.max(0, max - next.count),
      resetAt: existing.resetAt,
    } satisfies CheckResponse);
  }

  /** Window expired — drop the row so storage doesn't grow with stale keys. */
  async alarm() {
    const w = await this.state.storage.get<Window>("w");
    if (!w || w.resetAt <= Date.now()) {
      await this.state.storage.delete("w");
    } else {
      // A new window started after this alarm was scheduled — reschedule to
      // the live window's reset (shouldn't normally happen, the fetch path
      // rearms on every fresh window, but cheap to be defensive).
      await this.state.storage.setAlarm(w.resetAt + ALARM_LAG_MS);
    }
  }
}
