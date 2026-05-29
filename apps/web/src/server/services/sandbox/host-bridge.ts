import { and, eq, sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  compileCondition,
  type FieldDef,
  type FieldType,
} from "@backlex/db";
import type { Condition } from "@backlex/core";
import { resolvePermission } from "../permissions";
import type { Ctx } from "../../context";
import type { RpcOp, SandboxBindings } from "./types";

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

interface CollectionShape {
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean | number;
}

const loadCollection = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  slug: string,
): Promise<CollectionShape | null> => {
  if (!tenantId) return null;
  const t = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    slug: r.slug,
    physicalTable: r.physicalTable ?? r.physical_table,
    fields: r.fields,
    ownerScoped: r.ownerScoped ?? r.owner_scoped,
  };
};

const queryAll = async <T>(ctx: Ctx, q: SQL): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as any).execute(q)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r)
      return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await (ctx.db as any).all(q)) as T[];
};

const camel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const deserialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value == null) return value;
  if (dialect === "sqlite") {
    if (type === "json") {
      return typeof value === "string" ? JSON.parse(value) : value;
    }
    if (type === "boolean") return Boolean(value);
    if (type === "timestamp") return new Date(value as number).toISOString();
  }
  return value;
};

const renderRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  ownerScoped: boolean,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: row.id,
    createdAt: deserialize(row.created_at, "timestamp", dialect),
    updatedAt: deserialize(row.updated_at, "timestamp", dialect),
  };
  if (ownerScoped) out.ownerId = row.owner_id ?? null;
  for (const f of fields) {
    out[camel(f.name)] = deserialize(row[f.name], f.type, dialect);
  }
  return out;
};

const isAllowedFetch = (rawUrl: string, allowlist: string[]): boolean => {
  if (allowlist.length === 0) return false;
  if (allowlist.includes("*")) return true;
  try {
    const u = new URL(rawUrl);
    return allowlist.some((host) => u.host === host || u.host.endsWith(`.${host}`));
  } catch {
    return false;
  }
};

/**
 * Single dispatcher used by every provider's host-side RPC handler. Translates
 * an `RpcOp` from the sandbox into a permission-checked operation on the live
 * Ctx. Callers (provider implementations) are responsible for serializing
 * arguments and the return value.
 */
export const dispatchRpc = async (
  bindings: SandboxBindings,
  op: RpcOp,
  rawArgs: unknown,
): Promise<unknown> => {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (op === "fetch") {
    const url = String(args.url ?? "");
    const init = args.init as RequestInit | undefined;
    const allowlist = (bindings.ctx.env.FUNCTIONS_FETCH_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!isAllowedFetch(url, allowlist)) {
      throw new Error(`URL not in fetch allow-list: ${url}`);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  }

  if (op === "db.list") {
    const slug = String(args.slug ?? "");
    const query = (args.query ?? {}) as {
      filter?: Condition;
      sort?: string;
      limit?: number;
      offset?: number;
    };
    const collection = await loadCollection(bindings.ctx, bindings.auth.tenantId, slug);
    if (!collection) throw new Error(`Collection "${slug}" not found`);
    const perm = await resolvePermission(
      bindings.ctx,
      bindings.auth,
      slug,
      "read",
    );
    if (!perm.allowed) throw new Error(`No read permission on "${slug}"`);
    const table = collection.physicalTable;
    const userWhere = query.filter
      ? compileCondition(query.filter, bindings.auth)
      : null;
    const wheres = [userWhere, perm.whereSql].filter(
      (x): x is SQL => x != null,
    );
    const whereClause = wheres.length
      ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
      : sql``;
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const rows = await queryAll<Record<string, unknown>>(
      bindings.ctx,
      sql`SELECT * FROM ${sql.identifier(table)} ${whereClause} LIMIT ${limit} OFFSET ${offset}`,
    );
    return rows.map((r) =>
      renderRow(
        r,
        collection.fields,
        bindings.ctx.dialect,
        !!collection.ownerScoped,
      ),
    );
  }

  if (op === "db.one") {
    const slug = String(args.slug ?? "");
    const id = String(args.id ?? "");
    const collection = await loadCollection(bindings.ctx, bindings.auth.tenantId, slug);
    if (!collection) throw new Error(`Collection "${slug}" not found`);
    const perm = await resolvePermission(
      bindings.ctx,
      bindings.auth,
      slug,
      "read",
    );
    if (!perm.allowed) throw new Error(`No read permission on "${slug}"`);
    const table = collection.physicalTable;
    const wheres: SQL[] = [sql`${sql.identifier("id")} = ${id}`];
    if (perm.whereSql) wheres.push(perm.whereSql);
    const rows = await queryAll<Record<string, unknown>>(
      bindings.ctx,
      sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
    );
    if (!rows[0]) return null;
    return renderRow(
      rows[0],
      collection.fields,
      bindings.ctx.dialect,
      !!collection.ownerScoped,
    );
  }

  if (op === "email.send") {
    const transport = await bindings.ctx.emailFor(bindings.auth.tenantId);
    await transport.send(
      args as { to: string; subject: string; text: string; html?: string },
    );
    return true;
  }

  throw new Error(`unknown rpc op: ${op}`);
};
