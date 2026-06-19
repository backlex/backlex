import { and, eq, inArray } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { PushAdapter, PushSendResult, PushToken } from "@backlex/core/adapters";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.deviceTokens : sqlite.schema.deviceTokens;

export interface PushDispatch {
  /** Recipients. Omit/empty = no targets (push only ever goes to known devices,
   *  never broadcast — caller must resolve a recipient set first). */
  userIds: string[];
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: number;
  data?: Record<string, string>;
}

interface DbCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  pushFor: (tenantId: string | null | undefined) => Promise<PushAdapter>;
}

/**
 * Send a push to a set of users' active devices for one workspace. Loads the
 * recipients' `device_tokens`, resolves the workspace push transport, sends,
 * and deactivates any tokens the provider reported as permanently invalid
 * (so the next send skips them). Returns `{ sent, failed, invalidTokens }`;
 * a recipient set with no registered devices is a no-op.
 */
export const sendPushToUsers = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
  dispatch: PushDispatch,
): Promise<PushSendResult> => {
  if (dispatch.userIds.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };
  const t = tableFor(ctx.dialect);

  const where =
    tenantId == null
      ? and(inArray(t.userId, dispatch.userIds), eq(t.isActive, true))
      : and(
          inArray(t.userId, dispatch.userIds),
          eq(t.isActive, true),
          eq(t.tenantId, tenantId),
        );
  const rows = (await (ctx.db as any).select().from(t).where(where)) as {
    platform: string;
    token: string;
    keys: { p256dh: string; auth: string } | null;
  }[];
  if (rows.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };

  const tokens: PushToken[] = rows.map((r) => ({
    platform: r.platform as PushToken["platform"],
    token: r.token,
    keys: r.keys ?? undefined,
  }));

  const adapter = await ctx.pushFor(tenantId ?? null);
  const result = await adapter.send({
    tokens,
    title: dispatch.title,
    body: dispatch.body,
    url: dispatch.url,
    icon: dispatch.icon,
    badge: dispatch.badge,
    data: dispatch.data,
  });

  // Deactivate tokens the provider rejected as gone — keep the row (a
  // re-register revives it via the unique index) but stop targeting it.
  if (result.invalidTokens.length > 0) {
    try {
      await (ctx.db as any)
        .update(t)
        .set({ isActive: false })
        .where(inArray(t.token, result.invalidTokens));
    } catch {
      // best-effort cleanup; never fail the send over pruning
    }
  }
  return result;
};
