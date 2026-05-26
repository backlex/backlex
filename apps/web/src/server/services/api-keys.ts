import { and, eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.apiKeys : sqlite.schema.apiKeys;

const roleTablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? { roles: pg.schema.roles, userRoles: pg.schema.userRoles }
    : { roles: sqlite.schema.roles, userRoles: sqlite.schema.userRoles };

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
  tenantId: string | null;
  prefix: string;
  hashedKey: string;
  name: string;
  userId: string;
  roleId: string | null;
  expiresAt: Date | number | null;
  lastUsedAt: Date | number | null;
  revokedAt: Date | number | null;
  /** MCP per-key tool allowlist. `null` = unrestricted (the key can call
   *  any MCP tool the server exposes, subject to permissions). When set,
   *  only the named tools are callable; the dispatcher filters `tools/list`
   *  + 403s any out-of-list `tools/call`. See `mcp/dispatch.ts`. */
  mcpTools: string[] | null;
  /** When true, MCP refuses every write tool for this key regardless of
   *  the permissions DSL. REST surface for the same identity is unaffected. */
  mcpReadOnly: boolean | number;
}

/**
 * Validate that `roleId` can legitimately be bound to a key owned by
 * `ownerUserId` in `tenantId`. Throws `AppError` otherwise. The rule: the
 * role must exist in the active workspace *and* the owner must currently
 * hold it — so a key can never grant more than its owner already has.
 */
export const assertRoleBindable = async (
  ctx: DbCtx,
  tenantId: string,
  ownerUserId: string,
  roleId: string,
): Promise<void> => {
  const t = roleTablesFor(ctx.dialect);
  const exists = (await (ctx.db as any)
    .select({ id: t.roles.id })
    .from(t.roles)
    .where(and(eq(t.roles.id, roleId), eq(t.roles.tenantId, tenantId)))
    .limit(1)) as { id: string }[];
  if (!exists[0]) throw new AppError("NOT_FOUND", "Role not found in this workspace");
  const held = (await (ctx.db as any)
    .select({ roleId: t.userRoles.roleId })
    .from(t.userRoles)
    .where(and(eq(t.userRoles.userId, ownerUserId), eq(t.userRoles.roleId, roleId)))
    .limit(1)) as { roleId: string }[];
  if (!held[0]) {
    throw new AppError(
      "FORBIDDEN",
      "Cannot scope a key to a role the owner does not hold",
    );
  }
};

/** Roles the caller may bind to a new key, for the active workspace.
 *  Admins see every role in the workspace; everyone else sees only the
 *  roles they hold (a key can't widen its owner's access). */
export const bindableRoles = async (
  ctx: DbCtx,
  tenantId: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ id: string; name: string; admin: boolean }[]> => {
  const t = roleTablesFor(ctx.dialect);
  if (isAdmin) {
    return (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.roles)
      .where(eq(t.roles.tenantId, tenantId))) as {
      id: string;
      name: string;
      admin: boolean;
    }[];
  }
  return (await (ctx.db as any)
    .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(and(eq(t.userRoles.userId, userId), eq(t.roles.tenantId, tenantId)))) as {
    id: string;
    name: string;
    admin: boolean;
  }[];
};

export const createApiKey = async (
  ctx: DbCtx,
  input: {
    name: string;
    userId: string;
    tenantId: string;
    roleId?: string | null;
    expiresAt?: Date | null;
    mcpTools?: string[] | null;
    mcpReadOnly?: boolean;
  },
): Promise<{ row: ApiKeyRow; secret: string }> => {
  const prefix = `${KEY_PREFIX}_${randomHex(PREFIX_LEN / 2)}`;
  const secretPart = randomHex(SECRET_LEN);
  const fullKey = `${prefix}_${secretPart}`;
  const hashed = await hashKey(secretPart);
  const id = crypto.randomUUID();
  const t = tableFor(ctx.dialect);
  const roleId = input.roleId ?? null;
  const expiresAt = input.expiresAt
    ? ctx.dialect === "pg"
      ? input.expiresAt
      : input.expiresAt.getTime()
    : null;
  // Default-deny: new keys ship with an empty allowlist so a freshly issued
  // pak_* can't call any MCP tool until the owner explicitly opts in. A
  // caller can still pass `mcpTools: null` to mint a permissive key on
  // purpose (so we discriminate `undefined` vs `null` here rather than `??`).
  // Existing pre-default keys with stored NULL keep their permissive shape.
  const mcpTools = input.mcpTools === undefined ? [] : input.mcpTools;
  const mcpReadOnly = input.mcpReadOnly ?? false;
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: input.tenantId,
    prefix,
    hashedKey: hashed,
    name: input.name,
    userId: input.userId,
    roleId,
    expiresAt,
    mcpTools,
    mcpReadOnly,
  });
  return {
    row: {
      id,
      tenantId: input.tenantId,
      prefix,
      hashedKey: hashed,
      name: input.name,
      userId: input.userId,
      roleId,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      mcpTools,
      mcpReadOnly,
    },
    secret: fullKey,
  };
};

/** Update the MCP guardrails on an existing key. Either field can be
 *  individually nullable / omitted to leave the other untouched. Owner
 *  scoping (the caller can only mutate keys they own) is enforced in the
 *  route layer; this helper just runs the UPDATE. */
export const updateApiKeyMcpGuards = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
  patch: { mcpTools?: string[] | null; mcpReadOnly?: boolean },
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const set: Record<string, unknown> = {};
  if (patch.mcpTools !== undefined) set.mcpTools = patch.mcpTools;
  if (patch.mcpReadOnly !== undefined) set.mcpReadOnly = patch.mcpReadOnly;
  if (Object.keys(set).length === 0) return;
  await (ctx.db as any)
    .update(t)
    .set(set)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
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
  tenantId: string,
  userId: string | null,
): Promise<ApiKeyRow[]> => {
  const t = tableFor(ctx.dialect);
  const where = userId
    ? and(eq(t.tenantId, tenantId), eq(t.userId, userId))
    : eq(t.tenantId, tenantId);
  return (await (ctx.db as any).select().from(t).where(where)) as ApiKeyRow[];
};

export const revokeApiKey = async (
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any)
    .update(t)
    .set({ revokedAt: now })
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
};
