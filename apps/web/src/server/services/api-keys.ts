import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.apiKeys : sqlite.schema.apiKeys;

const PREFIX_LEN = 8;
const SECRET_LEN = 32;
const KEY_PREFIX = "pak";

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

export const hashKey = async (raw: string): Promise<string> => {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

export interface ApiKeyRow {
  id: string;
  prefix: string;
  hashedKey: string;
  name: string;
  userId: string;
  expiresAt: Date | number | null;
  lastUsedAt: Date | number | null;
  revokedAt: Date | number | null;
}

export const createApiKey = async (
  ctx: DbCtx,
  input: { name: string; userId: string; expiresAt?: Date | null },
): Promise<{ row: ApiKeyRow; secret: string }> => {
  const prefix = `${KEY_PREFIX}_${randomHex(PREFIX_LEN / 2)}`;
  const secretPart = randomHex(SECRET_LEN);
  const fullKey = `${prefix}_${secretPart}`;
  const hashed = await hashKey(secretPart);
  const id = crypto.randomUUID();
  const t = tableFor(ctx.dialect);
  const expiresAt = input.expiresAt
    ? ctx.dialect === "pg"
      ? input.expiresAt
      : input.expiresAt.getTime()
    : null;
  await (ctx.db as any).insert(t).values({
    id,
    prefix,
    hashedKey: hashed,
    name: input.name,
    userId: input.userId,
    expiresAt,
  });
  return {
    row: {
      id,
      prefix,
      hashedKey: hashed,
      name: input.name,
      userId: input.userId,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    },
    secret: fullKey,
  };
};

export const findApiKey = async (
  ctx: DbCtx,
  raw: string,
): Promise<ApiKeyRow | null> => {
  const idx = raw.lastIndexOf("_");
  if (idx < 0) return null;
  const prefix = raw.slice(0, idx);
  const secretPart = raw.slice(idx + 1);
  if (!prefix.startsWith(`${KEY_PREFIX}_`) || !secretPart) return null;
  const hashed = await hashKey(secretPart);
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.hashedKey, hashed))
    .limit(1)) as ApiKeyRow[];
  const row = rows[0];
  if (!row) return null;
  if (row.prefix !== prefix) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt) {
    const exp =
      row.expiresAt instanceof Date
        ? row.expiresAt.getTime()
        : Number(row.expiresAt);
    if (exp <= Date.now()) return null;
  }
  return row;
};

export const touchLastUsed = async (
  ctx: DbCtx,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any)
    .update(t)
    .set({ lastUsedAt: now })
    .where(eq(t.id, id));
};

export const listApiKeys = async (
  ctx: DbCtx,
  userId: string | null,
): Promise<ApiKeyRow[]> => {
  const t = tableFor(ctx.dialect);
  if (userId) {
    return (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.userId, userId))) as ApiKeyRow[];
  }
  return (await (ctx.db as any).select().from(t)) as ApiKeyRow[];
};

export const revokeApiKey = async (
  ctx: DbCtx,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any)
    .update(t)
    .set({ revokedAt: now })
    .where(eq(t.id, id));
};
