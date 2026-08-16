/**
 * Sensitive-read auditing, with no Hono context in it.
 *
 * The `access.read` row used to be written only from `routes/items/shared.ts`,
 * which needs a Hono `Context` — so GraphQL, which has none, wrote nothing. A
 * workspace could turn `auditReads` on for its patient records, watch the log
 * fill up from the admin UI, and have every read through `/api/graphql` leave
 * no trace at all. The gap is the worse kind: the feature appears to work.
 *
 * The fix is the one the WRITE path already uses — a shared service both
 * surfaces call, rather than a second implementation for the second surface.
 * `routes/items/shared.ts::auditRead` is now a four-line adapter over this, and
 * the GraphQL resolvers call it directly.
 *
 * Two properties this file owns, so no caller can forget either:
 *
 * 1. **The opt-in gate.** Nothing is recorded unless the collection has
 *    `auditReads`. Keeping the check here rather than at each call site means a
 *    new read path cannot audit a collection that never asked to be audited.
 * 2. **Metadata only, never row bodies.** An audit that stores what was read
 *    re-stores the very data it exists to protect — and in a table with a
 *    longer reach than the collection's own permissions. Callers pass a shape
 *    (`{count, ids}`, `{fields}`), never values.
 */
import type { DbCtx } from "../seed";
import { recordActivity } from "../activity";

/** The subset of a collection this needs. Structural so GraphQL's own row
 *  shape satisfies it without a conversion. */
export interface AuditableCollection {
  slug: string;
  auditReads?: boolean;
}

export interface SensitiveReadInput {
  userId: string | null;
  tenantId: string | null;
  /** The row read, when there is exactly one. `null` for a list/search/export,
   *  whose identities go in `payload.ids` instead. */
  itemId: string | null;
  /** Shape of the read — query, count, field names, ids. Never values. */
  payload: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
}

/**
 * Record one `access.read`, or nothing.
 *
 * Returns the promise rather than awaiting it: a read must not pay for its own
 * audit. Every caller hands it to `keepAlive` / `GqlCtx.defer` so it runs on
 * `waitUntil` where the runtime has one, and floats where it does not.
 * `recordActivity` swallows its own errors, so a failed insert can never fail
 * the read it was describing.
 */
export const recordSensitiveRead = async (
  ctx: DbCtx,
  collection: AuditableCollection,
  input: SensitiveReadInput,
): Promise<void> => {
  if (!collection.auditReads) return;
  await recordActivity(ctx, {
    userId: input.userId,
    tenantId: input.tenantId,
    action: "access.read",
    collection: collection.slug,
    itemId: input.itemId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    payload: input.payload,
    durationMs: input.durationMs ?? null,
  });
};
