import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { loadCollection } from "../services/items/collection-loader";
import { deserializeRow } from "../services/items/serialize";
import {
  deletedFilter,
  fromOf,
  pkEq,
  queryAll,
  selectStar,
  whereOf,
} from "../services/items/sql-helpers";
import { resolveSharedLink } from "../services/shared-links";

const TAGS = ["shared-links"];

const PublicFieldDef = z
  .object({
    name: z.string(),
    type: z.string(),
  })
  .openapi("PublicSharedField");

const PublicSharedRecord = z
  .object({
    collection: z.string(),
    item: z.record(z.string(), z.unknown()),
    fields: z.array(PublicFieldDef),
  })
  .openapi("PublicSharedRecord");

/**
 * Public, unauthenticated read of a single shared record. Mounted at
 * `/api/shared` with NO `requireUser` — anyone holding the token can read.
 *
 * The route deliberately bypasses row-level permissions (the share link IS
 * the grant), but only ever returns the one record the link points at: the
 * SQL is keyed by the collection's `pk` plus the link's `item_id`, scoped to
 * the link's tenant.
 *
 * Degrades gracefully when the `shared_links` table doesn't exist yet —
 * `resolveSharedLink` swallows the missing-table error and returns null, so
 * the route just answers 404.
 */
export const sharedPublicRoutes = new OpenAPIHono<AppBindings>().openapi(
  createRoute({
    method: "get",
    path: "/{token}",
    tags: TAGS,
    summary: "Resolve a public share link to its record",
    description:
      "PUBLIC — no auth. Resolves the token, then returns the single shared record plus the collection's field metadata so the link page can render labels and types.",
    security: PUBLIC_SECURITY,
    request: { params: z.object({ token: z.string() }) },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": { schema: z.object({ data: PublicSharedRecord }) },
        },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const { token } = c.req.valid("param");

    const link = await resolveSharedLink(
      { db: ctx.db, dialect: ctx.dialect },
      token,
    );
    if (!link) {
      throw new AppError("NOT_FOUND", "This share link is no longer available");
    }

    // Load the collection metadata for the link's tenant. `physical_table`
    // is the source of truth — `loadCollection` reads it. If the collection
    // was deleted or archived, this throws NOT_FOUND, which the caller maps
    // to a 404, same as a revoked link.
    let collection;
    try {
      collection = await loadCollection(ctx, link.tenantId, link.collection);
    } catch {
      throw new AppError("NOT_FOUND", "This share link is no longer available");
    }

    // Read exactly the one shared row — pk = link.item_id, tenant-scoped.
    // No permission whereSql: the share link is the grant.
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(
        pkEq(collection.pkColumn, link.itemId),
        collection.tenantScoped && link.tenantId
          ? sql`${sql.identifier("tenant_id")} = ${link.tenantId}`
          : null,
        deletedFilter(collection),
      )} LIMIT 1`,
    );
    if (!rows[0]) {
      throw new AppError("NOT_FOUND", "This share link is no longer available");
    }

    const item = deserializeRow(
      rows[0],
      collection.fields,
      ctx.dialect,
      collection.ownerScoped,
      null,
      {
        pkColumn: collection.pkColumn,
        hasCreatedAt: collection.hasCreatedAt,
        hasUpdatedAt: collection.hasUpdatedAt,
      },
    );

    const fields = (collection.fields as FieldDef[]).map((f) => ({
      name: f.name,
      type: f.type,
    }));

    return c.json({
      data: { collection: collection.slug, item, fields },
    });
  },
);
