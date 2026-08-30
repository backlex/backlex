/**
 * Record share-links — public, unauthenticated, read-only links to a single
 * record. The plaintext token (`svl_<hex>`) is returned exactly once on
 * creation; only its SHA-256 hash is persisted. Links never expire but are
 * revocable (`revoked_at`).
 *
 * Mirrors `services/api-keys.ts` for the hash/random helpers and degrades
 * gracefully when the `shared_links` table hasn't been migrated yet (the
 * production D1 migration is a separate manual step) — reads/writes wrapped
 * in try/catch the same way `services/email-config.ts` does.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.sharedLinks : sqlite.schema.sharedLinks;

const TOKEN_PREFIX = "svl";
const TOKEN_BYTES = 24;

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** SHA-256 hex digest — same scheme as `services/api-keys.ts::hashKey`. */
export const hashToken = async (raw: string): Promise<string> => {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

export interface SharedLinkRow {
  id: string;
  tenantId: string | null;
  collection: string;
  itemId: string;
  tokenHash: string;
  createdBy: string | null;
  revokedAt: Date | number | null;
  createdAt: Date | number | null;
}

/**
 * Mint a new share link for `(collection, itemId)`. Returns the row plus the
 * one-time plaintext token — store the hash, never the plaintext.
 */
export const createSharedLink = async (
  ctx: DbCtx,
  input: {
    tenantId: string | null;
    collection: string;
    itemId: string;
    createdBy: string | null;
  },
): Promise<{ row: SharedLinkRow; token: string }> => {
  const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const tokenHash = await hashToken(token);
  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: input.tenantId,
    collection: input.collection,
    itemId: input.itemId,
    tokenHash,
    createdBy: input.createdBy,
    revokedAt: null,
    createdAt: now,
  });
  return {
    row: {
      id,
      tenantId: input.tenantId,
      collection: input.collection,
      itemId: input.itemId,
      tokenHash,
      createdBy: input.createdBy,
      revokedAt: null,
      createdAt: now,
    },
    token,
  };
};

/**
 * "Belongs to the caller's workspace."
 *
 * `shared_links.tenant_id` is nullable because the create path stamps
 * `auth.tenantId ?? null`, so a link minted with no active workspace is stored
 * with a NULL owner. Matching NULL with `eq` never succeeds in SQL, so the two
 * cases are branched explicitly: a caller inside a workspace sees that
 * workspace's links, a caller with no workspace sees exactly the ownerless ones
 * they could have created. Neither can see the other's.
 *
 * Note this is deliberately NOT the `or(eq(tenantId), isNull(tenantId))` shape
 * used for genuinely global rows elsewhere. A share link is never global — an
 * ownerless one is an artefact of how it was minted, not a resource the whole
 * instance shares — and OR-ing the two would hand every workspace a set of rows
 * none of them owns.
 */
const ownedBy = (t: any, tenantId: string | null) =>
  tenantId === null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);

/**
 * Active (non-revoked) links for a record. Degrades to an empty list if the
 * table doesn't exist yet.
 */
export const listSharedLinks = async (
  ctx: DbCtx,
  tenantId: string | null,
  collection: string,
  itemId: string,
): Promise<SharedLinkRow[]> => {
  const t = tableFor(ctx.dialect);
  try {
    return (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        and(
          ownedBy(t, tenantId),
          eq(t.collection, collection),
          eq(t.itemId, itemId),
          isNull(t.revokedAt),
        ),
      )
      .orderBy(desc(t.createdAt))) as SharedLinkRow[];
  } catch {
    return [];
  }
};

/** Fetch a single link by id, within one workspace (revoked or not). Null if
 *  missing, owned by another workspace, or the table does not exist. */
export const getSharedLinkById = async (
  ctx: DbCtx,
  tenantId: string | null,
  id: string,
): Promise<SharedLinkRow | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(ownedBy(t, tenantId), eq(t.id, id)))
      .limit(1)) as SharedLinkRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

/** Revoke a link by id, within one workspace (idempotent — sets `revoked_at`
 *  if not already set).
 *
 *  The predicate is repeated here rather than left to the caller's prior read.
 *  `getSharedLinkById` already scopes, so in today's only caller this UPDATE
 *  could not stray — but a write that is safe only because of what someone
 *  else read is safe until the next caller. Containment on the statement that
 *  mutates is the version that survives being called from somewhere new. */
export const revokeSharedLink = async (
  ctx: DbCtx,
  tenantId: string | null,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any)
    .update(t)
    .set({ revokedAt: now })
    .where(and(ownedBy(t, tenantId), eq(t.id, id)));
};

/**
 * Resolve a plaintext token to its link row. Returns null when the token is
 * unknown, the link is revoked, or the table doesn't exist yet.
 */
export const resolveSharedLink = async (
  ctx: DbCtx,
  token: string,
): Promise<SharedLinkRow | null> => {
  if (!token || !token.startsWith(`${TOKEN_PREFIX}_`)) return null;
  const tokenHash = await hashToken(token);
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tokenHash, tokenHash))
      .limit(1)) as SharedLinkRow[];
    const row = rows[0];
    if (!row) return null;
    if (row.revokedAt) return null;
    return row;
  } catch {
    return null;
  }
};
