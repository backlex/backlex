import { and, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { FieldDef } from "@backlex/db";
import type { Context } from "hono";
import type { AppBindings } from "../../app";
import type { Ctx } from "../../context";

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
  /** Auto-vectorize items on write (POST/PATCH) and clear on delete. The
   *  fields that contribute to the embed text are the ones whose `FieldDef`
   *  has `vectorize: true` (text/longtext only). */
  vectorize: boolean;
  /** Embedding model key (`EMBEDDING_MODELS` keys). Null → env default. */
  vectorizeModel: string | null;
  /** Comma-separated default sort (Directus shape, `-` prefix = DESC). Null
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

export const loadCollection = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  slug: string,
): Promise<CollectionRow> => {
  if (!tenantId) {
    throw new AppError(
      "UNAUTHORIZED",
      "Active tenant required to access collections",
    );
  }
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  const r = rows[0] as Record<string, unknown>;
  // Archived (adopted) collections are 404 from every items endpoint;
  // workeros stops treating the underlying table as a collection until
  // someone calls `POST /collections/:slug/restore`.
  if (((r.status ?? "active") as string) !== "active") {
    throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  }
  return {
    id: r.id as string,
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    fields: r.fields as FieldDef[],
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
    tenantScoped: r.tenantScoped ?? r.tenant_scoped ?? true ? true : false,
    versioned: Boolean(r.versioned),
    vectorize: Boolean(r.vectorize),
    vectorizeModel: ((r.vectorizeModel ?? r.vectorize_model) as string | null | undefined) ?? null,
    defaultSort: ((r.defaultSort ?? r.default_sort) as string | null | undefined) ?? null,
    adopted: Boolean(r.adopted),
    pkColumn: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
    hasCreatedAt: (r.hasCreatedAt ?? r.has_created_at) === false ? false : true,
    hasUpdatedAt: (r.hasUpdatedAt ?? r.has_updated_at) === false ? false : true,
    createdAtColumn: ((r.createdAtColumn ?? r.created_at_column) as string | null | undefined) ?? null,
    updatedAtColumn: ((r.updatedAtColumn ?? r.updated_at_column) as string | null | undefined) ?? null,
    ownerIdColumn: ((r.ownerIdColumn ?? r.owner_id_column) as string | null | undefined) ?? null,
  };
};

export const collectionFromParam = (c: Context<AppBindings>) =>
  c.req.param("slug" as never) as string;

export const hasI18nField = (fields: FieldDef[]): boolean =>
  fields.some((f) => f.type === "i18n_text");
