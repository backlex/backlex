/**
 * Approvals — a record that cannot move until a named human decides.
 *
 * Fourteen of the twenty-six schema templates carry a collection whose status
 * goes `pending → approved | rejected`: leave requests, expense claims, offer
 * approvals, vendor applications, engineering change orders, grant reports.
 * Every one of them was hand-rolled the same way — a status column, a
 * notification, an admin who edits the row — and the part that was always
 * missing is the evidence: who decided, in what capacity, when, and why.
 *
 * The pure decision math (does this set of answers settle it, and how?) lives
 * in `@backlex/core`'s `approvals.ts`. This file is the DB half.
 *
 * Three properties the design is built around, in order of how much they cost
 * to get wrong:
 *
 * 1. **Settling is one-shot, and that is what makes resumption exactly-once.**
 *    There are TWO conditional updates, not one. The approver's decision is
 *    guarded on their own status; the REQUEST's transition out of `pending` is
 *    guarded separately and confirmed by `.returning()`. Only the caller that
 *    changes the request row runs the write-back, sends the outcome mail and
 *    resumes the waiting flow. Without the second guard, an approval landing
 *    in the same instant as the expiry tick would run the continuation twice —
 *    and a continuation is arbitrary operator code: a second payment, a second
 *    provisioning call.
 * 2. **Expiry is WRITTEN, unlike a signature request's.** There, expiry is
 *    derived from `expires_at` so nothing has to run. Here expiring has a
 *    consequence — a flow parked in `continuation` must be resumed down its
 *    rejected branch — so a status nobody ever writes would strand it forever.
 *    The scheduler tick is what writes it, through the same `settleRequest`.
 * 3. **The token is the only grant, so it is never at rest.** Only its SHA-256
 *    is stored. It reaches the approver in one email and appears nowhere else —
 *    notably NOT on the flow op's result, which is persisted in the run log.
 */
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  AppError,
  DEFAULT_EXPIRY_HOURS,
  MAX_APPROVERS,
  MAX_EXPIRY_HOURS,
  MAX_REASON,
  canDecide,
  currentTurn,
  settleOutcome,
  writeBackPatch,
  type ApprovalPolicy,
  type ApprovalStatus,
  type WriteBackSpec,
} from "@backlex/core";
import type { Ctx } from "../context";
import { hashToken } from "./shared-links";
import { updateItem } from "./items-helpers";
import { sendTemplatedEmail } from "./email";
import { escapeHtml, normalizeEmail } from "./signatures";
import { deleteTask, enqueueTask, type ResumePayload } from "./scheduled-tasks";

type AnyDb = any;

const requestsTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.approvalRequests
    : sqlite.schema.approvalRequests) as typeof pg.schema.approvalRequests;

const approversTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.approvalApprovers
    : sqlite.schema.approvalApprovers) as typeof pg.schema.approvalApprovers;

const TOKEN_PREFIX = "apv";
const TOKEN_BYTES = 24;

export interface ApprovalRequestRow {
  id: string;
  tenantId: string | null;
  title: string;
  message: string | null;
  subjectCollection: string | null;
  subjectId: string | null;
  summary: unknown[] | null;
  policy: string;
  quorum: number;
  ordered: boolean;
  status: string;
  continuation: unknown;
  timeoutTaskId: string | null;
  writeBack: Record<string, unknown> | null;
  notifyEmails: string[] | null;
  expiresAt: Date | number | null;
  settledAt: Date | number | null;
  outcomeReason: string | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface ApprovalApproverRow {
  id: string;
  requestId: string;
  email: string;
  name: string | null;
  role: string | null;
  orderIndex: number;
  tokenHash: string;
  status: string;
  sentAt: Date | number | null;
  viewedAt: Date | number | null;
  decidedAt: Date | number | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

const asMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

/**
 * SQLite `timestamp_ms` columns want a `Date` in COMPARISONS, not a number —
 * writing a raw number appears to work and then `lte()` silently matches
 * nothing. Same trap the booking overlap guard fell into.
 */
const stamp = (ms: number): Date => new Date(ms);

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

const formatStamp = (value: Date | number | null): string => {
  const ms = asMs(value);
  return ms == null ? "—" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

export const decisionUrl = (ctx: Ctx, token: string): string =>
  `${(ctx.env.APP_URL ?? "").replace(/\/+$/, "")}/approve/${token}`;

const loadRequest = async (
  ctx: Ctx,
  id: string,
  tenantId: string | null,
): Promise<ApprovalRequestRow | null> => {
  const t = requestsTable(ctx.dialect);
  const where =
    tenantId == null ? and(eq(t.id, id), isNull(t.tenantId)) : and(eq(t.id, id), eq(t.tenantId, tenantId));
  const [row] = (await (ctx.db as AnyDb).select().from(t).where(where)) as ApprovalRequestRow[];
  return row ?? null;
};

const loadApprovers = async (ctx: Ctx, requestId: string): Promise<ApprovalApproverRow[]> => {
  const a = approversTable(ctx.dialect);
  return (await (ctx.db as AnyDb)
    .select()
    .from(a)
    .where(eq(a.requestId, requestId))
    .orderBy(asc(a.orderIndex))) as ApprovalApproverRow[];
};

export const toPublicApprover = (row: ApprovalApproverRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  order: row.orderIndex,
  status: row.status,
  sentAt: row.sentAt,
  viewedAt: row.viewedAt,
  decidedAt: row.decidedAt,
  reason: row.reason,
  ip: row.ip,
  userAgent: row.userAgent,
});

export const toPublicRequest = (row: ApprovalRequestRow, approvers: ApprovalApproverRow[]) => ({
  id: row.id,
  title: row.title,
  message: row.message,
  subject:
    row.subjectCollection && row.subjectId
      ? { collection: row.subjectCollection, id: row.subjectId }
      : null,
  summary: row.summary ?? [],
  policy: row.policy,
  quorum: row.quorum,
  ordered: row.ordered,
  status: row.status,
  expiresAt: row.expiresAt,
  settledAt: row.settledAt,
  outcomeReason: row.outcomeReason,
  // `continuation` is deliberately absent: it is operator code plus the
  // triggering row's data, and this shape is returned to the admin AND
  // summarised onto flow-run logs.
  writeBack: row.writeBack,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  approvers: approvers.map(toPublicApprover),
});

export interface CreateApprovalInput {
  title: string;
  message?: string;
  approvers: Array<{ email: string; name?: string; role?: string }>;
  policy?: ApprovalPolicy;
  quorum?: number;
  ordered?: boolean;
  expiresInHours?: number;
  subject?: { collection: string; id: string } | null;
  summary?: Array<{ label: string; value: string }>;
  writeBack?: WriteBackSpec | null;
  notifyEmails?: string[];
  /** A flow's remaining operations, parked until the decision. */
  continuation?: ResumePayload | null;
  /** Off for a caller that wants the links back and will mail them itself. */
  send?: boolean;
}

export interface CreatedApprovalRequest {
  request: ReturnType<typeof toPublicRequest>;
  links: Array<{ approverId: string; email: string; url: string }>;
  sent: boolean;
}

export const createApprovalRequest = async (
  ctx: Ctx,
  tenantId: string | null,
  input: CreateApprovalInput,
  createdBy: string | null,
): Promise<CreatedApprovalRequest> => {
  const title = input.title?.trim();
  if (!title) throw new AppError("VALIDATION", "An approval request needs a title");

  const people = input.approvers ?? [];
  if (people.length === 0) {
    throw new AppError("VALIDATION", "An approval request needs at least one approver");
  }
  if (people.length > MAX_APPROVERS) {
    throw new AppError("VALIDATION", `An approval request takes at most ${MAX_APPROVERS} approvers`);
  }
  const emails = people.map((p) => normalizeEmail(p.email, "approver"));
  const seen = new Set<string>();
  for (const email of emails) {
    const lower = email.toLowerCase();
    // Two links to one address is one person deciding twice — under `all` it
    // would also mean their single answer counts for two of the votes, and an
    // ordered request would wait for a turn that already passed.
    if (seen.has(lower)) throw new AppError("VALIDATION", `${email} is listed twice`);
    seen.add(lower);
  }

  const policy = (input.policy ?? "all") as ApprovalPolicy;
  let quorum = input.quorum ?? 1;
  if (policy === "quorum") {
    if (!Number.isInteger(quorum) || quorum < 1) {
      throw new AppError("VALIDATION", "A quorum policy needs a whole `quorum` of at least 1");
    }
    if (quorum > people.length) {
      // Silently clamping would create a request that can never be approved,
      // which reads to the operator as "the approvers are ignoring it".
      throw new AppError(
        "VALIDATION",
        `A quorum of ${quorum} cannot be met by ${people.length} approver(s)`,
      );
    }
  } else {
    quorum = policy === "all" ? people.length : 1;
  }

  const hours = input.expiresInHours ?? DEFAULT_EXPIRY_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EXPIRY_HOURS) {
    throw new AppError("VALIDATION", `expiresInHours must be between 1 and ${MAX_EXPIRY_HOURS}`);
  }
  const now = new Date();
  const expiresMs = now.getTime() + hours * 3600_000;

  const id = crypto.randomUUID();
  const t = requestsTable(ctx.dialect);
  await (ctx.db as AnyDb).insert(t).values({
    id,
    tenantId,
    title,
    message: input.message?.trim() || null,
    subjectCollection: input.subject?.collection ?? null,
    subjectId: input.subject?.id ?? null,
    summary: input.summary ?? null,
    policy,
    quorum,
    ordered: input.ordered ?? false,
    status: "pending",
    continuation: input.continuation ?? null,
    writeBack: (input.writeBack as Record<string, unknown> | null) ?? null,
    notifyEmails: input.notifyEmails ?? null,
    expiresAt: stamp(expiresMs),
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  const a = approversTable(ctx.dialect);
  const rows: Record<string, unknown>[] = [];
  const links: Array<{ approverId: string; email: string; url: string }> = [];
  for (let i = 0; i < people.length; i++) {
    const person = people[i]!;
    const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
    const approverId = crypto.randomUUID();
    rows.push({
      id: approverId,
      requestId: id,
      email: emails[i]!,
      name: person.name?.trim() || null,
      role: person.role?.trim() || null,
      orderIndex: i,
      tokenHash: await hashToken(token),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    links.push({ approverId, email: emails[i]!, url: decisionUrl(ctx, token) });
  }
  await (ctx.db as AnyDb).insert(a).values(rows);

  // The timeout is a scheduled task rather than a scan of every pending row:
  // the scheduler already claims due tasks exactly once, and reusing it means
  // expiry works identically on every runtime.
  try {
    const task = await enqueueTask(ctx, {
      flowId: null,
      tenantId,
      runAt: stamp(expiresMs),
      payload: { kind: "approval-timeout", requestId: id },
    });
    await (ctx.db as AnyDb)
      .update(t)
      .set({ timeoutTaskId: task.id, updatedAt: new Date() })
      .where(eq(t.id, id));
  } catch (err) {
    // A request with no timeout still works — it just needs a human to
    // cancel it. Failing the whole creation over the timer would be worse.
    console.error(`[approvals] ${id} timeout enqueue failed`, err);
  }

  const request = (await loadRequest(ctx, id, tenantId))!;
  const approvers = await loadApprovers(ctx, id);

  let sent = false;
  if (input.send !== false) sent = await sendInvitations(ctx, request, approvers, links);
  return { request: toPublicRequest(request, approvers), links, sent };
};

/** Email whoever may decide right now. On an ordered request that is one
 *  person; on an unordered one it is everybody still pending. */
const sendInvitations = async (
  ctx: Ctx,
  request: ApprovalRequestRow,
  approvers: ApprovalApproverRow[],
  links: Array<{ approverId: string; email: string; url: string }>,
): Promise<boolean> => {
  let any = false;
  for (const link of links) {
    const index = approvers.findIndex((x) => x.id === link.approverId);
    const approver = approvers[index];
    if (!approver) continue;
    if (!canDecide(approvers, index, request.ordered)) continue;
    try {
      await sendTemplatedEmail(ctx, {
        to: approver.email,
        templateKey: "approval_request",
        tenantId: request.tenantId,
        vars: {
          title: request.title,
          message: request.message ?? "",
          url: link.url,
          approver: { email: approver.email, name: approver.name ?? "", role: approver.role ?? "" },
          summary: request.summary ?? [],
          expiresAt: formatStamp(request.expiresAt),
        },
        fallback: {
          subject: `Approval needed: ${request.title}`,
          html: `<p>${escapeHtml(approver.name || approver.email)},</p>
<p>${escapeHtml(request.message || `You have been asked to approve "${request.title}".`)}</p>
${summaryHtml(request.summary)}
<p><a href="${escapeHtml(link.url)}">Review and decide</a></p>
<p style="color:#666;font-size:12px">This link is personal to you and expires ${escapeHtml(
            formatStamp(request.expiresAt),
          )}.</p>`,
        },
      });
      any = true;
      const a = approversTable(ctx.dialect);
      await (ctx.db as AnyDb)
        .update(a)
        .set({ sentAt: new Date(), updatedAt: new Date() })
        .where(eq(a.id, approver.id));
    } catch (err) {
      console.error(`[approvals] invite to ${approver.email} failed`, err);
    }
  }
  return any;
};

/** Every value here came from operator-authored templates or row data, so it
 *  is escaped on the way into a mail body a client will render. */
const summaryHtml = (summary: unknown[] | null): string => {
  const rows = Array.isArray(summary) ? summary : [];
  if (rows.length === 0) return "";
  const cells = rows
    .map((r) => {
      const item = r as { label?: unknown; value?: unknown };
      return `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(
        String(item?.label ?? ""),
      )}</td><td style="padding:4px 0">${escapeHtml(String(item?.value ?? ""))}</td></tr>`;
    })
    .join("");
  return `<table style="border-collapse:collapse;margin:12px 0">${cells}</table>`;
};

export interface ResolvedApprover {
  request: ApprovalRequestRow;
  approvers: ApprovalApproverRow[];
  approver: ApprovalApproverRow;
  index: number;
}

/**
 * Look an approver up by their link token.
 *
 * Returns `null` for an unknown token — the caller answers 404 for that AND
 * for a token whose request is gone, so probing cannot distinguish "never
 * existed" from "already dealt with".
 */
export const resolveByToken = async (ctx: Ctx, token: string): Promise<ResolvedApprover | null> => {
  const raw = String(token ?? "").trim();
  if (!raw) return null;
  const a = approversTable(ctx.dialect);
  const [approver] = (await (ctx.db as AnyDb)
    .select()
    .from(a)
    .where(eq(a.tokenHash, await hashToken(raw)))) as ApprovalApproverRow[];
  if (!approver) return null;

  const t = requestsTable(ctx.dialect);
  const [request] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.id, approver.requestId))) as ApprovalRequestRow[];
  if (!request) return null;

  const approvers = await loadApprovers(ctx, request.id);
  const index = approvers.findIndex((x) => x.id === approver.id);
  return { request, approvers, approver, index };
};

/** What the decision page is allowed to show and do. Throws the reason it is
 *  closed, so the page can say something truthful rather than "not found". */
export const assertDecidable = (resolved: ResolvedApprover): void => {
  const { request, approvers, index, approver } = resolved;
  if (request.status !== "pending") {
    throw new AppError("CONFLICT", `This request is already ${request.status}`);
  }
  const expires = asMs(request.expiresAt);
  if (expires != null && expires <= Date.now()) {
    throw new AppError("CONFLICT", "This request has expired");
  }
  if (approver.status === "approved" || approver.status === "rejected") {
    throw new AppError("CONFLICT", `You have already ${approver.status} this request`);
  }
  if (!canDecide(approvers, index, request.ordered)) {
    // Deliberately non-identifying. Naming who is ahead would hand an
    // unauthenticated caller another approver's name or address before
    // anybody has decided anything.
    throw new AppError("CONFLICT", "It is not your turn to decide yet");
  }
};

export const markViewed = async (ctx: Ctx, resolved: ResolvedApprover): Promise<void> => {
  if (resolved.approver.viewedAt) return;
  const a = approversTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(a)
    .set({ status: resolved.approver.status === "pending" ? "viewed" : resolved.approver.status, viewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(a.id, resolved.approver.id), isNull(a.viewedAt)));
};

export interface DecisionResult {
  request: ReturnType<typeof toPublicRequest>;
  /** What the whole request became — `pending` when others still owe an answer. */
  outcome: ApprovalStatus;
}

/**
 * Record one person's answer.
 *
 * The approver's own transition is a conditional UPDATE confirmed by
 * `.returning()`: a double-tapped button or a retried POST both pass
 * `assertDecidable`, and only the one that changes the row counts. The loser
 * would otherwise contribute a second vote toward a quorum.
 */
export const recordDecision = async (
  ctx: Ctx,
  resolved: ResolvedApprover,
  decision: "approve" | "reject",
  input: { reason?: string },
  meta: { ip: string | null; userAgent: string | null },
): Promise<DecisionResult> => {
  assertDecidable(resolved);

  const reason = String(input.reason ?? "").trim();
  if (reason.length > MAX_REASON) {
    throw new AppError("VALIDATION", "That reason is too long");
  }
  // A refusal with no reason is the thing operators complain about: the row
  // goes back to its author saying only "no".
  if (decision === "reject" && !reason) {
    throw new AppError("VALIDATION", "Rejecting needs a reason");
  }

  const a = approversTable(ctx.dialect);
  const now = new Date();
  const changed = (await (ctx.db as AnyDb)
    .update(a)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      reason: reason || null,
      decidedAt: now,
      ip: meta.ip,
      userAgent: meta.userAgent,
      updatedAt: now,
    })
    .where(
      and(
        eq(a.id, resolved.approver.id),
        // Anything but a still-open row loses the race.
        isNull(a.decidedAt),
      ),
    )
    .returning()) as ApprovalApproverRow[];
  if (changed.length === 0) {
    throw new AppError("CONFLICT", "That decision was already recorded");
  }

  const approvers = await loadApprovers(ctx, resolved.request.id);
  const outcome = settleOutcome({
    policy: resolved.request.policy as ApprovalPolicy,
    quorum: resolved.request.quorum,
    approvers,
  });

  if (outcome) {
    const settled = await settleRequest(ctx, resolved.request, outcome, reason || null);
    if (settled) return { request: settled, outcome };
  } else if (resolved.request.ordered) {
    // The next person in line has been waiting on a link that would not have
    // opened; now it will, so tell them.
    await notifyNextInLine(ctx, resolved.request, approvers);
  }

  const request = (await loadRequest(ctx, resolved.request.id, resolved.request.tenantId))!;
  const fresh = await loadApprovers(ctx, request.id);
  return {
    request: toPublicRequest(request, fresh),
    outcome: request.status as ApprovalStatus,
  };
};

/**
 * An ordered request cannot mail everyone up front — a link that opens before
 * its turn makes "ordered" advisory. So the next invitation is sent when the
 * turn actually moves. The token is not recoverable from the hash, so a fresh
 * one is minted and the old hash replaced: the previous link was never usable
 * and nobody has seen it.
 */
const notifyNextInLine = async (
  ctx: Ctx,
  request: ApprovalRequestRow,
  approvers: ApprovalApproverRow[],
): Promise<void> => {
  const turn = currentTurn(approvers);
  const next = turn >= 0 ? approvers[turn] : null;
  if (!next || next.sentAt) return;
  const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const a = approversTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(a)
    .set({ tokenHash: await hashToken(token), updatedAt: new Date() })
    .where(eq(a.id, next.id));
  await sendInvitations(ctx, request, approvers, [
    { approverId: next.id, email: next.email, url: decisionUrl(ctx, token) },
  ]);
};

/**
 * Move the request out of `pending`, exactly once.
 *
 * Returns the settled request when THIS caller won the transition, and `null`
 * when somebody else already did. Everything with a side effect — the
 * write-back, the outcome mail, resuming the parked flow — happens only on the
 * winning path, because each of them is something an operator would notice
 * twice: a second patch over a value a human has since corrected, a second
 * mail, a second run of arbitrary flow operations.
 */
export const settleRequest = async (
  ctx: Ctx,
  request: ApprovalRequestRow,
  outcome: Exclude<ApprovalStatus, "pending">,
  reason: string | null,
): Promise<ReturnType<typeof toPublicRequest> | null> => {
  const t = requestsTable(ctx.dialect);
  const now = new Date();
  const won = (await (ctx.db as AnyDb)
    .update(t)
    .set({ status: outcome, settledAt: now, outcomeReason: reason, updatedAt: now })
    .where(and(eq(t.id, request.id), eq(t.status, "pending")))
    .returning()) as ApprovalRequestRow[];
  const settled = won[0];
  if (!settled) return null;

  const approvers = await loadApprovers(ctx, settled.id);

  // Drop the timer first: an expiry tick that fires after a decision would
  // find the request already settled and do nothing, but leaving the row
  // means the scheduler keeps waking for work that no longer exists.
  if (settled.timeoutTaskId) {
    try {
      await deleteTask(ctx, settled.timeoutTaskId);
    } catch (err) {
      console.error(`[approvals] ${settled.id} timeout cleanup failed`, err);
    }
  }

  await applyWriteBack(ctx, settled, outcome);
  await sendOutcomeMail(ctx, settled, approvers, outcome);
  await resumeParkedFlow(ctx, settled, approvers, outcome, reason);

  const fresh = (await loadRequest(ctx, settled.id, settled.tenantId)) ?? settled;
  return toPublicRequest(fresh, approvers);
};

const applyWriteBack = async (
  ctx: Ctx,
  request: ApprovalRequestRow,
  outcome: ApprovalStatus,
): Promise<void> => {
  const spec = (request.writeBack ?? null) as WriteBackSpec | null;
  if (!spec) return;
  // A write-back that names no collection/id falls back to the subject the
  // request was raised against — the overwhelmingly common case is "patch the
  // row this is about", and repeating it in the op is noise.
  const resolvedSpec: WriteBackSpec = {
    ...spec,
    collection: spec.collection ?? request.subjectCollection ?? undefined,
    id: spec.id ?? request.subjectId ?? undefined,
  };
  const patch = writeBackPatch(resolvedSpec, outcome);
  // A collection lookup is workspace-scoped, so a request with no workspace
  // has nowhere to write back TO — same guard the signature write-back uses.
  if (!patch || !request.tenantId) return;
  try {
    await updateItem(ctx, {
      slug: patch.collection,
      tenantId: request.tenantId,
      id: patch.id,
      data: patch.data,
    });
  } catch (err) {
    // The decision is already recorded and is the source of truth; a row that
    // has since been deleted must not un-settle it.
    console.error(`[approvals] ${request.id} write-back failed`, err);
  }
};

const sendOutcomeMail = async (
  ctx: Ctx,
  request: ApprovalRequestRow,
  approvers: ApprovalApproverRow[],
  outcome: ApprovalStatus,
): Promise<void> => {
  const recipients = [...new Set(request.notifyEmails ?? [])];
  if (recipients.length === 0) return;
  for (const to of recipients) {
    try {
      await sendTemplatedEmail(ctx, {
        to,
        templateKey: `approval_${outcome}`,
        tenantId: request.tenantId,
        vars: {
          title: request.title,
          outcome,
          reason: request.outcomeReason ?? "",
          approvers: approvers.map((x) => ({
            email: x.email,
            name: x.name ?? "",
            role: x.role ?? "",
            status: x.status,
            reason: x.reason ?? "",
          })),
        },
        fallback: {
          subject: `${outcome === "approved" ? "Approved" : "Not approved"}: ${request.title}`,
          html: `<p>"${escapeHtml(request.title)}" was ${escapeHtml(outcome)}.</p>${
            request.outcomeReason
              ? `<p>Reason: ${escapeHtml(request.outcomeReason)}</p>`
              : ""
          }`,
        },
      });
    } catch (err) {
      console.error(`[approvals] outcome mail to ${to} failed`, err);
    }
  }
};

/**
 * Resume the flow that parked itself here.
 *
 * The import is dynamic because `flows.ts` imports THIS module for the
 * `approval.request` op — a static import back would be a cycle. By the time a
 * decision arrives both modules are long initialised, so the await costs
 * nothing beyond the first call.
 */
const resumeParkedFlow = async (
  ctx: Ctx,
  request: ApprovalRequestRow,
  approvers: ApprovalApproverRow[],
  outcome: ApprovalStatus,
  reason: string | null,
): Promise<void> => {
  const parked = request.continuation as ResumePayload | null;
  if (!parked) return;
  // Who tipped it: the most recent decision matching the outcome. On an
  // expiry nobody did, and `null` is the honest answer.
  const decider = [...approvers]
    .filter((x) => x.decidedAt != null && x.status === outcome)
    .sort((a, b) => (asMs(b.decidedAt) ?? 0) - (asMs(a.decidedAt) ?? 0))[0];
  const last = {
    requestId: request.id,
    outcome,
    decidedBy: decider ? { email: decider.email, name: decider.name, role: decider.role } : null,
    reason,
    approvals: approvers.filter((x) => x.status === "approved").length,
    rejections: approvers.filter((x) => x.status === "rejected").length,
  };
  try {
    const { resumeContinuation } = await import("./flows");
    // An approval resumes the REST of the flow; a rejection or an expiry runs
    // the `onRejected` branch parked alongside it. Both are operation lists,
    // so one call site serves them. A `cancelled` request runs neither: the
    // operator who cancelled it did not ask for either branch.
    if (outcome === "cancelled") return;
    const ops = outcome === "approved" ? parked.remainingOps : (parked.rejectedOps ?? []);
    if (!ops || ops.length === 0) return;
    const result = await resumeContinuation(ctx, { ...parked, remainingOps: ops, last });
    if (!result.ok) {
      console.error(`[approvals] ${request.id} continuation halted: ${result.error}`);
    }
  } catch (err) {
    console.error(`[approvals] ${request.id} continuation failed`, err);
  }
};

/**
 * Expire one request, from the scheduler tick.
 *
 * Goes through `settleRequest` rather than writing the status directly, so the
 * expiry path and the decision path share the one guard that makes resumption
 * exactly-once.
 */
export const expireRequest = async (ctx: Ctx, requestId: string): Promise<boolean> => {
  const t = requestsTable(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb).select().from(t).where(eq(t.id, requestId))) as ApprovalRequestRow[];
  if (!row || row.status !== "pending") return false;
  const settled = await settleRequest(ctx, row, "expired", null);
  return settled != null;
};

/**
 * Sweep for anything the per-request timer missed — a task row that failed to
 * enqueue, or one lost to a database restore. Cheap: the status index makes it
 * a bounded scan of this workspace's open requests.
 */
export const expireDueRequests = async (ctx: Ctx, limit = 50): Promise<number> => {
  const t = requestsTable(ctx.dialect);
  const due = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.status, "pending"), lte(t.expiresAt, stamp(Date.now()))))
    .limit(limit)) as ApprovalRequestRow[];
  let n = 0;
  for (const row of due) {
    const settled = await settleRequest(ctx, row, "expired", null);
    if (settled) n++;
  }
  return n;
};

export const cancelRequest = async (
  ctx: Ctx,
  id: string,
  tenantId: string | null,
  reason: string | null,
): Promise<ReturnType<typeof toPublicRequest>> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", "Approval request not found");
  const settled = await settleRequest(ctx, row, "cancelled", reason?.trim() || null);
  if (!settled) throw new AppError("CONFLICT", `This request is already ${row.status}`);
  return settled;
};

export const getApprovalRequest = async (
  ctx: Ctx,
  id: string,
  tenantId: string | null,
): Promise<ReturnType<typeof toPublicRequest>> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", "Approval request not found");
  return toPublicRequest(row, await loadApprovers(ctx, row.id));
};

export const listApprovalRequests = async (
  ctx: Ctx,
  tenantId: string | null,
  opts: { status?: string; limit?: number } = {},
): Promise<Array<ReturnType<typeof toPublicRequest>>> => {
  const t = requestsTable(ctx.dialect);
  const scope = tenantId == null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);
  const where = opts.status ? and(scope, eq(t.status, opts.status)) : scope;
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(where)
    .orderBy(asc(t.status), asc(t.expiresAt))
    .limit(Math.min(Math.max(1, opts.limit ?? 50), 200))) as ApprovalRequestRow[];
  const out: Array<ReturnType<typeof toPublicRequest>> = [];
  for (const row of rows) out.push(toPublicRequest(row, await loadApprovers(ctx, row.id)));
  return out;
};

/** What the public decision page is handed. Carries no token and no
 *  continuation — only what the approver needs to decide. */
export const toDecisionView = (resolved: ResolvedApprover) => {
  const { request, approvers, approver, index } = resolved;
  let blocked: string | null = null;
  try {
    assertDecidable(resolved);
  } catch (e) {
    blocked = e instanceof AppError ? e.message : "This request is closed";
  }
  return {
    title: request.title,
    message: request.message,
    summary: request.summary ?? [],
    status: request.status,
    policy: request.policy,
    ordered: request.ordered,
    expiresAt: request.expiresAt,
    you: {
      email: approver.email,
      name: approver.name,
      role: approver.role,
      status: approver.status,
      position: index + 1,
      of: approvers.length,
    },
    // Names and outcomes, never addresses. A counterparty's email is not this
    // approver's to read just because they were asked the same question — the
    // signing page makes the same call, and this plane is unauthenticated, so
    // whoever holds a forwarded link would get the whole roster.
    decided: approvers
      .filter((x) => x.status === "approved" || x.status === "rejected")
      .map((x) => ({ name: x.name, status: x.status, decidedAt: x.decidedAt })),
    blocked,
  };
};
