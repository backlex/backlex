/**
 * Enforce the plane declared for each route in `lib/route-planes.ts`.
 *
 * WHAT THIS REPLACES
 *
 * Today the boundary between the two auth planes holds almost everywhere by
 * ACCIDENT: `tenantMiddleware` leaves `auth.roles` empty for `plane === "app"`,
 * so `requireAdminMw` denies. `requireUser` alone checks only `auth.userId`,
 * which an `app_users` id satisfies exactly as well as a `users` id. The gate
 * written for this — `requirePlatformMw` — sits on a handful of route files out
 * of ~110 mount prefixes.
 *
 * An invariant upheld by an empty array is one line from being undone, and the
 * line in question is in a different file. So this middleware asks the question
 * once, centrally, from a table that a test proves is complete.
 *
 * WHY IT DOES NOT REPLACE THE PER-ROUTE GATES
 *
 * `requirePlatformMw` stays where it already is, and Phase 2 adds it to three
 * more routes. Two layers is deliberate: this one is broad and driven by a
 * table, those are narrow and driven by the handler's own reading of what it
 * does. The audit's lesson was that ONE layer being right is what let four
 * layers be wrong.
 *
 * FAIL-OPEN, ON PURPOSE, FOR ONE RELEASE
 *
 * `PLANE_GUARD` defaults to `"warn"`: a violation is logged with everything
 * needed to identify it and the request proceeds. That is not timidity about
 * the rule — it is that the rule is new and the table is a first draft, and an
 * `enforce` default would turn any mistake in it into an outage for a paying
 * tenant on the release that ships it. The warn window is where the mistakes
 * surface. Set `PLANE_GUARD=enforce` to close it.
 *
 * The one thing `warn` must never do is stay quiet. A guard that matches
 * nothing reports success, and this repo has shipped that failure before — so
 * the log line is emitted at WARN with the path, the plane it declared, the
 * plane the caller actually holds, and the identity, and `route-planes.test.ts`
 * asserts a violation is observable rather than trusting that it would be.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { planeFor, type RoutePlane } from "../lib/route-planes";

/** What the declared plane admits, given the caller's actual plane. */
const admits = (declared: RoutePlane, caller: "platform" | "app"): boolean => {
  switch (declared) {
    case "platform":
      return caller === "platform";
    case "app":
      return caller === "app";
    // `public` routes authenticate their own callers by other means — a signing
    // secret, an ingest key, a token in the path — and are reachable with no
    // session at all. Both planes may hold one incidentally (an operator IS a
    // person who can load the sign-in page), so neither is refused here.
    case "public":
      return true;
    case "either":
      return true;
  }
};

export const planeFirewall: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  // An unauthenticated request carries no plane to be wrong about. Whether it
  // may proceed is the route's own question, and `requireUser` is what asks it.
  if (!auth?.userId) return next();

  const path = new URL(c.req.url).pathname;
  const entry = planeFor(path);
  // No entry means the path is outside the /api surface this table covers
  // (`/health`, `/embed/*`, the SPA fallback). `route-plane-registry.test.ts`
  // is what guarantees a NEW /api mount cannot land here silently — this
  // middleware deliberately does not fail closed on an unknown path, because
  // doing so would take the site down for a typo in a table nothing else reads.
  if (!entry) return next();

  const caller = auth.plane === "app" ? "app" : "platform";
  if (admits(entry.plane, caller)) return next();

  const mode = c.get("ctx")?.env?.PLANE_GUARD ?? "warn";
  const detail = {
    msg: "plane-violation",
    path,
    prefix: entry.prefix,
    declared: entry.plane,
    caller,
    userId: auth.userId,
    tenantId: auth.tenantId ?? null,
    // Which credential got here matters for triage: a cookie means a browser
    // reached it, a `pak_` key means a machine did, and the two have different
    // blast radii.
    apiKeyId: auth.apiKeyId ?? null,
    mode,
  };

  if (mode === "enforce") {
    console.warn(JSON.stringify({ level: "warn", ...detail, action: "refused" }));
    throw new AppError(
      "FORBIDDEN",
      caller === "app"
        ? "Operator access required"
        : "Workspace end-user sign-in required",
    );
  }

  console.warn(JSON.stringify({ level: "warn", ...detail, action: "allowed" }));
  return next();
};
