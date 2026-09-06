import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requirePermission } from "../middleware/permission";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { collectionFromParam, loadCollection } from "../services/items/collection-loader";
import {
  geoFieldOrThrow,
  requireGeocodeProvider,
  runGeoBackfill,
} from "../services/geo-backfill";
import { startLongJob } from "../services/jobs-long-running";
import { keepAlive } from "../services/activity";

/**
 * Geocoding endpoints — turning an address into a point on demand, and filling
 * in the rows that already existed.
 *
 * `geocode` / `reverse` are lookups the ADMIN drives: an operator types an
 * address and the map moves, or drags a pin and the address appears. They are
 * gated on being signed in rather than on a collection permission, because they
 * touch no row — but not left public, because they spend a metered third-party
 * quota and an open one is someone else's free geocoding proxy.
 *
 * `backfill` is the counterpart to `sequences/sync`: the write path deliberately
 * does NOT geocode during bulk imports, and an adopted table arrives with
 * addresses and no points at all. Without this, "turn on geocoding" would only
 * ever apply to rows written afterwards, and every historical row would stay
 * invisible to `_near` forever — the failure being that proximity search
 * silently answers with a fraction of the data.
 */

const PointOut = z
  .object({
    lat: z.number(),
    lng: z.number(),
    formatted: z.string().optional(),
    confidence: z.number().optional(),
  })
  .openapi("GeocodeResult");

/**
 * Per-caller budget on the two routes that spend the OPERATOR's geocoding
 * quota.
 *
 * `/geocode` and `/reverse` carry `requireUser` and nothing else, and
 * `lib/route-planes.ts` described the prefix as a "permission-gated geocoding
 * helper" — a guard the two provider-calling verbs did not have. The sibling
 * `/backfill/{slug}` DOES carry `requirePermission`, so the omission reads as
 * per-verb drift rather than a policy, and anyone auditing from the table would
 * conclude it was covered.
 *
 * A rate limit rather than a plane gate, deliberately. The exposure is BUDGET,
 * not data: the reply is a public address-to-point lookup, and the note's claim
 * that field editors on both planes use it is a real product shape that a
 * `requirePlatformMw` would break. What must not be possible is looping it —
 * every call reaches a third-party provider on the operator's billing account.
 *
 * Keyed on the identity, falling back to the workspace, so one workspace's
 * end-users cannot spend another's share.
 */
const GEO_LOOKUPS_PER_MINUTE = 60;
const GEO_WINDOW_MS = 60_000;

const assertGeoBudget = async (c: Context<AppBindings>): Promise<void> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const who = auth?.userId ?? auth?.tenantId ?? "anon";
  const ok = await rateLimitOk(
    ctx.env,
    `geo-lookup:${who}`,
    GEO_LOOKUPS_PER_MINUTE,
    GEO_WINDOW_MS,
  );
  if (!ok) {
    throw new AppError(
      "RATE_LIMITED",
      `Too many geocoding lookups — the limit is ${GEO_LOOKUPS_PER_MINUTE} per minute.`,
    );
  }
};

export const geoRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "post",
      path: "/geocode",
      tags: ["geo"],
      summary: "Resolve an address to a point",
      description:
        "Ask the configured geocoding provider to place a written address. Returns `null` data when the provider found nothing — an unplaceable address is a normal answer, not an error. Fails with 503 when no provider is configured.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ address: z.string().min(1).max(500) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: PointOut.nullable(), provider: z.string() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      requireGeocodeProvider(ctx.geocode.provider);
      await assertGeoBudget(c);
      const { address } = c.req.valid("json");
      const data = await ctx.geocode.geocode(address);
      return c.json({ data, provider: ctx.geocode.provider });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/reverse",
      tags: ["geo"],
      summary: "Resolve a point to an address",
      description:
        "The inverse lookup — what address is at these coordinates. Not every provider offers it; returns 503 when the active one does not.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                lat: z.number().min(-90).max(90),
                lng: z.number().min(-180).max(180),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: PointOut.nullable(), provider: z.string() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      requireGeocodeProvider(ctx.geocode.provider);
      if (!ctx.geocode.reverse) {
        throw new AppError(
          "UNAVAILABLE",
          `The ${ctx.geocode.provider} geocoder does not support reverse lookup`,
        );
      }
      await assertGeoBudget(c);
      const { lat, lng } = c.req.valid("json");
      const data = await ctx.geocode.reverse(lat, lng);
      return c.json({ data, provider: ctx.geocode.provider });
    },
  )
  /**
   * Fill in the points of rows that have an address and no location.
   *
   * Bounded on purpose. `limit` caps the provider calls one request may make
   * (default 50, hard ceiling 500) because the public Nominatim rate-limits to
   * roughly one request a second, and an unbounded backfill over a large
   * collection is a request that cannot finish. The response reports what was
   * done and what is left, so a caller loops until `remaining` is zero and can
   * see the cost as it goes — rather than firing one call that times out and
   * leaves the collection in an unknown state.
   *
   * Only ever fills a point that is MISSING. It never revises one that is
   * already there, so running it twice is safe and running it after an operator
   * has hand-corrected a pin does not undo their correction.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/backfill/{slug}",
      tags: ["geo"],
      summary: "Geocode existing rows that have no point",
      description:
        "Resolve the `geocodeFrom` address of every row whose geo field is still empty, in bounded batches. Never overwrites a point that is already set. Requires update permission on the collection.",
      security: SECURITY,
      // The collection is a PATH segment, not a body key, so the permission
      // middleware can resolve it — middleware runs before the body validator,
      // and `c.req.valid("json")` is empty there.
      middleware: [requireUser, requirePermission(collectionFromParam, "update")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({
          async: z.enum(["0", "1"]).optional().openapi({
            description:
              "`1` runs the backfill as a durable background job instead of one bounded batch: it works through the collection across as many batches as it takes, queueing its own continuation, and answers 202 with a `jobId` you watch on `GET /api/jobs/{id}`. The job re-resolves `update` on the collection each time it runs, so a revoked grant stops it mid-way. Not available to API keys, workspace end-users or impersonation sessions.",
          }),
        }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                field: z.string().min(1),
                limit: z.number().int().min(1).max(500).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  /** Rows given a point by this call. */
                  located: z.number().int(),
                  /** Rows the provider could not place — reported, not retried. */
                  unresolved: z.number().int(),
                  /** Rows skipped because their address columns were all blank. */
                  skipped: z.number().int(),
                  /** Rows still without a point after this call. */
                  remaining: z.number().int(),
                }),
              }),
            },
          },
        },
        202: {
          description: "Queued",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  jobId: z.string(),
                  status: z.string(),
                  field: z.string(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireGeocodeProvider(ctx.geocode.provider);
      const { slug } = c.req.valid("param");
      const { field: fieldName, limit } = c.req.valid("json");
      const collection = await loadCollection(ctx, auth.tenantId, slug);
      const field = geoFieldOrThrow(collection, fieldName);

      if (c.req.query("async") === "1") {
        const { jobId } = await startLongJob(ctx, {
          type: "geo.backfill",
          auth,
          payload: { slug, field: fieldName, batch: limit ?? 50 },
          background: (p) => keepAlive(c, p),
        });
        return c.json(
          { data: { jobId, status: "queued" as const, field: fieldName } },
          202,
        );
      }

      // One bounded batch, exactly as this endpoint has always answered — the
      // caller loops and can see the cost as it goes. The body is shared with
      // the queued path (`services/geo-backfill.ts`), which differs only in how
      // many batches it is allowed.
      const perm = c.get("permission");
      const { located, unresolved, skipped, remaining } = await runGeoBackfill(ctx, {
        collection,
        field,
        batch: Math.min(limit ?? 50, 500),
        maxBatches: 1,
        permWhere: perm.whereSql,
        tenantId: auth.tenantId ?? null,
        roles: auth.roles,
      });
      // Explicit `200`: with a 202 also declared, a bare `c.json(x)` widens the
      // inferred status to the union and the compiler asks this body to satisfy
      // the queued shape too.
      return c.json({ data: { located, unresolved, skipped, remaining } }, 200);
    },
  );
