// The provider-config singleton: one row per workspace, keyed on `tenant_id`,
// naming a provider and holding its settings plus an encrypted secrets blob.
// `ai_config`, `email_config`, `push_config` and `sms_config` are the same
// table four times over, and their admin endpoints were the same handler four
// times over — each with its own copy of the read, the secret merge and the
// write.
//
// The copies had drifted in the way copies do. `settings` had its
// check-then-insert replaced with an atomic upsert after a concurrent-write
// load test turned up `UNIQUE constraint failed` 500s in production (see
// routes/settings.ts); its four siblings never got the fix and still raced.
// Every one of these tables has `tenant_id` as its PRIMARY KEY, so ON CONFLICT
// is available on both dialects and there is no reason for the window to exist.
//
// What is deliberately NOT solved here: merging a secrets patch still reads the
// stored blob first, so two concurrent PATCHes to different keys still resolve
// last-writer-wins. That is unchanged behaviour and not what was crashing —
// the duplicate INSERT was. Collapsing it further would mean a read-modify-write
// inside one statement, which neither dialect offers for a JSON column.
import { eq } from "drizzle-orm";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import { encryptSecret } from "../lib/crypto";

export type ConfigDbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

/**
 * A workspace's OWN config row, or `undefined` when it has none.
 *
 * Not the same question as the `loadXConfigRow` each config service exports:
 * those walk the inheritance chain (this workspace, then the instance-wide
 * `_global` row) to answer "which provider should actually run". This answers
 * "what has this workspace configured", which is what an admin screen shows and
 * what a PATCH merges onto. Reading the chain here would make the form display
 * — and then silently re-save — a neighbouring row's settings.
 *
 * A missing table reads as "not configured" rather than throwing, so an
 * instance that has not run the migration yet shows the inherit defaults
 * instead of a 500.
 */
export const readOwnConfigRow = async <T>(
  ctx: ConfigDbCtx,
  table: { tenantId: unknown },
  tenantId: string,
): Promise<T | undefined> => {
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(table)
      .where(eq((table as any).tenantId, tenantId))
      .limit(1)) as T[];
    return rows[0];
  } catch {
    return undefined;
  }
};

/**
 * Apply a secrets patch to the stored blob: a non-blank string is encrypted and
 * written, anything else (`""`, `null`) clears that key, and a key the patch
 * does not mention keeps its stored value. That last rule is what lets an admin
 * form re-save without having to re-type every secret it is not allowed to
 * display back.
 *
 * `allowed` is an allow-list, and iterating IT rather than the request body is
 * the point: a key the caller invented is never reached, so it cannot be
 * stuffed into a blob this workspace's admins later read back. Callers pass
 * either the provider's key tuple or a predicate for a registry-gated set.
 */
export const mergeConfigSecrets = async (opts: {
  stored: Record<string, string> | null | undefined;
  patch: Record<string, unknown> | null | undefined;
  allowed: readonly string[] | ((key: string) => boolean);
  authSecret: string;
}): Promise<Record<string, string>> => {
  const merged: Record<string, string> = { ...(opts.stored ?? {}) };
  if (!opts.patch) return merged;
  const keys =
    typeof opts.allowed === "function"
      ? Object.keys(opts.patch).filter(opts.allowed)
      : opts.allowed;
  for (const key of keys) {
    if (!(key in opts.patch)) continue;
    const value = opts.patch[key];
    if (typeof value === "string" && value.trim()) {
      merged[key] = await encryptSecret(value.trim(), opts.authSecret);
    } else {
      delete merged[key];
    }
  }
  return merged;
};

/**
 * Write a workspace's config row, creating it if absent — in ONE statement.
 *
 * `always` is what the request decided and is written on both paths. `onCreate`
 * is for columns a PATCH left out: on an existing row "left out" means "leave
 * it alone", so those values only reach the INSERT. Splitting the two is how a
 * single upsert keeps the patch semantics the read-then-branch version had.
 */
export const saveOwnConfigRow = async (
  ctx: ConfigDbCtx,
  table: { tenantId: unknown },
  tenantId: string,
  values: {
    always: Record<string, unknown>;
    onCreate?: Record<string, unknown>;
  },
): Promise<void> => {
  await (ctx.db as any)
    .insert(table)
    .values({ tenantId, ...(values.onCreate ?? {}), ...values.always })
    .onConflictDoUpdate({
      target: (table as any).tenantId,
      set: {
        ...values.always,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      },
    });
};
