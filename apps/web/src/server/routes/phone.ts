import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type SQL, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { parsePhoneForField } from "@backlex/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requirePermission } from "../middleware/permission";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { collectionFromParam, loadCollection } from "../services/items/collection-loader";
import { resolveRowRegion } from "../services/items/phone-fields";
import {
  deletedFilter,
  execute,
  pkEq,
  queryAll,
  tenantFilter,
  whereOf,
} from "../services/items/sql-helpers";

/**
 * Normalizing the phone numbers that were already there.
 *
 * The write path canonicalizes everything from now on, which fixes exactly one
 * half of the problem: the rows written from now on. The other half is every row
 * a workspace already has — thirty-six template columns' worth of
 * `0532 111 22 33` and `(415) 555-2671`, plus whatever an adopted table arrived
 * carrying. Without this, turning a column into a phone field would leave a
 * collection where SOME numbers are dialable and some are not, with nothing in
 * the data to say which — the worst of both states, because `unique` and
 * lookup-by-number would appear to work while quietly missing the old rows.
 *
 * The counterpart to `sequences/sync` and `geo/backfill`, and it makes the same
 * two promises they do: it moves values only in the one direction that is safe,
 * and it REPORTS what it could not read rather than guessing at it.
 */

/**
 * Paged by a keyset cursor rather than by "how many are left".
 *
 * `geo/backfill` can count what remains because it only ever touches rows whose
 * point is NULL, and a row it fixes leaves the set. Here every non-empty value
 * is a candidate — an already-canonical row stays a candidate forever — so a
 * `remaining` count would never reach zero and a caller looping on it would
 * re-scan the same first page until it gave up. The cursor walks the table once,
 * in primary-key order, and comes back null at the end.
 *
 * It also sidesteps trying to express "is this already canonical" as a portable
 * SQL predicate: that needs `LIKE` patterns, and D1 refuses to bind them.
 */
export const phoneRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "post",
    path: "/normalize/{slug}",
    tags: ["phone"],
    summary: "Rewrite existing phone values to canonical E.164",
    description:
      "Walk a collection in primary-key order and rewrite every value of a `phone` field into E.164, in bounded pages. Values already canonical are left untouched; values that cannot be read as a phone number are reported by row id and left exactly as they are. Loop while `cursor` is non-null. Requires update permission on the collection.",
    security: SECURITY,
    // The collection is a PATH segment so the permission middleware can resolve
    // it — middleware runs before the body validator.
    middleware: [requireUser, requirePermission(collectionFromParam, "update")],
    request: {
      params: z.object({ slug: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              field: z.string().min(1),
              limit: z.number().int().min(1).max(2000).optional(),
              /** Primary key the previous page stopped at. Omit for the first. */
              after: z.string().max(200).optional(),
              /**
               * Report what WOULD change without writing anything. The honest
               * first move on a collection whose contents nobody is sure of —
               * and the only way to find out how many rows are unreadable before
               * committing to a pass that rewrites the rest.
               */
              dryRun: z.boolean().optional(),
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
                /** Rows examined by this call. */
                scanned: z.number().int(),
                /** Rows rewritten (or, on a dry run, that would be). */
                normalized: z.number().int(),
                /** Rows whose value was already exactly canonical. */
                alreadyCanonical: z.number().int(),
                /** Rows whose value could not be read as a phone number. */
                unreadable: z.number().int(),
                /**
                 * Ids of those rows, so an operator can go and look at them.
                 * The VALUES are deliberately not returned: this response is a
                 * plausible thing to log, and every one of them is a real
                 * person's phone number. Capped so one page cannot answer with
                 * the whole table.
                 */
                unreadableIds: z.array(z.string()),
                /** Pass back as `after` for the next page; null at the end. */
                cursor: z.string().nullable(),
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
    const { slug } = c.req.valid("param");
    const { field: fieldName, limit, after, dryRun } = c.req.valid("json");
    const collection = await loadCollection(ctx, auth.tenantId, slug);
    const field = collection.fields.find((f) => f.name === fieldName);
    if (!field || field.type !== "phone") {
      throw new AppError("VALIDATION", `"${fieldName}" is not a phone field on "${slug}"`);
    }

    const table = sql.identifier(collection.physicalTable);
    const col = sql.identifier(fieldName);
    const pk = sql.identifier(collection.pkColumn);
    // The same scope the item write path applies, assembled once so the SELECT
    // and every UPDATE below cannot drift apart:
    //
    //  - non-empty — an absent number is not a number to fix;
    //  - `perm.whereSql` — the caller's row-level `update` condition. Holding
    //    `update` on a collection is NOT holding it on every row: the bundled
    //    self-service roles grant it conditioned on `app_user_id = $user.id`, so
    //    without this an end-user could rewrite — and, through `unreadableIds`,
    //    enumerate — every other customer's record in the workspace.
    //  - tenant scope — normalization can never reach across workspaces;
    //  - soft-delete — a deleted row takes no writes.
    const perm = c.get("permission");
    const authScope = { tenantId: auth.tenantId ?? null, roles: auth.roles };
    const baseScope = (extra?: SQL | undefined) =>
      whereOf(
        sql`(${col} IS NOT NULL AND ${col} <> ${""})`,
        extra,
        perm.whereSql,
        tenantFilter(collection, authScope),
        deletedFilter(collection),
      );

    const batch = Math.min(limit ?? 500, 2000);
    // `after` is compared, never interpolated, and it is bound like any other
    // value — an id from a previous page is caller-supplied data.
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${table} ${baseScope(
        after === undefined ? undefined : sql`${pk} > ${after}`,
      )} ORDER BY ${pk} ASC LIMIT ${batch}`,
    );

    let normalized = 0;
    let alreadyCanonical = 0;
    // Counted separately from the id list, which is capped — otherwise a page
    // with three hundred bad rows would report two hundred of them and an
    // operator would fix what they were shown and believe they were done.
    let unreadable = 0;
    const unreadableIds: string[] = [];
    let lastId: string | null = null;

    for (const row of rows) {
      const id = String(row[collection.pkColumn] ?? "");
      lastId = id;
      const raw = row[fieldName];
      if (raw === null || raw === undefined || raw === "") continue;
      // The row's own region, exactly as a write to it would resolve one — so a
      // normalization pass and a subsequent edit of the same row agree about
      // what country a bare national number was in.
      const region = resolveRowRegion(field.phone, collection.fields, null, row);
      let e164: string;
      try {
        e164 = parsePhoneForField(raw, { ...field.phone, region: region ?? undefined }).e164;
      } catch {
        // Left exactly as it is. Overwriting a value nobody can parse with a
        // guess — or with NULL — destroys the only copy of whatever it was, and
        // the operator who typed it is the one who can say what it meant.
        unreadable++;
        if (unreadableIds.length < 200) unreadableIds.push(id);
        continue;
      }
      if (e164 === raw) {
        alreadyCanonical++;
        continue;
      }
      normalized++;
      if (dryRun) continue;
      // Written straight to the column rather than through `performUpdate`: this
      // rewrites a value into the form it already meant, and routing a bulk
      // repair through the item write path would fire hooks, webhooks, realtime
      // events and a revision for every row.
      //
      // The row came out of a scoped SELECT, but the UPDATE re-states the whole
      // scope rather than trusting that: the two are separate statements, and an
      // id is not an authorization.
      await execute(
        ctx,
        sql`UPDATE ${table} SET ${col} = ${e164} ${whereOf(
          pkEq(collection.pkColumn, id),
          perm.whereSql,
          tenantFilter(collection, authScope),
          deletedFilter(collection),
        )}`,
      );
    }

    return c.json({
      data: {
        scanned: rows.length,
        normalized,
        alreadyCanonical,
        unreadable,
        unreadableIds,
        // A short page is the last page. Reporting a cursor there would cost the
        // caller one more round trip to discover the same thing.
        cursor: rows.length === batch ? lastId : null,
      },
    });
  },
);
