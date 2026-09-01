import { and, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { type FieldDef, introspectColumns, isFoldColumn, isLocalized, isPresentational } from "@backlex/db";
import type { Context } from "hono";
import type { AppBindings } from "../../app";
import type { Ctx } from "../../context";
import {
  getCachedCollection,
  setCachedCollection,
} from "../collections-cache";

export interface CollectionRow {
  /** Collections.id — primary key in the metadata table. Needed for the
   *  `item_ownership` semi-join on adopted owner-scoped collections. */
  id: string;
  slug: string;
  /** Physical table backing the dynamic data (e.g. `c_<tenantPrefix>_<slug>`). */
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean;
  /** Default true. When true, the physical table has a tenant_id column and
   *  reads/writes are scoped to the active tenant. */
  tenantScoped: boolean;
  versioned?: boolean;
  /** Staged edits (versioned only). When true, a PATCH against a *published*
   *  row is stored as a staged JSON patch (`item_staged`) instead of mutating
   *  the live row; publish applies the patch, unpublish/archive fold it into
   *  the row as it leaves published. `?live=1` (publish permission) bypasses. */
  stagedEdits: boolean;
  /** When true, the physical table has a nullable `deleted_at` column; DELETE
   *  soft-deletes (sets `deleted_at = now()`) and every read path filters
   *  `deleted_at IS NULL`. Always false for adopted collections. */
  softDelete: boolean;
  /** When true, inserts are rejected once one live row exists. */
  singleton: boolean;
  /** Opt-in sensitive-read auditing. When true, the item read routes (list +
   *  by-id) record an `access.read` activity row per read. Defaults false. */
  auditReads: boolean;
  /** Auto-vectorize items on write (POST/PATCH) and clear on delete. The
   *  fields that contribute to the embed text are the ones whose `FieldDef`
   *  has `vectorize: true` (text/longtext only). */
  vectorize: boolean;
  /** Embedding model key (`EMBEDDING_MODELS` keys). Null → env default. */
  vectorizeModel: string | null;
  /** Maintain a keyword full-text-search index on write (Postgres tsvector +
   *  GIN; SQLite FTS5 shadow table) from the fields flagged `searchable: true`
   *  (text/longtext only). Powers the `?q=` precision filter and the
   *  `POST /:slug/search` endpoint. */
  fts: boolean;
  /** Comma-separated default sort (`-` prefix = DESC). Null
   *  falls back to `-created_at` in `parseQuery`. */
  defaultSort: string | null;
  /** True when this collection was adopted from an existing physical table
   *  (vs. we created it). When true, schema-applier never DDLs the table
   *  and ownership lives in `item_ownership` instead of an injected
   *  `owner_id` column. */
  adopted: boolean;
  /** Primary-key column name on the physical table. Default `id`; adoption
   *  surfaces this for source tables with a different PK name. */
  pkColumn: string;
  /** PK storage type (`uuid` | `text` | `integer`). `uuid`/`text` PKs are
   *  auto-generated on POST (a UUID string fits both); `integer` PKs must be
   *  supplied in the body — backlex never invents numeric keys (no sequence
   *  to lean on across dialects). External-DB migration is what creates
   *  non-uuid managed collections. */
  pkType: "uuid" | "text" | "integer";
  /**
   * Which `<name>__fold` companion columns the physical table ACTUALLY has.
   *
   * Read off the table rather than inferred from the field types, and that
   * distinction is the whole point. A collection created before folded search
   * existed has `text` fields and no companions until its schema is next
   * applied — and a WHERE naming a column that is not there does not raise on
   * SQLite, it QUIETLY matches nothing: an unresolvable double-quoted
   * identifier is read as a string literal. So `_icontains` would have returned
   * zero rows, with a 200, on every pre-existing collection. Measured before
   * this field existed.
   */
  foldColumns: Set<string>;
  /** Whether the physical table has these columns. Always true for managed
   *  collections; flexible for adopted ones. Used by POST/PATCH writes,
   *  projection, and the `parseQuery` default-sort fallback. */
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  /** Physical column names backing the system fields. Null = use the
   *  conventional name (`created_at`/`updated_at`/`owner_id`). Adopted
   *  collections can map to whatever the source table already calls
   *  these — `inserted_at`, `user_id`, etc. */
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
  /** When set on an adopted owner-scoped collection, ownership reads
   *  from this column on the source table (alias path) instead of the
   *  `item_ownership` side-table (join path). */
  ownerIdColumn: string | null;
}

export const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

/**
 * The `<name>__fold` companion columns this physical table actually has.
 *
 * One introspection per cache fill, not per request — the collection cache
 * exists to keep this path off the hot loop. A table that gains its companions
 * later keeps the fallback until the entry expires, which is correct-but-
 * limited rather than wrong. An introspection that fails answers "none", so a
 * database that will not describe itself degrades to the old behaviour instead
 * of compiling a WHERE against columns nobody has confirmed.
 */
const readFoldColumns = async (
  ctx: Pick<Ctx, "db" | "dialect">,
  table: string,
): Promise<Set<string>> => {
  try {
    const cols = await introspectColumns(ctx.db as never, ctx.dialect, table);
    const out = new Set<string>();
    for (const c of cols) if (isFoldColumn(c)) out.add(c);
    return out;
  } catch {
    return new Set();
  }
};

export const loadCollection = async (
  // Only the DB handle + dialect are used, so callers that hold a bare
  // `DbCtx` (e.g. the permission resolver) can load collection metadata too.
  ctx: Pick<Ctx, "db" | "dialect">,
  tenantId: string | null | undefined,
  slug: string,
): Promise<CollectionRow> => {
  if (!tenantId) {
    throw new AppError(
      "UNAUTHORIZED",
      "Active tenant required to access collections",
    );
  }
  // Per-isolate cache hit skips the metadata round-trip on the items CRUD /
  // GraphQL / realtime hot path. Only active rows are cached (see below), so a
  // hit is always a resolvable collection. Schema mutations call
  // `invalidateTenantCollections` for same-isolate freshness; the TTL bounds
  // cross-isolate staleness (≤ TTL_MS, same model as the list/permission caches).
  const cached = getCachedCollection(tenantId, slug);
  if (cached) return cached;
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  const r = rows[0] as Record<string, unknown>;
  // Archived (adopted) collections are 404 from every items endpoint;
  // backlex stops treating the underlying table as a collection until
  // someone calls `POST /collections/:slug/restore`. Never cached — a restore
  // must resolve immediately, not wait out a negative-cache TTL.
  if (((r.status ?? "active") as string) !== "active") {
    throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  }
  // Introspected BEFORE the row is built so the field is set, not patched in —
  // a `CollectionRow` is handed to the compiler and must never exist in a state
  // where `foldColumns` is undefined.
  const foldColumns = await readFoldColumns(ctx, (r.physicalTable ?? r.physical_table) as string);
  const row: CollectionRow = {
    id: r.id as string,
    foldColumns,
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    // Presentational blocks (divider/notice) are layout-only — they carry no
    // column and no value. Strip them here, at the single loader every items
    // path (read/write/validate/CSV/GraphQL/expand/FTS/vectorize) funnels
    // through, so nothing downstream ever treats one as a real column.
    fields: (r.fields as FieldDef[]).filter((f) => !isPresentational(f)),
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
    tenantScoped: r.tenantScoped ?? r.tenant_scoped ?? true ? true : false,
    versioned: Boolean(r.versioned),
    stagedEdits: Boolean(r.stagedEdits ?? r.staged_edits),
    softDelete: Boolean(r.softDelete ?? r.soft_delete),
    singleton: Boolean(r.singleton),
    auditReads: Boolean(r.auditReads ?? r.audit_reads),
    vectorize: Boolean(r.vectorize),
    vectorizeModel: ((r.vectorizeModel ?? r.vectorize_model) as string | null | undefined) ?? null,
    fts: Boolean(r.fts),
    defaultSort: ((r.defaultSort ?? r.default_sort) as string | null | undefined) ?? null,
    adopted: Boolean(r.adopted),
    pkColumn: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
    pkType:
      (((r.pkType ?? r.pk_type) as string | undefined) ?? "uuid") as
        | "uuid"
        | "text"
        | "integer",
    hasCreatedAt: (r.hasCreatedAt ?? r.has_created_at) === false ? false : true,
    hasUpdatedAt: (r.hasUpdatedAt ?? r.has_updated_at) === false ? false : true,
    createdAtColumn: ((r.createdAtColumn ?? r.created_at_column) as string | null | undefined) ?? null,
    updatedAtColumn: ((r.updatedAtColumn ?? r.updated_at_column) as string | null | undefined) ?? null,
    ownerIdColumn: ((r.ownerIdColumn ?? r.owner_id_column) as string | null | undefined) ?? null,
  };
  setCachedCollection(tenantId, slug, row);
  return row;
};

export const collectionFromParam = (c: Context<AppBindings>) =>
  c.req.param("slug" as never) as string;

/** Any `localized` (sidecar) field present. Guards the read-path
 *  `defaultLocale` lookup and the write-path locale split. */
export const hasLocalizedField = (fields: FieldDef[]): boolean =>
  fields.some(isLocalized);
