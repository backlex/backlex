import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requirePermission } from "../middleware/permission";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { collectionFromParam, loadCollection } from "../services/items/collection-loader";
import { addressStringFor } from "../services/items/geocode";
import {
  deletedFilter,
  execute,
  pkEq,
  queryAll,
  tenantFilter,
  whereOf,
} from "../services/items/sql-helpers";
import { serialize } from "../services/items/serialize";

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
      requireProvider(ctx.geocode.provider);
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
      requireProvider(ctx.geocode.provider);
      if (!ctx.geocode.reverse) {
        throw new AppError(
          "UNAVAILABLE",
          `The ${ctx.geocode.provider} geocoder does not support reverse lookup`,
        );
      }
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
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireProvider(ctx.geocode.provider);
      const { slug } = c.req.valid("param");
      const { field: fieldName, limit } = c.req.valid("json");
      const collection = await loadCollection(ctx, auth.tenantId, slug);
      const field = collection.fields.find((f) => f.name === fieldName);
      if (!field || field.type !== "geo") {
        throw new AppError("VALIDATION", `"${fieldName}" is not a geo field on "${slug}"`);
      }
      if (!field.geo?.geocodeFrom?.length) {
        throw new AppError(
          "VALIDATION",
          `"${fieldName}" has no \`geocodeFrom\` columns — nothing to derive a point from`,
        );
      }

      const table = sql.identifier(collection.physicalTable);
      const col = sql.identifier(fieldName);
      // Every statement below is scoped by the SAME four filters the item write
      // path uses, assembled once so the read, the write and the `remaining`
      // count cannot drift apart:
      //
      //  - `missing` — only fill a point that isn't there (never revise one);
      //  - `perm.whereSql` — the caller's row-level `update` condition. Holding
      //    `update` on a collection is NOT the same as holding it on every row:
      //    the bundled self-service roles grant it conditioned on
      //    `app_user_id = $user.id`, so without this an end-user could geocode —
      //    and write to — every other customer's record in the workspace, and
      //    ship their addresses to a third-party provider on the way.
      //  - tenant scope — a backfill can never reach across workspaces;
      //  - soft-delete — a deleted row takes no writes.
      const perm = c.get("permission");
      const missing = sql`(${col} IS NULL OR ${col} = ${""})`;
      const scope = whereOf(
        missing,
        perm.whereSql,
        tenantFilter(collection, { tenantId: auth.tenantId ?? null, roles: auth.roles }),
        deletedFilter(collection),
      );

      const batch = Math.min(limit ?? 50, 500);
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${table} ${scope} LIMIT ${batch}`,
      );

      let located = 0;
      let unresolved = 0;
      let skipped = 0;
      for (const row of rows) {
        const address = addressStringFor(field, row);
        if (!address) {
          skipped++;
          continue;
        }
        let hit: Awaited<ReturnType<typeof ctx.geocode.geocode>> = null;
        try {
          hit = await ctx.geocode.geocode(address);
        } catch (e) {
          // A provider failure mid-batch stops the run rather than burning the
          // rest of the budget on calls that will fail the same way — and the
          // rows already located stay located, because each one was its own
          // statement.
          throw new AppError(
            "INTERNAL",
            `Geocoding failed after ${located} row(s): ${(e as Error).message}`,
          );
        }
        if (!hit) {
          unresolved++;
          continue;
        }
        // Written straight to the column rather than through `performUpdate`:
        // this fills a value the row was missing, and routing it through the
        // item write path would fire hooks, webhooks, realtime events and a
        // revision for every row of a bulk repair.
        const value = serialize({ lat: hit.lat, lng: hit.lng }, "geo", ctx.dialect);
        // The row came out of a scoped SELECT, but the UPDATE re-states the
        // whole scope rather than trusting that: the two run in separate
        // statements, and an id is not an authorization.
        await execute(
          ctx,
          sql`UPDATE ${table} SET ${col} = ${value} ${whereOf(
            pkEq(collection.pkColumn, String(row[collection.pkColumn] ?? "")),
            perm.whereSql,
            tenantFilter(collection, { tenantId: auth.tenantId ?? null, roles: auth.roles }),
            deletedFilter(collection),
          )}`,
        );
        located++;
      }

      // Counted through the same scope, so `remaining` reports what THIS caller
      // still has left rather than what the workspace does.
      const [left] = await queryAll<{ n: number }>(
        ctx,
        sql`SELECT COUNT(*) AS n FROM ${table} ${scope}`,
      );
      return c.json({
        data: { located, unresolved, skipped, remaining: Number(left?.n ?? 0) },
      });
    },
  );

/** Refuse early, and by name, when nothing is configured — otherwise every
 *  address comes back unplaceable and the caller has no way to tell that from
 *  a provider that simply did not know the street. */
const requireProvider = (provider: string): void => {
  if (provider === "console") {
    throw new AppError(
      "UNAVAILABLE",
      "No geocoding provider is configured — set GEOCODE_GOOGLE_API_KEY, GEOCODE_MAPBOX_TOKEN, or GEOCODE_PROVIDER=nominatim",
    );
  }
};
