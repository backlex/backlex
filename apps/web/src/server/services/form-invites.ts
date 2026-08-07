/**
 * One turn per recipient — the shape that makes "one answer per person" mean a
 * person.
 *
 * A form's own token is a door: whoever holds the link answers, as often as
 * they like. The cookie guard beside it (`settings.onePerBrowser`) is a
 * courtesy — another browser answers again — and the honest UI says so. An
 * invite is the answer when the count has to be right: minted per recipient,
 * spent by the submit that uses it.
 *
 * AN INVITE IS A TURN, NOT A LINK. It can have several: the plaintext is never
 * stored, so a reminder cannot re-send the link that was mailed and has to mint
 * another, and rotating the invite's only token would kill the link in the
 * first mail in front of exactly the person the reminder is trying to reach.
 * The first link stays on the invite; every later one lands in
 * `form_invite_tokens`. All of them open the turn, and spending any one spends
 * it.
 *
 * Token discipline mirrors `shared-links.ts` / `approval_approvers`: the
 * plaintext (`inv_<hex>`) is returned exactly once, at mint time, and only its
 * SHA-256 is stored. A lost link is re-minted, never recovered.
 *
 * Every read degrades to null/[] when the table hasn't been migrated yet — the
 * same posture the rest of the forms feature takes, so a workspace mid-upgrade
 * shows a form without invites rather than a 500.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import { hashToken } from "./shared-links";

const invitesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.formInvites : sqlite.schema.formInvites;

const tokensTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.formInviteTokens : sqlite.schema.formInviteTokens;

const TOKEN_PREFIX = "inv";
const TOKEN_BYTES = 24;

/** Most invites one call may mint. A survey sent to a company is a few
 *  thousand; past that the caller wants a loop and its own pacing, and a
 *  single request that mints 100k rows is a timeout wearing a feature. */
export const MAX_INVITES_PER_CALL = 500;

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface FormInviteRow {
  id: string;
  formId: string;
  tenantId: string | null;
  email: string | null;
  name: string | null;
  sentAt: Date | number | null;
  usedAt: Date | number | null;
  /** When a reminder last went out, and how many have. */
  remindedAt: Date | number | null;
  reminderCount: number;
  createdAt: Date | number | null;
}

/** One minted invite. `token` and `url` appear ONCE — in this payload. */
export interface MintedInvite extends FormInviteRow {
  token: string;
  url: string;
}

export interface InviteRecipient {
  email?: string | null;
  name?: string | null;
}

const tenantScope = (t: any, tenantId: string | null) =>
  tenantId ? or(eq(t.tenantId, tenantId), isNull(t.tenantId)) : isNull(t.tenantId);

const toRow = (r: any): FormInviteRow => ({
  id: r.id,
  formId: r.formId,
  tenantId: r.tenantId ?? null,
  email: r.email ?? null,
  name: r.name ?? null,
  sentAt: r.sentAt ?? null,
  usedAt: r.usedAt ?? null,
  remindedAt: r.remindedAt ?? null,
  reminderCount: Number(r.reminderCount ?? 0),
  createdAt: r.createdAt ?? null,
});

const newToken = (): string => `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;

/** Mint a LATER link into an existing invite, as the row that recognises it.
 *  The plaintext is returned to exactly one caller and stored nowhere. */
const mintLaterToken = async (
  invite: { id: string; formId: string; tenantId: string | null },
  now: Date | number,
): Promise<{ token: string; row: Record<string, unknown> }> => {
  const token = newToken();
  return {
    token,
    row: {
      id: crypto.randomUUID(),
      inviteId: invite.id,
      formId: invite.formId,
      tenantId: invite.tenantId,
      tokenHash: await hashToken(token),
      createdAt: now,
    },
  };
};

/** The public link an invite is followed through. The form's own token is
 *  still required — an invite grants a turn, not access. */
export const inviteUrl = (formToken: string, inviteToken: string): string =>
  `/f/${formToken}?i=${inviteToken}`;

export const listFormInvites = async (
  ctx: Ctx,
  tenantId: string | null,
  formId: string,
): Promise<FormInviteRow[]> => {
  const t = invitesTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.formId, formId), tenantScope(t, tenantId)))
      .orderBy(asc(t.createdAt))) as any[];
    return rows.map(toRow);
  } catch {
    return [];
  }
};

/**
 * Mint one invite per recipient.
 *
 * Recipients without an email are allowed on purpose: a workshop hands out
 * links on paper, and an invite whose whole job is to be spendable once does
 * not need an address to do it.
 */
export const createFormInvites = async (
  ctx: Ctx,
  tenantId: string | null,
  form: { id: string },
  formToken: string | null,
  recipients: InviteRecipient[],
): Promise<MintedInvite[]> => {
  if (recipients.length === 0) {
    throw new AppError("VALIDATION", "No recipients to invite");
  }
  if (recipients.length > MAX_INVITES_PER_CALL) {
    throw new AppError(
      "VALIDATION",
      `At most ${MAX_INVITES_PER_CALL} invites per call (got ${recipients.length})`,
    );
  }
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const minted: MintedInvite[] = [];
  const values: Record<string, unknown>[] = [];
  for (const r of recipients) {
    const token = newToken();
    const row = {
      id: crypto.randomUUID(),
      formId: form.id,
      tenantId,
      email: r.email?.trim() || null,
      name: r.name?.trim() || null,
      tokenHash: await hashToken(token),
      sentAt: null,
      usedAt: null,
      remindedAt: null,
      reminderCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    values.push(row);
    minted.push({
      ...toRow(row),
      token,
      // Without the form's own plaintext token — which is only ever held for
      // the moment after a mint or rotate — the caller gets the invite token
      // and builds the link itself. Saying so beats inventing a URL that 404s.
      url: formToken ? inviteUrl(formToken, token) : "",
    });
  }
  await (ctx.db as any).insert(invitesTable(ctx.dialect)).values(values);
  return minted;
};

/**
 * Mint a second link for the people who haven't answered, and say which.
 *
 * The invite is not re-issued and its earlier links do not stop working — every
 * token it has ever had opens the same turn, and spending any one spends it.
 * That is the whole reason later tokens get a table of their own: the person
 * being reminded is precisely the person whose first link must keep working, in
 * case the reminder is the mail they lose.
 *
 * Nobody who has answered is reminded, and nobody is reminded twice inside
 * `minIntervalHours` unless the caller insists — a nudge that arrives every
 * time an operator opens the panel is a nudge nobody reads.
 */
export const remindFormInvites = async (
  ctx: Ctx,
  tenantId: string | null,
  form: { id: string },
  formToken: string | null,
  opts: {
    /** Narrow to specific invites; absent ⇒ everyone still outstanding. */
    inviteIds?: string[];
    /** Hours to leave between two reminders to one person. Default 24. */
    minIntervalHours?: number;
    /** Send anyway, however recently the last one went. */
    force?: boolean;
    now?: number;
  } = {},
): Promise<{ minted: MintedInvite[]; skipped: number }> => {
  const all = await listFormInvites(ctx, tenantId, form.id);
  const wanted = opts.inviteIds?.length
    ? all.filter((i) => opts.inviteIds!.includes(i.id))
    : all;
  const outstanding = wanted.filter((i) => i.usedAt === null);
  const nowMs = opts.now ?? Date.now();
  const gapMs = Math.max(0, opts.minIntervalHours ?? 24) * 60 * 60 * 1000;
  const due = opts.force
    ? outstanding
    : outstanding.filter((i) => {
        const last = i.remindedAt ?? i.sentAt;
        if (last === null) return true;
        const ms = last instanceof Date ? last.getTime() : Number(last);
        return !Number.isFinite(ms) || nowMs - ms >= gapMs;
      });
  const skipped = wanted.length - due.length;
  if (due.length === 0) return { minted: [], skipped };
  if (due.length > MAX_INVITES_PER_CALL) {
    throw new AppError(
      "VALIDATION",
      `At most ${MAX_INVITES_PER_CALL} reminders per call (${due.length} are due) — narrow with inviteIds`,
    );
  }

  const now = ctx.dialect === "pg" ? new Date() : nowMs;
  const minted: MintedInvite[] = [];
  const tokenValues: Record<string, unknown>[] = [];
  for (const invite of due) {
    const { token, row } = await mintLaterToken(invite, now);
    tokenValues.push(row);
    minted.push({
      ...invite,
      remindedAt: now,
      reminderCount: invite.reminderCount + 1,
      token,
      url: formToken ? inviteUrl(formToken, token) : "",
    });
  }
  await (ctx.db as any).insert(tokensTable(ctx.dialect)).values(tokenValues);

  const t = invitesTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      remindedAt: now,
      reminderCount: sql`${t.reminderCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(t.formId, form.id),
        inArray(
          t.id,
          due.map((i) => i.id),
        ),
      ),
    );
  return { minted, skipped };
};

export const deleteFormInvite = async (
  ctx: Ctx,
  tenantId: string | null,
  formId: string,
  inviteId: string,
): Promise<void> => {
  const t = invitesTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, inviteId), eq(t.formId, formId), tenantScope(t, tenantId)))
    .limit(1)) as any[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Invite not found");
  await (ctx.db as any).delete(t).where(eq(t.id, inviteId));
  // Every link that opened the turn dies with it — revoking one and leaving a
  // reminder's link behind would be a revocation that revoked nothing.
  const tk = tokensTable(ctx.dialect);
  await (ctx.db as any).delete(tk).where(eq(tk.inviteId, inviteId));
};

/** Drop a form's invites and every link that opened them. Called when the form
 *  itself goes: an invite to a form that no longer exists is not an invite. */
export const deleteFormInvites = async (ctx: Ctx, formId: string): Promise<void> => {
  try {
    const tk = tokensTable(ctx.dialect);
    await (ctx.db as any).delete(tk).where(eq(tk.formId, formId));
    const t = invitesTable(ctx.dialect);
    await (ctx.db as any).delete(t).where(eq(t.formId, formId));
  } catch {
    // Best-effort, like the draft sweep beside it: a workspace that has not run
    // the migration has nothing to delete.
  }
};

/** Mark an invite as emailed. Best-effort: the link works whether or not the
 *  mail did, and a lost timestamp is not worth failing a send over. */
export const markInviteSent = async (ctx: Ctx, inviteId: string): Promise<void> => {
  const t = invitesTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  try {
    await (ctx.db as any).update(t).set({ sentAt: now }).where(eq(t.id, inviteId));
  } catch {
    // Best-effort.
  }
};

/** Why an invite token is not usable. */
export type InviteProblem = "missing" | "unknown" | "used";

export interface InviteCheck {
  ok: boolean;
  problem: InviteProblem | null;
  invite: FormInviteRow | null;
}

/**
 * Resolve an invite token against ONE form.
 *
 * Scoped to the form deliberately: an invite to the staff survey must not open
 * the customer one, and matching on the token alone would make every invite in
 * the workspace a key to every form in it.
 *
 * ANY link the invite has ever had resolves to it — the one from the first mail
 * and the one from a reminder are two ways into the same turn, and either has
 * to work. The first lives on the invite and the rest beside it, so this is two
 * indexed lookups in the worst case and one in the common one.
 */
export const checkFormInvite = async (
  ctx: Ctx,
  formId: string,
  token: string | null | undefined,
): Promise<InviteCheck> => {
  if (!token || !token.startsWith(`${TOKEN_PREFIX}_`)) {
    return { ok: false, problem: "missing", invite: null };
  }
  const t = invitesTable(ctx.dialect);
  const tk = tokensTable(ctx.dialect);
  const tokenHash = await hashToken(token);
  let row: any;
  try {
    const direct = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.tokenHash, tokenHash), eq(t.formId, formId)))
      .limit(1)) as any[];
    row = direct[0];
    if (!row) {
      // A later link — one a reminder minted. Scoped to the form for the same
      // reason the first lookup is.
      const joined = (await (ctx.db as any)
        .select()
        .from(tk)
        .innerJoin(t, eq(t.id, tk.inviteId))
        .where(and(eq(tk.tokenHash, tokenHash), eq(tk.formId, formId)))
        .limit(1)) as any[];
      // A join hands back `{ form_invites: {...}, form_invite_tokens: {...} }`.
      row = joined[0]?.form_invites ?? joined[0]?.formInvites;
    }
  } catch {
    // Fail closed, exactly as before: a workspace that has not run the
    // migration turns everyone away rather than letting everyone in.
    return { ok: false, problem: "unknown", invite: null };
  }
  if (!row) return { ok: false, problem: "unknown", invite: null };
  if (row.usedAt) return { ok: false, problem: "used", invite: toRow(row) };
  return { ok: true, problem: null, invite: toRow(row) };
};

/**
 * Spend an invite, and say whether this caller is the one who spent it.
 *
 * The condition is in the UPDATE rather than in a read before it: two tabs
 * submitting the same link at the same instant both pass a check-then-write,
 * and the second answer is the one nobody wanted. Whoever the database says
 * changed the row is the one whose submission counts.
 */
export const consumeFormInvite = async (
  ctx: Ctx,
  inviteId: string,
): Promise<boolean> => {
  const t = invitesTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const res = await (ctx.db as any)
    .update(t)
    .set({ usedAt: now, updatedAt: now })
    .where(and(eq(t.id, inviteId), isNull(t.usedAt)));
  // The two drivers report the affected count differently, and neither
  // promises the field: treat "no number at all" as success, since the WHERE
  // already did the deciding and refusing a good answer is worse than the
  // vanishingly rare double.
  const changed =
    (res?.rowsAffected as number | undefined) ??
    (res?.rowCount as number | undefined) ??
    (res?.meta?.changes as number | undefined);
  return changed === undefined || changed > 0;
};

/**
 * Give a spent invite back.
 *
 * The invite is spent BEFORE the row is written, because that is the only
 * ordering in which a double-click cannot produce two answers. The cost of
 * that ordering is a submission that then fails validation — a required field
 * left blank — taking the person's one link with it. So the write path hands
 * it back when it throws: a missed field is a mistake to correct, not a door
 * that locks behind you.
 *
 * Best-effort by design. If this itself fails the operator can re-invite; what
 * must never happen is this throwing over the top of the real error.
 */
export const releaseFormInvite = async (ctx: Ctx, inviteId: string): Promise<void> => {
  const t = invitesTable(ctx.dialect);
  try {
    await (ctx.db as any).update(t).set({ usedAt: null }).where(eq(t.id, inviteId));
  } catch {
    // Best-effort — the caller is already throwing something more useful.
  }
};

/** Counts for the admin panel — how many invites are outstanding. */
export const inviteSummary = (
  rows: FormInviteRow[],
): { total: number; used: number; sent: number; reminded: number } => ({
  total: rows.length,
  used: rows.filter((r) => r.usedAt !== null).length,
  sent: rows.filter((r) => r.sentAt !== null).length,
  reminded: rows.filter((r) => r.remindedAt !== null).length,
});

