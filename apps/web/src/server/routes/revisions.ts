import { Hono, type Context } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@workeros/core";
import { type FieldDef } from "@workeros/db";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import {
  getRevision,
  listRevisions,
  recordRevision,
} from "../services/revisions";
import { and, eq } from "drizzle-orm";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

interface CollectionRow {
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean;
}

const loadCollection = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
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
  return {
    slug: r.slug as string,
    physicalTable: (r.physicalTable ?? r.physical_table) as string,
    fields: r.fields as FieldDef[],
    ownerScoped: Boolean(r.ownerScoped ?? r.owner_scoped),
  };
};

const collectionFromParam = (c: Context<AppBindings>) =>
  c.req.param("collection" as never) as string;

export const revisionsRoutes = new Hono<AppBindings>()
  .get(
    "/:collection/:itemId",
    requirePermission(collectionFromParam, "read"),
    async (c) => {
      const ctx = c.get("ctx");
      const rows = await listRevisions(
        ctx,
        c.req.param("collection"),
        c.req.param("itemId"),
      );
      return c.json({ data: rows });
    },
  )
  .post(
    "/:id/revert",
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) {
        throw new AppError("UNAUTHORIZED", "Sign in required");
      }
      const rev = await getRevision(ctx, c.req.param("id"));
      if (!rev) throw new AppError("NOT_FOUND", "Revision not found");

      // Permission check on the target collection (update).
      // We re-resolve here rather than via middleware, since the target slug
      // is dynamic from the revision row.
      const { resolvePermission } = await import("../services/permissions");
      const perm = await resolvePermission(ctx, auth, rev.collection, "update");
      if (!perm.allowed) {
        throw new AppError(
          "FORBIDDEN",
          `No update permission on ${rev.collection}`,
        );
      }

      const collection = await loadCollection(ctx, auth.tenantId, rev.collection);
      const table = collection.physicalTable;
      const snapshot = rev.snapshot;

      // Re-write the snapshot fields back. id stays the same.
      const sets: SQL[] = [];
      const now = ctx.dialect === "pg" ? new Date() : Date.now();
      sets.push(sql`${sql.identifier("updated_at")} = ${now}`);
      for (const f of collection.fields) {
        const v = snapshot[f.name];
        if (v === undefined) continue;
        const serialized =
          ctx.dialect === "sqlite"
            ? f.type === "json"
              ? JSON.stringify(v)
              : f.type === "boolean"
                ? v
                  ? 1
                  : 0
                : v
            : v;
        sets.push(sql`${sql.identifier(f.name)} = ${serialized}`);
      }

      const exec =
        ctx.dialect === "pg"
          ? (q: SQL) => (ctx.db as any).execute(q)
          : (q: SQL) => (ctx.db as any).run(q);
      await exec(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.identifier("id")} = ${rev.itemId}`,
      );

      // Record a new revision documenting the revert.
      void recordRevision(ctx, {
        collection: rev.collection,
        itemId: rev.itemId,
        snapshot,
        userId: auth.userId,
      });

      return c.json({ ok: true });
    },
  );
