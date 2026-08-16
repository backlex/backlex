/**
 * Filling in the points of rows that have an address and no location.
 *
 * Lifted out of `routes/geo.ts` unchanged so the request path and the queued
 * path run the SAME body. They differ in exactly one thing — how many batches
 * they are allowed — and that is a parameter, not a second implementation. A
 * backfill is the operation in this repo whose scoping is easiest to get wrong
 * (see the permission note below), so having two copies of it was the shape
 * worth removing before adding a second caller.
 */
import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import { addressStringFor } from "./items/geocode";
import {
  deletedFilter,
  execute,
  pkEq,
  queryAll,
  tenantFilter,
  whereOf,
} from "./items/sql-helpers";
import { serialize } from "./items/serialize";
import type { SQL } from "drizzle-orm";
import type { ProgressReporter } from "./job-progress";
import { noProgress } from "./job-progress";

/** The subset of a loaded collection this needs. */
export interface GeoBackfillTarget {
  slug: string;
  physicalTable: string;
  pkColumn: string;
  fields: FieldDef[];
  tenantScoped: boolean;
  softDelete: boolean;
  adopted: boolean;
}

export interface GeoBackfillResult {
  /** Rows given a point by this call. */
  located: number;
  /** Rows the provider could not place — reported, not retried. */
  unresolved: number;
  /** Rows skipped because their address columns were all blank. */
  skipped: number;
  /** Rows still without a point after this call. */
  remaining: number;
  /** Batches actually run. Only interesting to the queued caller. */
  batches: number;
}

/** Refuse early, and by name, when nothing is configured — otherwise every
 *  address comes back unplaceable and the caller has no way to tell that from
 *  a provider that simply did not know the street. */
export const requireGeocodeProvider = (provider: string): void => {
  if (provider === "console") {
    throw new AppError(
      "UNAVAILABLE",
      "No geocoding provider is configured — set GEOCODE_GOOGLE_API_KEY, GEOCODE_MAPBOX_TOKEN, or GEOCODE_PROVIDER=nominatim",
    );
  }
};

/** Resolve and validate the geo field named by the caller. Shared so the queued
 *  path refuses the same inputs the request path refuses, at the same words. */
export const geoFieldOrThrow = (
  collection: { slug: string; fields: FieldDef[] },
  fieldName: string,
): FieldDef => {
  const field = collection.fields.find((f) => f.name === fieldName);
  if (!field || field.type !== "geo") {
    throw new AppError(
      "VALIDATION",
      `"${fieldName}" is not a geo field on "${collection.slug}"`,
    );
  }
  if (!field.geo?.geocodeFrom?.length) {
    throw new AppError(
      "VALIDATION",
      `"${fieldName}" has no \`geocodeFrom\` columns — nothing to derive a point from`,
    );
  }
  return field;
};

export interface GeoBackfillInput {
  collection: GeoBackfillTarget;
  field: FieldDef;
  /** Rows per batch. Bounded by the caller; the request path caps at 500. */
  batch: number;
  /** How many batches to run before answering. The request path passes 1 (its
   *  contract has always been "one bounded batch, here is what is left"); the
   *  queued path passes a budget and re-queues itself for the rest. */
  maxBatches: number;
  /** The caller's row-level `update` condition, resolved for THIS run. Never
   *  serialized into a job payload — see `services/jobs-run-as.ts`. */
  permWhere: SQL | null;
  tenantId: string | null;
  roles: string[];
  onProgress?: ProgressReporter;
}

/**
 * Run the backfill.
 *
 * Every statement below is scoped by the SAME four filters the item write path
 * uses, assembled once so the read, the write and the `remaining` count cannot
 * drift apart:
 *
 *  - `missing` — only fill a point that isn't there (never revise one);
 *  - `permWhere` — the caller's row-level `update` condition. Holding `update`
 *    on a collection is NOT the same as holding it on every row: the bundled
 *    self-service roles grant it conditioned on `app_user_id = $user.id`, so
 *    without this an end-user could geocode — and write to — every other
 *    customer's record in the workspace, and ship their addresses to a
 *    third-party provider on the way.
 *  - tenant scope — a backfill can never reach across workspaces;
 *  - soft-delete — a deleted row takes no writes.
 */
export const runGeoBackfill = async (
  ctx: Ctx,
  input: GeoBackfillInput,
): Promise<GeoBackfillResult> => {
  const { collection, field, permWhere, tenantId, roles } = input;
  const report = input.onProgress ?? noProgress;
  const table = sql.identifier(collection.physicalTable);
  const col = sql.identifier(field.name);
  // Kept byte-for-byte as the route wrote it. NB on Postgres a `geo` column is
  // `jsonb`, where `= ''` does not resolve — a pre-existing gap the SQLite-only
  // geo suite cannot see. Left alone deliberately: changing dialect-branching
  // SQL needs a Postgres spec to prove it, and that is not this change.
  const missing = sql`(${col} IS NULL OR ${col} = ${""})`;
  const scope = whereOf(
    missing,
    permWhere,
    tenantFilter(collection, { tenantId: tenantId ?? null, roles }),
    deletedFilter(collection),
  );

  let located = 0;
  let unresolved = 0;
  let skipped = 0;
  let batches = 0;
  /**
   * Rows already attempted that are STILL in scope.
   *
   * The reason a multi-batch loop needs a cursor at all, and the trap a naive
   * one falls into: a located row leaves the scope (it now has a point), but an
   * unresolved one — the provider did not know the street — and a blank-address
   * one both stay. So the next `SELECT … WHERE point IS NULL` hands back the
   * very rows that just failed, and the loop re-geocodes them forever, spending
   * a metered quota to learn the same thing. Stepping past them is what makes
   * the walk terminate AND makes it reach the rows behind them.
   *
   * The single-batch request path never met this, because it ran once and left
   * the looping to its caller — which is exactly why this only shows up now.
   */
  let offset = 0;

  for (let i = 0; i < input.maxBatches; i += 1) {
    // ORDER BY the primary key so the offset means something. The route ran one
    // unordered batch, where order was unobservable; a cursor over an unordered
    // result is not a cursor.
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${table} ${scope} ORDER BY ${sql.identifier(collection.pkColumn)} LIMIT ${input.batch} OFFSET ${offset}`,
    );
    if (rows.length === 0) break;
    batches += 1;
    let stayedInScope = 0;

    for (const row of rows) {
      const address = addressStringFor(field, row);
      if (!address) {
        skipped++;
        stayedInScope++;
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
        stayedInScope++;
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
          permWhere,
          tenantFilter(collection, { tenantId: tenantId ?? null, roles }),
          deletedFilter(collection),
        )}`,
      );
      located++;
    }

    offset += stayedInScope;

    // One write per BATCH, and it doubles as the lease heartbeat — a backfill
    // is exactly the shape that outlives a lease window. `total` is unknown
    // until the walk ends (rows leave the scope as they are located), so it is
    // reported as null rather than as a denominator that shrinks.
    await report({
      done: located + unresolved + skipped,
      total: null,
      phase: "geocode",
      note: `${collection.slug}.${field.name}`,
    });

    // A short batch is the end of the walk, not a reason to ask again.
    if (rows.length < input.batch) break;
  }

  // Counted through the same scope, so `remaining` reports what THIS caller
  // still has left rather than what the workspace does.
  const [left] = await queryAll<{ n: number }>(
    ctx,
    sql`SELECT COUNT(*) AS n FROM ${table} ${scope}`,
  );
  return { located, unresolved, skipped, remaining: Number(left?.n ?? 0), batches };
};
