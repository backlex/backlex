import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type SQL, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { parseEmailForField } from "@backlex/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requirePermission } from "../middleware/permission";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { collectionFromParam, loadCollection } from "../services/items/collection-loader";
import {
  deletedFilter,
  execute,
  pkEq,
  queryAll,
  tenantFilter,
  whereOf,
} from "../services/items/sql-helpers";

/**
 * Normalizing the email addresses that were already there.
 *
 * The write path folds everything from now on, which fixes exactly one half of
 * the problem: the rows written from now on. The other half is every row a
 * workspace already has — fifty-eight template columns' worth of `Ada@Example.com`
 * and ` bob@example.com `, plus whatever an adopted table arrived carrying.
 * Without this, turning a column into an email field would leave a collection
 * where SOME addresses are canonical and some are not, with nothing in the data
 * to say which — the worst of both states, because `unique` and lookup-by-address
 * would appear to work while quietly missing the old rows.
 *
 * The counterpart to `phone/normalize`, `sequences/sync` and `geo/backfill`, and
 * it makes the same two promises: it moves values only in the one direction that
 * is safe, and it REPORTS what it could not read rather than guessing at it.
 *
 * ## The one thing phone did not have to deal with
 *
 * Folding an address can make two rows EQUAL that were not equal before, and
 * fourteen of those fifty-eight columns are declared `unique` — which is the
 * whole reason the type exists, since every one of them was letting
 * `Ada@x.com`/`ada@x.com` in as two rows. So a normalization pass over exactly
 * the columns that need it most is the pass most likely to hit the constraint.
 *
 * A collision is DETECTED and REPORTED, never resolved. Which of two rows is the
 * real customer is a question about the business, not about the data — one may
 * have the orders and the other the support tickets — and merging them is
 * irreversible. The pass leaves both exactly as they are and hands back the ids.
 */

export const emailFieldRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "post",
    path: "/normalize/{slug}",
    tags: ["email"],
    summary: "Rewrite existing email values to canonical form",
    description:
      "Walk a collection in primary-key order and rewrite every value of an `email` field into its canonical form, in bounded pages. Values already canonical are left untouched; values that cannot be read as an address are reported by row id and left exactly as they are. On a `unique` column, a value that would collide with another row is also reported and left alone — deciding which row is the real one is not something a normalization pass may do. Loop while `cursor` is non-null. Requires update permission on the collection.",
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
               * and, on a `unique` column, the only way to find out how many
               * duplicates folding is about to surface before committing to it.
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
                /** Rows whose value could not be read as an address. */
                unreadable: z.number().int(),
                /**
                 * Rows whose canonical value is already held by a DIFFERENT row
                 * of a `unique` column. Left untouched — see the module note.
                 */
                collided: z.number().int(),
                /**
                 * Ids of the unreadable and collided rows, so an operator can go
                 * and look at them. The VALUES are deliberately not returned:
                 * this response is a plausible thing to log, and every one of
                 * them is a real person's address. Capped so one page cannot
                 * answer with the whole table.
                 */
                unreadableIds: z.array(z.string()),
                collidedIds: z.array(z.string()),
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
    if (!field || field.type !== "email") {
      throw new AppError("VALIDATION", `"${fieldName}" is not an email field on "${slug}"`);
    }

    const table = sql.identifier(collection.physicalTable);
    const col = sql.identifier(fieldName);
    const pk = sql.identifier(collection.pkColumn);
    // The same scope the item write path applies, assembled once so the SELECT
    // and every UPDATE below cannot drift apart:
    //
    //  - non-empty — an absent address is not an address to fix;
    //  - `perm.whereSql` — the caller's row-level `update` condition. Holding
    //    `update` on a collection is NOT holding it on every row: the bundled
    //    self-service roles grant it conditioned on `app_user_id = $user.id`, so
    //    without this an end-user could rewrite — and, through the reported ids,
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
    // Counted separately from the id lists, which are capped — otherwise a page
    // with three hundred bad rows would report two hundred of them and an
    // operator would fix what they were shown and believe they were done.
    let unreadable = 0;
    let collided = 0;
    const unreadableIds: string[] = [];
    const collidedIds: string[] = [];
    let lastId: string | null = null;

    for (const row of rows) {
      const id = String(row[collection.pkColumn] ?? "");
      lastId = id;
      const raw = row[fieldName];
      if (raw === null || raw === undefined || raw === "") continue;
      let canonical: string;
      try {
        // The field's own `allowedDomains` is NOT applied: this pass repairs the
        // FORM of a value that is already in the column. A domain rule tightened
        // after those rows were written governs the next write, and refusing to
        // canonicalize an address the workspace already holds would just leave
        // it unreadable-looking for a reason that has nothing to do with it.
        canonical = parseEmailForField(raw, {
          ...field.email,
          allowedDomains: undefined,
        }).email;
      } catch {
        // Left exactly as it is. Overwriting a value nobody can parse with a
        // guess — or with NULL — destroys the only copy of whatever it was, and
        // the operator who typed it is the one who can say what it meant.
        unreadable++;
        if (unreadableIds.length < 200) unreadableIds.push(id);
        continue;
      }
      if (canonical === raw) {
        alreadyCanonical++;
        continue;
      }
      if (field.unique) {
        // Checked BEFORE the write rather than catching the driver's constraint
        // error afterwards, for two reasons: a failed statement on some drivers
        // poisons the surrounding batch, and the error text lives in a different
        // place on every driver (D1 puts it on `.cause`, bun:sqlite on
        // `.message`), so matching on it is the kind of test that passes
        // everywhere and fails in production.
        //
        // Scoped to the tenant and to live rows, but deliberately NOT to
        // `perm.whereSql`: the question is whether the COLUMN already holds this
        // value anywhere, and a row the caller may not see still occupies it.
        // Only the id is selected, so nothing about that row is disclosed.
        const clash = await queryAll<Record<string, unknown>>(
          ctx,
          sql`SELECT ${pk} FROM ${table} ${whereOf(
            sql`${col} = ${canonical}`,
            sql`${pk} <> ${id}`,
            tenantFilter(collection, authScope),
            deletedFilter(collection),
          )} LIMIT 1`,
        );
        if (clash.length > 0) {
          collided++;
          if (collidedIds.length < 200) collidedIds.push(id);
          continue;
        }
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
        sql`UPDATE ${table} SET ${col} = ${canonical} ${whereOf(
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
        collided,
        unreadableIds,
        collidedIds,
        // A short page is the last page. Reporting a cursor there would cost the
        // caller one more round trip to discover the same thing.
        cursor: rows.length === batch ? lastId : null,
      },
    });
  },
);
