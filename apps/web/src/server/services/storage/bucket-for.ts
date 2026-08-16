/**
 * Which bucket an object belongs in — the one place that decides.
 *
 * **The hole this closes.** Enabling R2's dev URL (`wrangler r2 bucket dev-url
 * enable …`) makes *every* object in that bucket fetchable at
 * `https://pub-<hash>.r2.dev/<key>` by anyone who knows the key. The product
 * needs that URL: it is how a public image gets resized by Cloudflare's edge
 * instead of streaming its bytes through the Worker. But a workspace's private
 * files, its backups, its generated PDFs and its avatars all sat in the same
 * bucket, so the feature that made public assets fast also made everything
 * else reachable by anyone who could guess `tenants/<uuid>/<name>`. `acl` was
 * enforced only at the Worker, and the Worker is exactly what that URL skips.
 *
 * A flag on `put()` cannot fix it — the object has to be in a different bucket,
 * because the exposure is a property of the bucket. Hence a second adapter, and
 * hence this function: one answer to "where does this live", so a new caller
 * cannot quietly invent a second one.
 *
 * **The rule is narrow on purpose: only a `files` row with `acl: "public"` goes
 * to the public bucket.** Everything else — private files, and every writer
 * that does not go through `files` at all (`backups/…`, `documents/…`,
 * `account/<id>/avatar`, CDC exports, integration artifacts) — stays in the
 * private bucket. Those have no `acl` column to consult, and defaulting them by
 * key prefix would be a list to keep in step with; defaulting them to private
 * is a rule that cannot rot.
 *
 * **Absent second bucket = today's behaviour, exactly.** Every existing
 * deployment runs one bucket, and `bucketFor` hands back `ctx.storage` for
 * everything, so nothing moves and nothing breaks. Splitting is opt-in
 * (`R2_PUBLIC` / `S3_PUBLIC_BUCKET`) and comes with a migration route.
 */
import type { StorageAdapter } from "@backlex/core/adapters";

/** The subset of `Ctx` this needs. Structural so a service can pass a narrowed
 *  object and a test can pass a pair of fakes. */
export interface BucketCtx {
  storage: StorageAdapter;
  publicStorage?: StorageAdapter;
}

/** A file row's ACL. `null`/absent is read as private — the column's own
 *  default, and the safe direction for a row written before the column existed. */
export type FileAcl = "public" | "private" | null | undefined;

/** True when this deployment keeps public objects in their own bucket. */
export const hasSplitBuckets = (ctx: BucketCtx): boolean =>
  Boolean(ctx.publicStorage);

/**
 * The adapter that holds — or should hold — an object with this ACL.
 *
 * Note it answers the same thing for a read and for a write, deliberately: an
 * object is read from where its row says it is. When the row's ACL changes, the
 * OBJECT is moved (see `moveBetweenBuckets`) rather than the read being taught
 * to look in two places, because "look in both" is how a half-migrated bucket
 * pair stays half-migrated forever.
 */
export const bucketFor = (ctx: BucketCtx, acl: FileAcl): StorageAdapter =>
  acl === "public" && ctx.publicStorage ? ctx.publicStorage : ctx.storage;

/**
 * Delete an object from EVERY bucket, without asking which one it is in.
 *
 * The one place the "single answer" rule above is deliberately inverted, and
 * the reason is asymmetry of harm. A read from the wrong bucket is a 404 —
 * visible, recoverable, and the caller knows something is wrong. A *delete*
 * from the wrong bucket is a silent no-op (delete is idempotent by contract on
 * every adapter), so the row disappears while the bytes stay exactly where they
 * were: fetchable at the public URL, with nothing left in the database that
 * points at them, so nothing can ever find them again.
 *
 * That failure is not hypothetical. Data-subject erasure and the playground
 * reset both select `{ key }` alone — no `acl` to route on — and would have
 * reported a complete erasure while leaving the person's public files served
 * forever. A caller that cannot know the ACL should not have to.
 *
 * Best-effort per bucket: an unreachable public bucket must not abort a
 * deletion that has already removed rows, so failures are returned rather than
 * thrown and the caller decides.
 */
export const deleteEverywhere = async (
  ctx: BucketCtx,
  key: string,
): Promise<{ ok: boolean }> => {
  let ok = true;
  for (const adapter of [ctx.storage, ctx.publicStorage]) {
    if (!adapter) continue;
    try {
      await adapter.delete(key);
    } catch {
      ok = false;
    }
  }
  return { ok };
};

/**
 * Remove whatever the OTHER bucket still holds under this key.
 *
 * Needed by the two write paths that can change an object's side without going
 * through `moveBetweenBuckets`: `/from-url` re-importing over an existing key
 * with a different ACL, and the migration sweep re-running over a row it half
 * moved. Delete is idempotent on every adapter, so this is a no-op when there
 * is nothing there — which is the common case and must stay cheap.
 *
 * Best-effort by contract: the object is already correctly placed by the time
 * this runs, so a failure to tidy the old copy must not fail the request. It
 * is reported, because a lingering public copy is the thing the split exists
 * to prevent and somebody has to be able to find out.
 */
export const dropStaleCopy = async (
  ctx: BucketCtx,
  key: string,
  keptIn: FileAcl,
): Promise<void> => {
  if (!ctx.publicStorage) return;
  const other = keptIn === "public" ? ctx.storage : ctx.publicStorage;
  try {
    await other.delete(key);
  } catch (e) {
    console.error(
      `[storage] could not remove the stale copy of "${key}" from the ${
        keptIn === "public" ? "private" : "public"
      } bucket`,
      e,
    );
  }
};

/**
 * Move one object to the bucket its new ACL calls for.
 *
 * Order is load-bearing: **copy, then delete.** A crash between the two leaves
 * a duplicate — wasted bytes, no lost data, and the next run of the migration
 * sweep tidies it. The other order leaves a `files` row pointing at nothing,
 * which is data loss with a 404 in front of it.
 *
 * Returns `false` when there was nothing to do (no split configured, or the
 * object is already in the right place), so callers can report honestly rather
 * than claiming a move they did not make. Throws when the source object is
 * missing — a row whose bytes are gone is a real problem and must not be
 * silently "moved".
 */
export const moveBetweenBuckets = async (
  ctx: BucketCtx,
  key: string,
  from: FileAcl,
  to: FileAcl,
): Promise<boolean> => {
  if (!ctx.publicStorage) return false;
  const src = bucketFor(ctx, from);
  const dst = bucketFor(ctx, to);
  if (src === dst) return false;

  const obj = await src.get(key);
  if (!obj) {
    throw new Error(
      `storage object "${key}" is missing from its current bucket — refusing to move a row whose bytes are already gone`,
    );
  }
  await dst.put({
    key,
    body: obj.body,
    contentType: obj.meta.contentType,
  });
  await src.delete(key);
  return true;
};
