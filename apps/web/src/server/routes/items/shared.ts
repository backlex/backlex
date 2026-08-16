import type { Context } from "hono";
import type { AuthSubject } from "@backlex/core";
import type { AppBindings } from "../../app";
import { elapsedMs, keepAlive, requestMeta } from "../../services/activity";
import { recordSensitiveRead } from "../../services/items/read-audit";
import { resolvePermission } from "../../services/permissions";
import type { CollectionRow } from "../../services/items/collection-loader";

/**
 * Fire-and-forget sensitive-read audit, for the REST surface.
 *
 * A thin adapter over `services/items/read-audit.ts::recordSensitiveRead` —
 * this function's whole job is to turn a Hono `Context` into the four values
 * that service needs. The rules (opt-in gate, metadata only, never awaited)
 * live there, because GraphQL has no `Context` and used to write no audit rows
 * at all as a result. A second implementation for the second surface is exactly
 * how the two drift; the WRITE path already shares one chokepoint and the read
 * path now does too.
 *
 * Runs inside `keepAlive` (waitUntil) so reads take zero added latency. The
 * `access.` prefix keeps these rows on their own Logs lens + shorter retention
 * (see ACCESS_AUDIT_RETENTION_DAYS in services/scheduler.ts).
 */
export const auditRead = (
  c: Context<AppBindings>,
  collection: CollectionRow,
  itemId: string | null,
  payload: Record<string, unknown>,
): void => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  keepAlive(
    c,
    recordSensitiveRead({ db: ctx.db, dialect: ctx.dialect }, collection, {
      userId: auth.userId,
      tenantId: auth.tenantId ?? null,
      itemId,
      payload,
      ...requestMeta(c.req.raw),
      durationMs: elapsedMs(c),
    }),
  );
};

/**
 * Whether the caller may see drafts of a versioned collection. Admins and
 * holders of `publish` or `update` permission on the collection do; everyone
 * else gets published-only reads. Returns false for non-versioned collections
 * (no status filter is applied to them).
 */
export const canSeeDraftsFor = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  perm: { isAdmin?: boolean },
): Promise<boolean> => {
  if (!collection.versioned) return false;
  if (perm.isAdmin) return true;
  const dbctx = { db: ctx.db as any, dialect: ctx.dialect };
  if ((await resolvePermission(dbctx, auth, collection.slug, "publish")).allowed) return true;
  return (await resolvePermission(dbctx, auth, collection.slug, "update")).allowed;
};
