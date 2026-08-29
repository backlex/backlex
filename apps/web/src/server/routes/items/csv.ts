import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, } from "drizzle-orm";
import { AppError, } from "@backlex/core";
import {
  type FieldDef,
} from "@backlex/db";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { resolvePermission } from "../../services/permissions";
import { elapsedMs, requestMeta } from "../../services/activity";
import { SECURITY, errorResponses } from "../../lib/openapi";
import {
  collectionFromParam,
  loadCollection,
} from "../../services/items/collection-loader";
import {
  deserializeRow,
  projectFields,
} from "../../services/items/serialize";
import {
  performCreate,
  performUpdate,
  type WriteEnv,
} from "../../services/items/write";
import {
  allocateSequenceValues,
  sequenceFieldsOf,
} from "../../services/items/sequence";
import { toCsv, parseCsv } from "../../services/items/csv";
import {
  deletedFilter,
  draftFilter,
  fromOf,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "../../services/items/sql-helpers";
import {
  TAGS,
} from "../../services/items/schemas";
import { auditRead, canSeeDraftsFor } from "./shared";
import { defaultHook } from "../../lib/openapi-router";


/** Cap a single import call so a stray multi-MB file can't tie up the worker.
 *  Larger imports should be chunked client-side (or use the batch endpoint). */
const IMPORT_MAX = 5000;

/**
 * Cap a single export the same way the import above is capped.
 *
 * The export materializes every matching row into an array, maps it, and builds
 * one CSV/JSON string — so on a large collection it does not return a big
 * response, it exhausts the isolate. Import has been bounded since it was
 * written; export was not, which is the asymmetry this closes.
 *
 * Deliberately a refusal rather than a silent `LIMIT`: a truncated export that
 * looks complete is a data-loss-shaped bug, and this endpoint is exactly what
 * people reach for before a migration. The default is high enough that no
 * ordinary caller meets it, and `EXPORT_MAX_ROWS` moves it either way.
 */
const DEFAULT_EXPORT_MAX = 100_000;

/** System/managed columns that show up in an export but aren't writable user
 *  fields. Stripped on import so an export round-trips cleanly (and a CSV with
 *  an `id` column doesn't 422 every row). Each imported row gets a fresh id. */
const SYSTEM_IMPORT_KEYS = new Set([
  "id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "deletedAt",
  "deleted_at",
  "ownerId",
  "owner_id",
  "tenantId",
  "tenant_id",
  "_status",
  "_published_at",
  "_publish_at",
  "_fts",
]);

const stripSystemColumns = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!SYSTEM_IMPORT_KEYS.has(k)) out[k] = v;
  }
  return out;
};

/**
 * Coerce a CSV row (every cell a string) into the typed shape `performCreate`
 * expects. Empty cells are dropped so column defaults / NULL apply. JSON-ish
 * fields are parsed; numbers/booleans are converted; unknown columns pass
 * through as strings (validation rejects anything the collection doesn't want).
 */
/**
 * Replace every `{ amount, currency }` cell with its bare amount, so the export
 * is a column of numbers a spreadsheet can total and the import round-trips
 * through `coerceCsvRow` unchanged.
 */
const flattenMoneyForCsv = (
  rows: Record<string, unknown>[],
  fields: FieldDef[],
): Record<string, unknown>[] => {
  const money = fields.filter((f) => f.type === "money");
  if (money.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const f of money) {
      const v = out[f.name];
      if (v && typeof v === "object" && "amount" in (v as object)) {
        out[f.name] = (v as { amount: number }).amount;
      }
    }
    return out;
  });
};

const coerceCsvRow = (
  row: Record<string, string>,
  fields: FieldDef[],
): Record<string, unknown> => {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === "") continue;
    const field = byName.get(key);
    if (!field) {
      // Keep id (adopted-collection PKs) + any extra column as-is.
      out[key] = value;
      continue;
    }
    switch (field.type) {
      case "integer":
      case "number": {
        const n = Number(value);
        out[key] = Number.isNaN(n) ? value : n;
        break;
      }
      case "boolean":
        out[key] = /^(true|1|yes)$/i.test(value);
        break;
      case "json":
      case "relation_many":
        try {
          out[key] = JSON.parse(value);
        } catch {
          out[key] = value;
        }
        break;
      case "money":
        // A money cell is a bare amount in major units — that is what the
        // export writes, and it is the only form a spreadsheet will treat as a
        // number. `canonicalizeMoneyFields` pairs it with the row's currency
        // (from the sibling column in the same CSV row, or fixed on the field),
        // and `"19.99 USD"` still parses for a file that carries the code
        // inline.
        out[key] = value;
        break;
      default:
        out[key] = value;
    }
  }
  return out;
};

export const itemsCsvRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{slug}/export",
      tags: TAGS,
      summary: "Export collection rows",
      description:
        "Downloads every readable row as a JSON array (`?format=json`, default) or a spreadsheet-friendly CSV (`?format=csv`). Honors permission, tenant, soft-delete and draft visibility.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "read")],
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ format: z.enum(["json", "csv"]).optional() }),
      },
      responses: {
        200: {
          description: "Export file",
          content: { "application/octet-stream": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const format = c.req.query("format") === "csv" ? "csv" : "json";

      const joined = usesOwnershipSideTable(collection);
      const baseTblId = sql.identifier(collection.physicalTable);
      const tenantWhereRaw = tenantFilter(collection, auth);
      const tenantWhere =
        joined && tenantWhereRaw && collection.tenantScoped && auth.tenantId
          ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
          : tenantWhereRaw;
      const deletedWhere = deletedFilter(
        collection,
        joined ? collection.physicalTable : undefined,
      );
      const draftWhere = draftFilter(
        collection,
        await canSeeDraftsFor(ctx, auth, collection, perm),
        undefined,
        joined ? collection.physicalTable : undefined,
      );
      const rawMax = Number(ctx.env.EXPORT_MAX_ROWS ?? "");
      const exportMax =
        Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_EXPORT_MAX;
      // Fetch one past the cap so "at the limit" and "over it" are
      // distinguishable without a second COUNT.
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(perm.whereSql, tenantWhere, deletedWhere, draftWhere)} LIMIT ${exportMax + 1}`,
      );
      if (rows.length > exportMax) {
        throw new AppError(
          "VALIDATION",
          `This export exceeds EXPORT_MAX_ROWS (${exportMax}). Narrow it with a filter, or page through the collection with the keyset cursor (?cursor=) — that path is O(1) per page and has no ceiling.`,
          { limit: exportMax, collection: collection.slug },
        );
      }
      const data = rows.map((r) =>
        projectFields(
          deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped),
          perm.fields,
        ),
      );

      auditRead(c, collection, null, { export: format, count: data.length });

      if (format === "csv") {
        // Stable header: id + declared field names, then any extra keys the
        // rows carry (system columns, adopted-table columns).
        const cols: string[] = ["id", ...collection.fields.map((f) => f.name)];
        const seen = new Set(cols);
        for (const row of data) {
          for (const k of Object.keys(row)) {
            if (!seen.has(k)) {
              seen.add(k);
              cols.push(k);
            }
          }
        }
        // A money value is `{ amount, currency }`, and `toCsv` renders an object
        // cell as JSON — which a spreadsheet reads as text, cannot sum, and
        // would re-import as a blob. Flatten to the bare amount: the currency
        // is either fixed on the field (so it is in the schema, not the data)
        // or already its own column in the same row.
        const flattened = flattenMoneyForCsv(data, collection.fields);
        return new Response(toCsv(flattened, cols), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${collection.slug}.csv"`,
          },
        });
      }
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${collection.slug}.json"`,
        },
      });
    },
  )
  /**
   * Bulk import — inserts rows from a JSON array or CSV upload, one row per
   * `performCreate` so every row goes through the same validation, permission
   * field-allow-list, relation checks, revisions, events and search/vector
   * indexing as a normal create. Per-row errors are captured, not fatal.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{slug}/import",
      tags: TAGS,
      summary: "Import collection rows",
      description:
        "Bulk-imports rows from a JSON array (`?format=json`, default) or a CSV upload (`?format=csv`). Send the rows as the raw request body (`application/json` array, or `text/csv`). Rows that carry an `id` matching an existing row are UPDATED (requires `update` permission); rows with a new or absent `id` are INSERTED. This makes an exported file round-trip cleanly on re-import instead of colliding on unique columns. Row-level failures are reported in `errors` without aborting the rest.",
      security: SECURITY,
      middleware: [requirePermission(collectionFromParam, "create")],
      // No declared body schema on purpose: the import accepts either a JSON
      // array or a raw CSV upload, so the handler reads `c.req.text()` itself
      // rather than letting the OpenAPI JSON validator consume the stream.
      request: {
        params: z.object({ slug: z.string() }),
        query: z.object({ format: z.enum(["json", "csv"]).optional() }),
      },
      responses: {
        200: {
          description: "Import summary",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  inserted: z.number().int(),
                  updated: z.number().int(),
                  failed: z.number().int(),
                  total: z.number().int(),
                  errors: z.array(
                    z.object({ row: z.number().int(), error: z.string() }),
                  ),
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
      const perm = c.get("permission");
      const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
      const contentType = c.req.header("content-type") ?? "";
      const format =
        c.req.query("format") === "csv" || contentType.includes("text/csv")
          ? "csv"
          : "json";
      const raw = await c.req.text();

      let records: Record<string, unknown>[];
      if (format === "csv") {
        records = parseCsv(raw).map((r) => coerceCsvRow(r, collection.fields));
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new AppError("VALIDATION", "Import body is not valid JSON.");
        }
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as any).data)
            ? (parsed as any).data
            : null;
        if (!arr) {
          throw new AppError(
            "VALIDATION",
            "JSON import must be an array of rows (or `{ data: [...] }`).",
          );
        }
        records = arr as Record<string, unknown>[];
      }

      if (records.length > IMPORT_MAX) {
        throw new AppError(
          "VALIDATION",
          `Import is limited to ${IMPORT_MAX} rows per call; got ${records.length}.`,
        );
      }

      const env: WriteEnv = {
        ctx,
        collection,
        userId: auth.userId,
        tenantId: auth.tenantId,
        roles: auth.roles,
        email: auth.email ?? null,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        orgIds: auth.orgIds ?? [],
        meta: requestMeta(c.req.raw),
        impersonatedBy: auth.impersonatedBy ?? null,
        impersonationReadOnly: auth.impersonationReadOnly ?? false,
        durationMs: () => elapsedMs(c),
        locale: null,
        // The import answers with a per-row summary, never a row. Empty rather
        // than `null` so a change that starts echoing rows inherits the
        // restrictive answer instead of the permissive one.
        readFields: new Set<string>(),
        // An import is the one write path here with no bound on how many rows
        // it processes, and a geocoder is metered and rate-limited — one call
        // per row would make a large file a request that cannot finish. The
        // rows land without points and `POST /api/geo/backfill/{slug}` fills
        // them in on a budget the caller sets. See WriteEnv.skipGeocode.
        skipGeocode: true,
        // One allocation statement per sequence field for the whole file
        // instead of one per row. Over-sized whenever some rows turn out to be
        // updates or to fail validation; those numbers are simply spent, which
        // is the gap the series already permits. `at` is fixed for the file, so
        // an import running across midnight numbers under one bucket rather
        // than splitting mid-file.
        sequencePool: await allocateSequenceValues(
          ctx,
          auth.tenantId,
          collection.slug,
          sequenceFieldsOf(collection.fields),
          records.length,
          new Date(),
        ),
      };

      // Rows carrying an existing id are updated (round-trip restore) rather
      // than re-inserted — but only when the caller actually holds `update`.
      // Without it we fall back to insert, preserving the prior behaviour
      // (and its unique-collision error) instead of silently escalating.
      const updatePerm = await resolvePermission(ctx, auth, collection.slug, "update");

      let inserted = 0;
      let updated = 0;
      const errors: { row: number; error: string }[] = [];
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record || typeof record !== "object") {
          errors.push({ row: i + 1, error: "Row is not an object." });
          continue;
        }
        const rawId = (record as Record<string, unknown>).id;
        const id = typeof rawId === "string" && rawId ? rawId : null;
        const body = stripSystemColumns(record);
        try {
          if (id && updatePerm.allowed) {
            try {
              const res = await performUpdate(env, id, body, {
                whereSql: updatePerm.whereSql,
                fields: updatePerm.fields,
                conditions: updatePerm.conditions,
              });
              for (const fx of res.sideEffects) await fx();
              updated += 1;
              continue;
            } catch (e) {
              // Unknown id → fall through to insert; anything else is a real error.
              if (!(e instanceof AppError && e.code === "NOT_FOUND")) throw e;
            }
          }
          const res = await performCreate(env, body, {
            whereSql: perm.whereSql,
            fields: perm.fields,
            conditions: perm.conditions,
          });
          for (const fx of res.sideEffects) await fx();
          inserted += 1;
        } catch (e) {
          errors.push({ row: i + 1, error: (e as Error).message.slice(0, 200) });
        }
      }

      return c.json({
        data: {
          inserted,
          updated,
          failed: errors.length,
          total: records.length,
          errors: errors.slice(0, 50),
        },
      });
    },
  )
  /**
   * Incremental changefeed for offline sync. Returns rows whose `updated_at` is
   * past the `since` cursor — **including soft-deleted tombstones** so a client
   * can converge its local store (apply non-deleted, drop `deleted_at != null`).
   * Keyset-paginated on `(updated_at, id)`; the opaque `cursor` in the response
   * feeds the next call. Requires a collection with `updated_at`.
   */
;
