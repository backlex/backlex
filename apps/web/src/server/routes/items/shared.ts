import type { Context } from "hono";
import type { AuthSubject } from "@backlex/core";
import type { AppBindings } from "../../app";
import { elapsedMs, keepAlive, recordActivity, requestMeta } from "../../services/activity";
import { resolvePermission } from "../../services/permissions";
import type { CollectionRow } from "../../services/items/collection-loader";

/**
 * Fire-and-forget sensitive-read audit. No-op unless the collection opted in
 * via `auditReads`. Records an `access.read` activity row with **metadata only**
 * (who / when / ip + query shape, result count, item id(s)) — never the row
 * bodies, which would re-store the very sensitive data the audit exists to
 * protect. Runs inside `keepAlive` (waitUntil) so reads take zero added latency,
 * and `recordActivity` swallows its own errors so a failed insert never fails
 * the read. The `access.` prefix keeps these rows on their own Logs lens +
 * shorter retention (see ACCESS_AUDIT_RETENTION_DAYS in services/scheduler.ts).
 */
export const auditRead = (
  c: Context<AppBindings>,
  collection: CollectionRow,
  itemId: string | null,
  payload: Record<string, unknown>,
): void => {
  if (!collection.auditReads) return;
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  keepAlive(
    c,
    recordActivity(
      { db: ctx.db, dialect: ctx.dialect },
      {
        userId: auth.userId,
        tenantId: auth.tenantId ?? null,
        action: "access.read",
        collection: collection.slug,
        itemId,
        ...requestMeta(c.req.raw),
        payload,
        durationMs: elapsedMs(c),
      },
    ),
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
