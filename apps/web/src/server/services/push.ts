import { and, eq, inArray, isNull, or } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import { renderTemplate } from "@backlex/core";
import type { PushAdapter, PushSendResult, PushToken } from "@backlex/core/adapters";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.deviceTokens : sqlite.schema.deviceTokens;

const templateTableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.pushTemplates : sqlite.schema.pushTemplates;

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
  //
  // Scoped with the SAME predicate the SELECT above used, not by token value
  // alone. `device_tokens` is keyed on `(tenant_id, user_id, token)`, and one
  // physical device registered in two workspaces is one token in two rows — so
  // an unscoped UPDATE let workspace A's provider rejection deactivate
  // workspace B's live registration, in a table B's admin has no reason to
  // look at. Narrowing to the rows this send actually addressed also means the
  // statement can only ever touch what it just tried to deliver to.
  if (result.invalidTokens.length > 0) {
    try {
      await (ctx.db as any)
        .update(t)
        .set({ isActive: false })
        .where(and(where, inArray(t.token, result.invalidTokens)));
    } catch {
      // best-effort cleanup; never fail the send over pruning
    }
  }
  return result;
};

interface PushTemplateRow {
  id: string;
  tenantId: string | null;
  key: string;
  title: string;
  body: string;
  url: string | null;
}

/**
 * Resolve a push template by key with tenant override → global
 * (`tenant_id IS NULL`) fallback. Returns null if neither exists.
 *
 * The same resolution `resolveTemplate` does for email, against a table with
 * the same shape (nullable `tenant_id`, unique `(tenant_id, key)`) — which is
 * what made wiring this up the right call rather than deleting the store: the
 * override model was already built, only the send path was missing.
 */
export const resolvePushTemplate = async (
  ctx: Pick<DbCtx, "db" | "dialect">,
  key: string,
  tenantId: string | null,
): Promise<PushTemplateRow | null> => {
  const t = templateTableFor(ctx.dialect);
  const where =
    tenantId == null
      ? and(eq(t.key, key), isNull(t.tenantId))
      : and(eq(t.key, key), or(eq(t.tenantId, tenantId), isNull(t.tenantId)));
  const rows = (await (ctx.db as any).select().from(t).where(where)) as PushTemplateRow[];
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    if (a.tenantId === tenantId && b.tenantId !== tenantId) return -1;
    if (b.tenantId === tenantId && a.tenantId !== tenantId) return 1;
    return 0;
  });
  return rows[0]!;
};

export interface SendTemplatedPushOptions {
  userIds: string[];
  /** When set, title/body/url are rendered from the matching `push_templates`
   *  row. `fallback` is used when the key resolves to nothing. */
  templateKey?: string | undefined;
  /** Variables available to `{{ … }}` placeholders. */
  vars?: Record<string, unknown> | undefined;
  fallback?: { title?: string | undefined; body?: string | undefined; url?: string | undefined };
  data?: Record<string, string> | undefined;
  badge?: number | undefined;
  icon?: string | undefined;
}

export interface SendTemplatedPushResult extends PushSendResult {
  templateKey: string | null;
  /** True when a row was found and rendered; false when `fallback` was used. */
  templateApplied: boolean;
}

/**
 * Send a push through a stored template, falling back to literal title/body.
 * The push twin of `sendTemplatedEmail`, and the reason `push_templates`
 * exists: until this landed, the only code that rendered one was the admin
 * route's own `/send-test`, so the store had a preview and no send path —
 * while `docs/push-messaging.md` told readers otherwise.
 *
 * Throws when neither the template nor the fallback yields a title and a body,
 * matching `sendTemplatedEmail`: a push with no text is not worth sending
 * quietly.
 */
export const sendTemplatedPush = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
  opts: SendTemplatedPushOptions,
): Promise<SendTemplatedPushResult> => {
  const vars = opts.vars ?? {};
  const tpl = opts.templateKey
    ? await resolvePushTemplate(ctx, opts.templateKey, tenantId ?? null)
    : null;

  const title = tpl ? renderTemplate(tpl.title, vars) : opts.fallback?.title;
  const body = tpl ? renderTemplate(tpl.body, vars) : opts.fallback?.body;
  const url = tpl
    ? tpl.url
      ? renderTemplate(tpl.url, vars)
      : undefined
    : opts.fallback?.url;

  if (!title || !body) {
    throw new Error(
      opts.templateKey
        ? `Push template "${opts.templateKey}" not found and no fallback provided`
        : "sendTemplatedPush requires a templateKey or a fallback with title + body",
    );
  }

  const result = await sendPushToUsers(ctx, tenantId, {
    userIds: opts.userIds,
    title,
    body,
    url,
    icon: opts.icon,
    badge: opts.badge,
    data: opts.data,
  });
  return { ...result, templateKey: opts.templateKey ?? null, templateApplied: Boolean(tpl) };
};
