/**
 * Impersonation — an operator acting as one of the workspace's end-users.
 *
 * ## What was actually missing
 *
 * `permissions.simulate` already answers "would this role be allowed to do
 * this". That is a static answer about a rule, and it is not the question
 * support is asked. The question is "why does MY dashboard show nothing", and
 * answering it means seeing the application through that person's identity —
 * their org, their rows, their feature flags, their empty states.
 *
 * ## The decisions
 *
 * **The token names an impersonation ROW, and every request re-reads it.** A
 * self-contained token would be valid until it expired: "end this now" would
 * have no meaning, and the record of what happened would exist only if the
 * operator chose to write it down. One indexed lookup per impersonated
 * request — paid only while somebody is impersonating — buys instant
 * revocation and an audit trail that does not depend on cooperation.
 *
 * **A reason is required and may not be blank.** An audit trail of who acted
 * as whom, with no why, answers the easy half of the question.
 *
 * **Read-only by default.** Reproducing what a customer sees needs reads.
 * Changing their data on their behalf is a different act, and it has to be
 * asked for rather than arrived at.
 *
 * **App-plane subjects only.** One operator impersonating another is a
 * privilege move, not support, and there is no support story that needs it.
 *
 * **A hard TTL, capped in code.** The window a support session needs is
 * minutes. An impersonation that outlives the conversation is a standing
 * credential for somebody else's account.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { signAccessToken } from "../lib/jwt";
import type { Ctx } from "../context";
import type { Env } from "../env";

type AnyDb = any;

const table = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.impersonations
    : sqlite.schema.impersonations) as typeof pg.schema.impersonations;

const appUsersTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.appUsers : sqlite.schema.appUsers) as typeof pg.schema.appUsers;

/** Default window. Long enough for a support conversation, short enough that
 *  a forgotten session is not a standing credential. */
export const DEFAULT_IMPERSONATION_MINUTES = 15;
/** Hard cap, in code rather than config — an operator under pressure will
 *  choose the largest number a form lets them. */
export const MAX_IMPERSONATION_MINUTES = 60;

export interface ImpersonationRow {
  id: string;
  tenantId: string;
  actorUserId: string;
  actorEmail: string | null;
  subjectUserId: string;
  subjectEmail: string | null;
  reason: string;
  readOnly: boolean;
  expiresAt: Date | number;
  endedAt: Date | number | null;
  endedBy: string | null;
  createdAt: Date | number | null;
}

export interface ImpersonationView {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  subjectUserId: string;
  subjectEmail: string | null;
  reason: string;
  readOnly: boolean;
  expiresAt: number;
  endedAt: number | null;
  endedBy: string | null;
  createdAt: number | null;
  /** Derived, so a UI does not have to compare clocks itself. */
  active: boolean;
}

const ms = (v: Date | number | null): number | null =>
  v === null ? null : v instanceof Date ? v.getTime() : v;

export const toView = (row: ImpersonationRow, now = Date.now()): ImpersonationView => {
  const expiresAt = ms(row.expiresAt) ?? 0;
  const endedAt = ms(row.endedAt);
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    subjectUserId: row.subjectUserId,
    subjectEmail: row.subjectEmail,
    reason: row.reason,
    readOnly: Boolean(row.readOnly),
    expiresAt,
    endedAt,
    endedBy: row.endedBy,
    createdAt: ms(row.createdAt),
    active: endedAt === null && expiresAt > now,
  };
};

export interface StartInput {
  subjectUserId: string;
  reason: string;
  readOnly?: boolean;
  minutes?: number;
}

export interface StartedImpersonation {
  impersonation: ImpersonationView;
  /** A workspace access token for the SUBJECT, carrying `imp`. Returned once. */
  token: string;
  expiresAt: number;
}

export const startImpersonation = async (
  ctx: Ctx,
  tenantId: string,
  actor: { userId: string; email: string | null },
  input: StartInput,
): Promise<StartedImpersonation> => {
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3) {
    throw new AppError(
      "VALIDATION",
      "`reason` is required — an audit trail of who acted as whom, with no why, answers half the question",
    );
  }
  if (reason.length > 500) throw new AppError("VALIDATION", "`reason` is too long");
  const minutes = input.minutes ?? DEFAULT_IMPERSONATION_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_IMPERSONATION_MINUTES) {
    // Refused rather than clamped: a caller who asked for eight hours should
    // learn they cannot have it, not believe they got it.
    throw new AppError(
      "VALIDATION",
      `\`minutes\` must be 1..${MAX_IMPERSONATION_MINUTES}`,
    );
  }

  // The subject must be an END-USER of THIS workspace. Both halves matter: a
  // platform operator is not impersonatable at all, and a user of another
  // workspace is not this admin's to act as.
  const au = appUsersTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: au.id, email: au.email })
    .from(au)
    .where(and(eq(au.id, input.subjectUserId), eq(au.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string; email: string | null }>;
  const subject = rows[0];
  if (!subject) {
    throw new AppError("NOT_FOUND", "No such end-user in this workspace");
  }

  const now = Date.now();
  const expiresAt = new Date(now + minutes * 60_000);
  const row: ImpersonationRow = {
    id: crypto.randomUUID(),
    tenantId,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    subjectUserId: subject.id,
    subjectEmail: subject.email,
    reason,
    readOnly: input.readOnly !== false,
    expiresAt,
    endedAt: null,
    endedBy: null,
    createdAt: new Date(),
  };
  await (ctx.db as AnyDb).insert(table(ctx.dialect)).values(row);

  const { token } = await signAccessToken(
    ctx.env,
    {
      sub: subject.id,
      tid: tenantId,
      // No `app_sessions` row backs this. The impersonation row IS the
      // session, and it is what revocation acts on.
      sid: `imp:${row.id}`,
      email: subject.email,
    },
    minutes * 60,
    // `imp` is what makes the token an impersonation rather than a sign-in.
    // The middleware refuses any token carrying it whose row is not live, so
    // this claim can only ever narrow what the token means.
    { imp: row.id },
  );

  return {
    impersonation: toView(row, now),
    token,
    expiresAt: expiresAt.getTime(),
  };
};

/**
 * Resolve a live impersonation by id, or `null`.
 *
 * Called on EVERY request whose token carries `imp`, which is why it is one
 * indexed read and nothing more. Absent, ended and expired all answer the same
 * way: the token stops working.
 */
export const resolveImpersonation = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  id: string,
  now: number = Date.now(),
): Promise<ImpersonationRow | null> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as ImpersonationRow[];
  const row = rows[0];
  if (!row) return null;
  if (row.endedAt !== null) return null;
  if ((ms(row.expiresAt) ?? 0) <= now) return null;
  return row;
};

export const endImpersonation = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  endedBy: string,
): Promise<ImpersonationView> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as ImpersonationRow[];
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Impersonation not found");
  if (row.endedAt !== null) return toView(row);
  const endedAt = new Date();
  await (ctx.db as AnyDb)
    .update(t)
    .set({ endedAt, endedBy })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return toView({ ...row, endedAt, endedBy });
};

export const listImpersonations = async (
  ctx: Ctx,
  tenantId: string,
  opts: { activeOnly?: boolean; limit?: number } = {},
): Promise<ImpersonationView[]> => {
  const t = table(ctx.dialect);
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const where = opts.activeOnly
    ? and(eq(t.tenantId, tenantId), isNull(t.endedAt))
    : eq(t.tenantId, tenantId);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.createdAt))
    .limit(limit)) as ImpersonationRow[];
  const now = Date.now();
  const views = rows.map((r) => toView(r, now));
  return opts.activeOnly ? views.filter((v) => v.active) : views;
};

/** Whether an env-level kill switch is set. An operator who wants the feature
 *  gone entirely should not have to trust that nobody grants themselves the
 *  admin role. */
export const impersonationEnabled = (env: Env): boolean =>
  env.IMPERSONATION_DISABLED !== "1" && env.IMPERSONATION_DISABLED !== "true";
