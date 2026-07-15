import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { ifNoneMatch, weakETag } from "../../lib/etag";
import { listRevisions, } from "../../services/revisions";
import { loadAppSettings } from "../../services/settings";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  hasLocalizedField,
  loadCollection,
  type CollectionRow,
} from "../../services/items/collection-loader";
import {
  applySidecarFromRows,
  loadSidecarForRow,
} from "../../services/items/i18n-sidecar";
import { sidecarFields } from "@backlex/db";
import {
  deserializeRow,
  projectFields,
} from "../../services/items/serialize";
import {
  resolveExpands,
  applyExpandToRow,
  resolveManyExpands,
  applyManyExpandsToRows,
} from "../../services/items/expand";
import {
  deletedFilter,
  draftFilter,
  fromOf,
  pkEq,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "../../services/items/sql-helpers";
import {
  ItemRow,
  TAGS,
} from "../../services/items/schemas";
import { auditRead, canSeeDraftsFor } from "./shared";

export const itemsReadRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/{id}/revisions",
      tags: TAGS,
      summary: "List an item's revisions",
      description: "The append-only snapshot history for one row (most recent first).",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: { params: z.object({ slug: z.string(), id: z.string() }) },
      responses: {
        200: { description: "Revisions", content: { "application/json": { schema: z.object({ data: z.any() }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const slug = c.req.param("slug");
      await loadCollection(ctx, auth.tenantId, slug); // 404s unknown collection
      const data = await listRevisions(
        { db: ctx.db, dialect: ctx.dialect },
        slug,
        c.req.param("id"),
        auth.tenantId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/{id}",
      tags: TAGS,
      summary: "Get item",
      description: "Fetches one row by primary key. Respects per-role read field projection.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string(), id: z.string() }),
        query: z.object({
          locale: z.string().optional(),
          expand: z.string().optional().openapi({
            description:
              "Comma-separated relation fields to inline-expand. Single-hop only.",
          }),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ItemRow }) },
          },
        },
        304: { description: "Not Modified (If-None-Match matched the ETag)" },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      // `?expand=` works the same shape as on the list endpoint, but
      // single-GET doesn't go through parseQuery — so we inline the
      // source-side validation here (chain reject, type check, source
      // perm-fields gate). resolveExpands enforces the per-target read
      // permission + tenant scope, same as the list path.
      const expand: string[] = [];
      const expandRaw = c.req.query("expand");
      if (expandRaw) {
        const fieldsByName = new Map(collection.fields.map((f) => [f.name, f] as const));
        const seen = new Set<string>();
        for (const raw of expandRaw.split(",")) {
          const name = raw.trim();
          if (!name) continue;
          if (name.includes(".")) {
            throw new AppError(
              "VALIDATION",
              `expand chain not yet supported: ${name}`,
            );
          }
          const def = fieldsByName.get(name);
          if (!def) {
            throw new AppError("VALIDATION", `Unknown expand field: ${name}`);
          }
          if (def.type !== "relation" && def.type !== "relation_many") {
            throw new AppError(
              "VALIDATION",
              `expand only works on relation fields — "${name}" is ${def.type}`,
            );
          }
          if (perm.fields && !perm.fields.has(name)) {
            throw new AppError(
              "FORBIDDEN",
              `No permission to read field: ${name}`,
            );
          }
          if (!seen.has(name)) {
            seen.add(name);
            expand.push(name);
          }
        }
      }
      // Split to-one (JOIN) from to-many (batch) heads, same as the list path.
      const isManyHead = (h: string) =>
        collection.fields.find((f) => f.name === h)?.type === "relation_many";
      const expandOne = expand.filter((h) => !isManyHead(h));
      const expandManyHeads = expand.filter(isManyHead);

      const joinMap = new Map<string, { alias: string; target: CollectionRow }>();
      const {
        extraJoins: expandJoins,
        selects: expandSelects,
        plans: expandPlans,
      } = await resolveExpands(ctx, auth, collection, expandOne, joinMap);
      const manyPlans = await resolveManyExpands(
        ctx,
        auth,
        collection,
        expandManyHeads,
      );
      const hasJoins = expandJoins.length > 0;
      // When joins are added, `*` would surface the target's columns too —
      // qualify everything to the base table the same way the list handler
      // does. selectStar still handles the aliased-system-column cases.
      const baseTblId = sql.identifier(collection.physicalTable);
      const baseSelect: SQL = hasJoins
        ? (() => {
            const parts: SQL[] = [sql`${baseTblId}.*`];
            if (usesOwnershipSideTable(collection)) {
              parts.push(
                sql`${sql.identifier("item_ownership")}.${sql.identifier("owner_id")} AS ${sql.identifier("owner_id")}`,
              );
            }
            if (
              collection.hasCreatedAt &&
              collection.createdAtColumn &&
              collection.createdAtColumn !== "created_at"
            ) {
              parts.push(
                sql`${baseTblId}.${sql.identifier(collection.createdAtColumn)} AS ${sql.identifier("created_at")}`,
              );
            }
            if (
              collection.hasUpdatedAt &&
              collection.updatedAtColumn &&
              collection.updatedAtColumn !== "updated_at"
            ) {
              parts.push(
                sql`${baseTblId}.${sql.identifier(collection.updatedAtColumn)} AS ${sql.identifier("updated_at")}`,
              );
            }
            if (
              collection.ownerScoped &&
              collection.adopted &&
              collection.ownerIdColumn
            ) {
              parts.push(
                sql`${baseTblId}.${sql.identifier(collection.ownerIdColumn)} AS ${sql.identifier("owner_id")}`,
              );
            }
            return sql.join(parts, sql`, `);
          })()
        : selectStar(collection);
      const selectCols: SQL = expandSelects.length
        ? sql`${baseSelect}, ${sql.join(expandSelects, sql`, `)}`
        : baseSelect;
      // PK and tenant filter both need to qualify to the base table when
      // there's a join — same reason `nestedColRef` qualifies in the list
      // handler. Permission's whereSql is left untouched: in this path
      // permissions only reference `owner_id`, which (a) is provided
      // unqualified in our base SELECT (managed `owner_id` column or
      // side-table-join surfaced alias) and (b) is unambiguous because
      // the joined targets only expose `owner_id` if they're owner-scoped
      // — even then, the column is on the alias, not unqualified.
      const pkWhere = hasJoins
        ? sql`${baseTblId}.${sql.identifier(collection.pkColumn)} = ${c.req.param("id")}`
        : pkEq(collection.pkColumn, c.req.param("id"));
      const tenantWhereRaw = tenantFilter(collection, auth);
      const tenantWhere =
        hasJoins && tenantWhereRaw && collection.tenantScoped && auth.tenantId
          ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
          : tenantWhereRaw;
      const fromClause: SQL = hasJoins
        ? sql`${fromOf(collection)} ${sql.join(expandJoins, sql` `)}`
        : fromOf(collection);
      const deletedWhere = deletedFilter(
        collection,
        hasJoins ? collection.physicalTable : undefined,
      );
      // Versioned collections: a draft fetched by id 404s for callers without
      // publish/update permission (the filter excludes it from the result).
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        c.req.query("status"),
        hasJoins ? collection.physicalTable : undefined,
      );
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectCols} FROM ${fromClause} ${whereOf(pkWhere, perm.whereSql, tenantWhere, deletedWhere, draftWhere)} LIMIT 1`,
      );
      if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
      // Conditional GET. The weak ETag keys on the row's version (`updated_at`)
      // plus everything that changes the body — the query params and the
      // caller's field allow-list — so a different locale/expand/role can't
      // collide on the same validator. We only emit it when `updated_at` is
      // present: without a version column a stable ETag would 304 even after
      // the row changed (a staleness bug), so those reads just skip caching.
      // `private` + `no-cache` (always revalidate) keeps it per-user and never
      // lets a shared cache serve it; `Vary` nails the auth dimension.
      const version = rows[0]["updated_at"];
      if (version != null) {
        const etag = weakETag([
          "item",
          collection.slug,
          rows[0][collection.pkColumn] as string | undefined,
          version as string | number,
          c.req.query("locale") ?? "",
          c.req.query("expand") ?? "",
          c.req.query("status") ?? "",
          perm.fields ? [...perm.fields].sort().join(",") : "*",
        ]);
        c.header("ETag", etag);
        c.header("Cache-Control", "private, no-cache");
        c.header("Vary", "Authorization, Cookie");
        if (ifNoneMatch(c.req.header("if-none-match"), etag)) {
          // Client already holds this version — skip expand + serialization.
          return c.body(null, 304);
        }
      }
      const locale = c.req.query("locale") ?? null;
      const defaultLocale =
        locale && locale !== "*" && hasLocalizedField(collection.fields)
          ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
          : null;
      const localizedDefs = sidecarFields(collection.fields);
      const base = deserializeRow(rows[0], collection.fields, ctx.dialect, collection.ownerScoped);
      // Sidecar (`localized`) fields: one small second query for this id, then
      // resolve requested→default (single) or the full map (`*`). Applied BEFORE
      // the perm-field projection so it honours the field allow-list.
      if (localizedDefs.length > 0) {
        const sidecarRows = await loadSidecarForRow(
          ctx,
          collection.physicalTable,
          rows[0][collection.pkColumn] as string,
          localizedDefs,
        );
        applySidecarFromRows(base, sidecarRows, localizedDefs, ctx.dialect, locale, defaultLocale);
      }
      const projected = projectFields(base, perm.fields);
      // Expand AFTER projectFields so the inlined object survives the
      // perm.fields trim even when the source FK key (e.g. `customer_id`)
      // would have been kept by virtue of being in perm.fields, but a
      // user who has source perm but no `customer_id` in their fields
      // allow-list still can't expand it — parseQuery's source-perm gate
      // above rejects that case first.
      if (expandPlans.length > 0) {
        applyExpandToRow(projected, rows[0], expandPlans, ctx.dialect);
      }
      if (manyPlans.length > 0) {
        await applyManyExpandsToRows(ctx, auth, [projected], manyPlans);
      }
      // Sensitive-read audit (opt-in). Records the viewed item id + the field
      // names returned — never the field values themselves.
      auditRead(c, collection, c.req.param("id"), {
        fields: Object.keys(projected),
      });
      return c.json({ data: projected });
    },
  )
;
