import { and, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { compileCondition, matchesCondition } from "@backlex/db";
import {
  AI_OP_DEFAULT_MAX_TOKENS,
  AI_OP_DEFAULT_TIMEOUT_MS,
  AI_OP_MAX_TIMEOUT_MS,
  AI_OP_MAX_TOKENS,
  E164_PATTERN,
  FOREACH_MAX_ROWS,
  INLINE_DELAY_MS,
  buildIcs,
  foldLabel,
  icsAttachmentContent,
  icsContentType,
} from "@backlex/core";
import type { AuthSubject, Condition, EmailAttachment, Operation } from "@backlex/core";
import type { Ctx } from "../context";
import { loadCollection, type CollectionRow } from "./items/collection-loader";
import { deserializeRow } from "./items/serialize";
import { deletedFilter, queryAll, whereOf } from "./items/sql-helpers";
import { runFunction } from "./sandbox";
import { sendTemplatedEmail } from "./email";
import { renderDocument } from "./documents";
import { createSignatureRequest } from "./signatures";
import { createApprovalRequest } from "./approvals";
import { deliverReport } from "./reports";
import { sendPushToUsers, sendTemplatedPush } from "./push";
import { sendSmsToNumbers, sendSmsToUsers } from "./sms";
import { connectedIntegrationIdByKind, deliverIntegrationByKind } from "./integrations";
import { runTask } from "./integration-tasks";
import { createPaymentCheckout, refundPayment } from "./payments";
import { createItem, updateItem } from "./items-helpers";
import { enqueueTask, type ResumePayload } from "./scheduled-tasks";
import { recordActivity } from "./activity";
import { fetchOutbound } from "./storage/hosts";
import { resolveAiRuntime } from "./ai-config";
import { aiMeterForTenant, assertAiQuota } from "./usage";
import { aiAvailable, callClaude } from "../mcp/ai-client";
import type { ClaudeRequest, ClaudeResponse } from "../mcp/ai-client";

/** Inline-sleep cap. Anything longer is enqueued so the worker isn't
 *  blocked for minutes/hours at a time. Shared with the save-time `foreach`
 *  check, which has to refuse exactly the delays that suspend. */
const MAX_INLINE_DELAY_MS = INLINE_DELAY_MS;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * `ORDER BY` for a `foreach`, or empty when neither the op nor the collection
 * names one.
 *
 * Only real columns are accepted. The sort string reaches here from a saved
 * flow, and an unvalidated name would be interpolated straight into SQL as an
 * identifier — so an unknown one is dropped rather than passed through, and an
 * op that names nothing usable simply runs unordered.
 */
const foreachOrderBy = (collection: CollectionRow, sort: string | undefined) => {
  const raw = sort ?? collection.defaultSort ?? "";
  const parts: ReturnType<typeof sql>[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const desc = trimmed.startsWith("-");
    const name = desc ? trimmed.slice(1) : trimmed;
    const known =
      name === collection.pkColumn ||
      collection.fields.some((f) => f.name === name) ||
      (name === "created_at" && collection.hasCreatedAt) ||
      (name === "updated_at" && collection.hasUpdatedAt);
    if (!known) continue;
    parts.push(
      desc
        ? sql`${sql.identifier(name)} DESC`
        : sql`${sql.identifier(name)} ASC`,
    );
  }
  if (parts.length === 0) return sql``;
  return sql` ORDER BY ${sql.join(parts, sql`, `)}`;
};

export type { Operation };

/** Outcome of a flow execution. `ok: false` means the run halted on an
 *  unhandled op error; `error` carries the first failure message. A run
 *  that checkpointed on a long `delay` still counts as `ok` — the rest is
 *  queued, not failed. */
export interface FlowRunResult {
  ok: boolean;
  error: string | null;
  /**
   * What the run's `log` operations rendered, in order.
   *
   * `log` is the first operation `docs/flows.md` teaches, and it is what a
   * person reaches for to answer "did my interpolation resolve?" — it used to
   * `console.log` and nothing else, so on a managed tenant (whose operator has
   * no access to the account's Worker logs) the one operation designed for
   * looking produced nothing to find. Recorded on the `flow.run` activity row,
   * which is where runs were already observable.
   */
  log?: string[];
}

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

interface FlowRow {
  id: string;
  tenantId: string | null;
  name: string;
  trigger: string;
  operations: Operation[];
  active: boolean | number;
}

const matchesTrigger = (
  trigger: string,
  channel: string,
  event: string,
): boolean => {
  const target = `${channel}:${event}`;
  if (trigger === target || trigger === channel) return true;
  const parts = trigger.split(":");
  const targetParts = target.split(":");
  if (parts.length > targetParts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "*") continue;
    if (p !== targetParts[i]) return false;
  }
  return true;
};

interface RunCtx {
  data: Record<string, unknown>;
  authSubject: AuthSubject;
  ctx: Ctx;
  /** Result of the most recently completed operation. Populated after each
   *  op so subsequent ops can read `{{ $last.* }}`. */
  last: unknown;
  /** The row this run is ABOUT, derived from an item trigger's channel.
   *  `approval.request` defaults its subject to this so the common case —
   *  "approve the row that fired this" — needs no restating. Absent on cron,
   *  manual and non-item channels. */
  subject?: { collection: string; id: string } | null;
  /** The row the enclosing `foreach` is currently on, readable as
   *  `{{ $item.* }}`.
   *
   *  Deliberately NOT `data`: the loop runs inside a flow that already has a
   *  trigger payload, and rebinding `data` per iteration would quietly change
   *  what every `{{ data.x }}` in the body meant. A date-relative trigger is
   *  the opposite case — there the row IS the payload, so it arrives as `data`
   *  and an author moving a flow from `event:` to `schedule:` rewrites
   *  nothing. */
  item?: Record<string, unknown> | null;
  /**
   * Rendered `log` lines, collected for the run record. Bounded on both axes:
   * a `log` inside a `foreach` over ten thousand rows would otherwise write ten
   * thousand lines into an activity row.
   */
  log?: string[];
}

/** Caps for {@link RunCtx.log} — enough to debug a flow, not enough to be a
 *  write amplifier. The overflow is reported rather than dropped silently. */
const MAX_LOG_LINES = 50;
const MAX_LOG_LINE = 500;

/**
 * Resolve a string that is EXACTLY one placeholder to the value itself rather
 * than to its string form.
 *
 * `interpolate` exists to build strings, so `"{{ data.parties }}"` over an
 * array yields `"[object Object],[object Object]"`. Where an op takes a
 * structure — a signer list a row carries — that is not a formatting quirk but
 * a silently wrong value, so those fields resolve through here first and fall
 * back to ordinary interpolation for anything with text around the braces.
 */
const resolveWhole = (value: unknown, ctx: RunCtx): unknown => {
  if (typeof value !== "string") return interpolate(value, ctx);
  const only = /^\{\{\s*([\w$.]+)\s*\}\}$/.exec(value);
  if (!only?.[1]) return interpolate(value, ctx);
  const root: Record<string, unknown> = {
    data: ctx.data,
    $user: { id: ctx.authSubject.userId, email: ctx.authSubject.email, roles: ctx.authSubject.roles },
    $last: ctx.last,
    $item: ctx.item ?? null,
  };
  let cur: unknown = root;
  for (const part of only[1].split(".")) {
    if (cur && typeof cur === "object" && part in (cur as object)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
};

/**
 * Which relations does this flow's own text actually dereference?
 *
 * `{{ data.customer.name }}` counts. A bare `{{ data.customer }}` deliberately
 * does NOT: it already renders the foreign key, flows in the wild rely on that,
 * and expanding a relation nobody reads through would be a lookup per run for
 * nothing. Requiring the trailing path segment is what makes this change safe
 * to make at all.
 */
const dereferencedRelations = (operations: unknown): Set<string> => {
  const out = new Set<string>();
  const text = JSON.stringify(operations ?? null) ?? "";
  for (const m of text.matchAll(/\{\{\s*data\.([A-Za-z_]\w*)\.[\w$.]+\s*\}\}/g)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
};

/**
 * The expanded row, whose `String(...)` is still the foreign key.
 *
 * A flow that writes both `{{ data.customer }}` and `{{ data.customer.name }}`
 * keeps getting the id from the first — `interpolate` ends in `String(cur)`, so
 * a non-enumerable `toString` preserves the old meaning without touching the
 * row's own shape (JSON.stringify and `in` checks still see just the columns).
 */
const relationValue = (row: Record<string, unknown>, id: string): Record<string, unknown> => {
  Object.defineProperty(row, "toString", { value: () => id, enumerable: false });
  return row;
};

/**
 * Resolve the relation columns a flow reads through, so `{{ data.customer.name }}`
 * has something to find.
 *
 * A flow's `data` is the raw row, where a relation is a bare foreign key — so
 * every `data.<rel>.<field>` in every bundled template resolved to `undefined`
 * and interpolated to an empty string, leaving sentences like
 * "WO-00031 for , normal priority." Nothing failed; the punctuation was the
 * only evidence. `docs/flows.md` documents this dereference as the way to write
 * a flow, and the catalog uses it 267 times across 25 of the 27 templates, so
 * the payload was the thing that was wrong.
 *
 * Only the relations the flow names are loaded, and only for `relation` (a
 * `relation_many` holds a list of ids — there is no single row to stand in for
 * it). A relation that cannot be read leaves its id in place rather than
 * failing the run: a notification is not worth halting a flow over.
 */
const expandRelations = async (
  ctx: Ctx,
  tenantId: string | null,
  collectionSlug: string | null | undefined,
  data: Record<string, unknown>,
  operations: unknown,
): Promise<Record<string, unknown>> => {
  if (!tenantId || !collectionSlug) return data;
  const wanted = dereferencedRelations(operations);
  if (wanted.size === 0) return data;

  let collection: CollectionRow;
  try {
    collection = await loadCollection(ctx, tenantId, collectionSlug);
  } catch {
    return data;
  }
  const rels = (collection.fields as { name: string; type?: string; to?: string }[]).filter(
    (f) => f.type === "relation" && typeof f.to === "string" && wanted.has(f.name),
  );
  if (rels.length === 0) return data;

  const out = { ...data };
  for (const f of rels) {
    const id = data[f.name];
    if (typeof id !== "string" || !id) continue;
    try {
      const target = await loadCollection(ctx, tenantId, f.to as string);
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${sql.identifier(target.physicalTable)} ${whereOf(
          sql`${sql.identifier(target.pkColumn)} = ${id}`,
          target.tenantScoped ? sql`${sql.identifier("tenant_id")} = ${tenantId}` : null,
          deletedFilter(target),
        )} LIMIT 1`,
      );
      const raw = rows[0];
      if (!raw) continue;
      out[f.name] = relationValue(
        deserializeRow(raw, target.fields, ctx.dialect, target.ownerScoped, null, target),
        id,
      );
    } catch {
      // Leave the id. A flow that only wanted a name should not die because
      // the target collection was archived or renamed under it.
    }
  }
  return out;
};

const interpolate = (value: unknown, ctx: RunCtx): unknown => {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w$.]+)\s*\}\}/g, (_, path: string) => {
      const parts = path.split(".");
      const root: Record<string, unknown> = {
        data: ctx.data,
        $user: {
          id: ctx.authSubject.userId,
          email: ctx.authSubject.email,
          roles: ctx.authSubject.roles,
        },
        $last: ctx.last,
        $item: ctx.item ?? null,
      };
      let cur: unknown = root;
      for (const p of parts) {
        if (cur && typeof cur === "object" && p in (cur as object)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return "";
        }
      }
      return cur === null || cur === undefined ? "" : String(cur);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolate(v, ctx);
    }
    return out;
  }
  return value;
};

class FlowOpError extends Error {}

/**
 * The row an item-triggered run is about.
 *
 * Item channels are `items:<slug>`; everything else (a booking channel, a cron
 * tick, a manual invoke) has no single subject row, and guessing one from
 * `data` would be worse than having none — `approval.request` would then patch
 * whatever collection happened to share the shape.
 */
const itemSubject = (
  channel: string,
  data: Record<string, unknown>,
): { collection: string; id: string } | null => {
  const [head, slug] = channel.split(":");
  if (head !== "items" || !slug) return null;
  const id = data?.id;
  if (id == null || id === "") return null;
  return { collection: slug, id: String(id) };
};

const defaultSubject = (ctx: RunCtx): { collection: string; id: string } | null =>
  ctx.subject ?? null;

/** Sentinel thrown by long `delay` ops at the top of a flow. The runner
 *  unwinds, persists the rest of the work to `scheduled_tasks`, and the
 *  scheduler picks it back up when the clock catches up. */
class FlowDeferred {
  constructor(public readonly durationMs: number) {}
}

/**
 * Sentinel thrown by `approval.request`. Same unwinding as `FlowDeferred`,
 * but the checkpoint is stored on the approval request rather than on a timer,
 * and what wakes it is a person rather than the clock.
 *
 * `rejectedOps` rides along because the two branches have to be parked
 * TOGETHER: the decision that resumes the flow may arrive days later, in
 * another process, with nothing but the request row to work from.
 */
class FlowAwaiting {
  constructor(
    public readonly create: (
      remainingOps: Operation[],
      rejectedOps: Operation[],
      state: {
        data: Record<string, unknown>;
        authSubject: AuthSubject;
        last: unknown;
        subject: { collection: string; id: string } | null;
      },
    ) => Promise<{ requestId: string }>,
  ) {}
}

const buildUrl = (
  url: string,
  query?: Record<string, string>,
): string => {
  if (!query || Object.keys(query).length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  const qs = new URLSearchParams(query).toString();
  return url + sep + qs;
};

/** `2026-08-01` — an all-day event, which the ics builder handles as a date
 *  rather than an instant. Passed through verbatim so it stays one. */
const ICS_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Render the `ics` block of an `email` op into an attachment.
 *
 * The `uid` is the part worth reading twice. A calendar keys an event on it, so
 * a re-send with the SAME uid updates the entry the recipient already accepted
 * and a fresh one books the appointment a second time. It therefore defaults to
 * the triggering row's id — the one value that is stable across every re-run of
 * a row-scoped flow — and only falls back to something random when the flow has
 * no row at all, where there is nothing to be stable about.
 */
const buildInvite = (
  ics: NonNullable<Extract<Operation, { type: "email" }>["ics"]>,
  ctx: RunCtx,
  recipient: string,
): EmailAttachment => {
  const str = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    const rendered = String(interpolate(v, ctx) ?? "").trim();
    return rendered || undefined;
  };

  const start = str(ics.start);
  if (!start) throw new FlowOpError(`ics start "${ics.start}" rendered empty`);
  // A date that does not parse produces `Invalid Date`, which serialises to a
  // literal "Invalid Date" in the file and is refused by every calendar. Better
  // to fail the op and name the template that produced it — never the value,
  // which is persisted on the run's activity row.
  const startsAt = ICS_DATE_ONLY.test(start) ? start : parseWhen(start, ics.start, "start");
  const end = str(ics.end);
  const endsAt = end ? (ICS_DATE_ONLY.test(end) ? end : parseWhen(end, ics.end!, "end")) : undefined;

  const rowId = (ctx.data as { id?: unknown } | undefined)?.id;
  const uid =
    str(ics.uid) ??
    `${rowId !== undefined && rowId !== null && rowId !== "" ? String(rowId) : crypto.randomUUID()}@backlex`;

  const attendeeList = str(ics.attendees) ?? recipient;
  const organizerEmail = str(ics.organizerEmail);

  const content = buildIcs({
    uid,
    dtstamp: new Date(),
    start: startsAt,
    ...(endsAt ? { end: endsAt } : {}),
    summary: str(ics.summary) ?? "Appointment",
    ...(str(ics.description) ? { description: str(ics.description)! } : {}),
    ...(str(ics.location) ? { location: str(ics.location)! } : {}),
    ...(str(ics.url) ? { url: str(ics.url)! } : {}),
    ...(organizerEmail
      ? {
          organizer: {
            email: organizerEmail,
            ...(str(ics.organizerName) ? { name: str(ics.organizerName)! } : {}),
          },
        }
      : {}),
    attendees: attendeeList
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((email) => ({ email })),
    ...(ics.sequence !== undefined ? { sequence: ics.sequence } : {}),
    ...(ics.method ? { method: ics.method } : {}),
  });

  return {
    filename: str(ics.filename) ?? "invite.ics",
    content: icsAttachmentContent(content),
    // The `method` parameter is what makes a mail client render accept/decline
    // rather than offer the file as a download.
    contentType: icsContentType(ics.method ?? (organizerEmail ? "REQUEST" : "PUBLISH")),
  };
};

/**
 * Collect an `email` op's attachments: stored objects plus an optional invite.
 *
 * `attach` carries STORAGE KEYS, never URLs, and this is the enforcement rather
 * than a convention. A key is looked up in the deployment's own storage; a URL
 * would turn the mail path into a fetcher that posts whatever it was pointed at
 * to an address the same flow chose — request forgery with the mail as the
 * exfiltration channel. The key is also prefix-checked, so a flow cannot mail
 * out an arbitrary uploaded object by guessing its path.
 */
const emailAttachments = async (
  op: Extract<Operation, { type: "email" }>,
  ctx: RunCtx,
  recipient: string,
): Promise<{ attachments?: EmailAttachment[] }> => {
  const out: EmailAttachment[] = [];
  // Scoped to THIS workspace's own documents, not just to the prefix. Storage
  // is one namespace across every tenant, so `documents/` alone would let a
  // flow in one workspace mail out another's contract given its key — and a
  // key can travel in through the row a flow reads.
  const prefix = `documents/${ctx.authSubject.tenantId ?? "shared"}/`;
  for (const raw of op.attach ?? []) {
    const key = String(interpolate(raw, ctx) ?? "").trim();
    if (!key) throw new FlowOpError(`email attachment "${raw}" rendered empty`);
    if (!key.startsWith(prefix)) {
      // Only what a `document.render` op produced FOR THIS WORKSPACE. Anything
      // else is a user upload this flow was never handed, or another
      // workspace's document.
      throw new FlowOpError(`email attachment "${raw}" is not a generated document`);
    }
    const object = await ctx.ctx.storage.get(key);
    if (!object) throw new FlowOpError(`email attachment "${key}" is not in storage`);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    out.push({
      filename: key.split("/").pop() || "document.pdf",
      content: toBase64(bytes),
      contentType: object.meta.contentType ?? "application/pdf",
    });
  }
  if (op.ics) out.push(buildInvite(op.ics, ctx, recipient));
  return out.length > 0 ? { attachments: out } : {};
};

/** Chunked so a multi-megabyte document does not blow the argument limit the
 *  spread form of `String.fromCharCode` has. */
const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

const parseWhen = (rendered: string, template: string, field: string): Date => {
  const ms = Date.parse(rendered);
  const asNumber = Number(rendered);
  const at = Number.isFinite(ms) ? new Date(ms) : Number.isFinite(asNumber) ? new Date(asNumber) : null;
  if (!at) throw new FlowOpError(`ics ${field} "${template}" did not render to a date`);
  return at;
};

/**
 * The generation both AI ops make.
 *
 * One helper rather than two copies, because everything except the prompt is
 * the same four decisions each time and each of the four has already been got
 * wrong somewhere in this repo:
 *
 *  - the gate asks `aiAvailable`, not `hasDirectAiCredential`. The latter is
 *    false on EVERY managed-cloud project — the deployment where AI is a
 *    platform feature nobody configures — and asking it is how the `ai.*` MCP
 *    tools came to refuse on exactly the installs that needed no setup.
 *  - the env comes from `resolveAiRuntime`, not `ctx.ctx.env`. A workspace that
 *    brought its own key in Settings · AI is billed to that key; reading the
 *    deployment env instead silently bills the operator and ignores the
 *    workspace's chosen model.
 *  - the gate runs on the RESOLVED env, after the overlay. A self-host
 *    deployment with no key of its own is still able to generate for a
 *    workspace that supplied one, and checking before the overlay would refuse
 *    that workspace.
 *  - the meter is a required argument. `null` is the "not attributable" answer
 *    and is not what a flow run is: it has a tenant, so it has a payer.
 */
const generateForFlow = async (
  ctx: RunCtx,
  what: "ai.generate" | "ai.classify",
  req: Omit<ClaudeRequest, "signal">,
  timeoutMs: number,
): Promise<ClaudeResponse> => {
  const tenantId = ctx.authSubject.tenantId ?? null;
  if (!tenantId) {
    // The same fail-closed rule every credential-touching op here follows. A
    // run we cannot attribute to a workspace must not spend one's AI budget.
    throw new FlowOpError(`${what} requires a workspace-scoped run`);
  }
  const runtime = await resolveAiRuntime(ctx.ctx, tenantId);
  if (!aiAvailable(runtime.env)) {
    throw new FlowOpError(
      `${what}: no AI provider is configured — set a key under Settings · AI, or run on managed cloud where generation is included`,
    );
  }
  // Before the generation, not after: a workspace over its monthly AI budget
  // is refused rather than billed and then told. This path is the reason the
  // budget exists — a cron-triggered flow with an AI step inside a `foreach`
  // generates once per row with nobody watching.
  try {
    await assertAiQuota(ctx.ctx, ctx.ctx.env, tenantId);
  } catch (e) {
    throw new FlowOpError(`${what}: ${(e as Error).message}`);
  }
  // A flow run is dispatched fire-and-forget with no retry and no dead-letter
  // queue, so nothing above this reclaims a generation that never returns.
  // Until this op, `request`/`webhook` was the only branch in the engine with a
  // wall-clock ceiling and the AI path had none at all.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await callClaude(
      runtime.env,
      { ...req, model: req.model ?? runtime.model, signal: controller.signal },
      aiMeterForTenant(ctx.ctx, tenantId),
    );
  } catch (e) {
    if (e instanceof FlowOpError) throw e;
    if (timedOut) throw new FlowOpError(`${what}: the model did not answer within ${timeoutMs}ms`);
    throw new FlowOpError(`${what} failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A template, cut short enough to name in an error.
 *
 * Every other op names its misconfigured field in full because those fields are
 * a phone number or a column path. An AI prompt is up to twenty thousand
 * characters of author-written instruction, and flow-op errors are persisted
 * onto the `flow.run` activity row — so naming it in full turns one bad
 * template into a database write per run.
 *
 * Takes `unknown` rather than `string` for the reason every guard in
 * `flow-validation.ts` does: GraphQL stores `operations` as an opaque JSON
 * scalar, so a saved op's field is only a string on the REST path.
 */
const clip = (s: unknown, max = 80): string => {
  const v = typeof s === "string" ? s : String(s ?? "");
  return v.length <= max ? v : `${v.slice(0, max)}…`;
};

/** An optional op field that must be a non-empty string to be worth sending on.
 *  Same `unknown` reason as {@link clip}. */
const optionalText = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * A numeric op bound, taken from the op when it is one and defaulted when it is
 * not.
 *
 * The schema already caps `maxTokens` and `timeoutMs`, and that cap binds REST
 * only — GraphQL stores `operations` as an opaque JSON scalar, so a flow
 * authored there can carry `maxTokens: 999999` or a string where a number
 * belongs. On the managed-cloud gateway an oversized budget is harmless (it
 * pins its own ceiling and ignores ours); on a direct provider key it is
 * forwarded and paid for. So the ceiling is re-applied where it actually binds.
 */
const clampBound = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
};

/**
 * Which label a classification answer means, or null.
 *
 * Two attempts, on purpose. The first is the contract: fold both sides and
 * compare. The second forgives the one thing a model reliably does anyway —
 * answering `"Billing."` when asked for `Billing` — by stripping surrounding
 * quotes and trailing sentence punctuation from the ANSWER. It is never applied
 * to the author's labels, where `v1.0` and `n/a` are legitimate values that
 * stripping would quietly rewrite.
 */
const matchLabel = (answer: string, labels: string[]): string | null => {
  const direct = labels.find((l) => foldLabel(l) === foldLabel(answer));
  if (direct) return direct;
  const loose = foldLabel(answer.replace(/^[\s"'`]+/, "").replace(/[\s"'`.!]+$/, ""));
  return labels.find((l) => foldLabel(l) === loose) ?? null;
};

/**
 * Execute a single op and return its result. Throws FlowOpError on failure;
 * the caller wraps with try/catch to dispatch to onError branch.
 */
const executeOp = async (op: Operation, ctx: RunCtx): Promise<unknown> => {
  if (op.type === "log") {
    const message = interpolate(op.message, ctx) as string;
    console.log(`[flow] ${message}`);
    // Also kept on the run so it is readable through the API. `console.log`
    // alone reaches only the account's Worker observability, which a managed
    // tenant's operator cannot open.
    if (ctx.log) {
      if (ctx.log.length < MAX_LOG_LINES) ctx.log.push(String(message).slice(0, MAX_LOG_LINE));
      else if (ctx.log.length === MAX_LOG_LINES) ctx.log.push(`… log truncated at ${MAX_LOG_LINES} lines`);
    }
    return { message };
  }

  if (op.type === "webhook" || op.type === "request") {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(op.headers ?? {}),
    };
    const body =
      op.body !== undefined
        ? JSON.stringify(interpolate(op.body, ctx))
        : op.type === "webhook"
          ? JSON.stringify(ctx.data)
          : undefined;
    const query =
      op.type === "request" && op.query
        ? (interpolate(op.query, ctx) as Record<string, string>)
        : undefined;
    const url = buildUrl(interpolate(op.url, ctx) as string, query);
    const timeoutMs = op.type === "request" ? (op.timeoutMs ?? 10_000) : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: op.method ?? (op.type === "webhook" ? "POST" : "GET"),
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) init.body = body;
      // SSRF guard (managed cloud / opt-in): private-host block + redirect
      // re-validation. Plain fetch on self-host so internal endpoints work.
      const res = await fetchOutbound(ctx.ctx.env, url, init);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }
      const result = { status: res.status, ok: res.ok, body: parsed };
      if (!res.ok) throw new FlowOpError(`HTTP ${res.status}`);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  if (op.type === "email") {
    const to = interpolate(op.to, ctx) as string;
    // Render context for `{{ ... }}` placeholders inside the template body.
    // Top-level `data` plus the flow user/last so templates can reach
    // `{{ data.title }}`, `{{ $user.email }}`, `{{ $last.status }}`.
    const renderVars: Record<string, unknown> = {
      data: ctx.data,
      $user: {
        id: ctx.authSubject.userId,
        email: ctx.authSubject.email,
        roles: ctx.authSubject.roles,
      },
      $last: ctx.last,
      ...((op.vars ? (interpolate(op.vars, ctx) as Record<string, unknown>) : {})),
    };
    // Tenant scope: fall back to the row's own tenantId if the runtime didn't
    // supply one (event triggers don't carry an authSubject).
    const tenantId = ctx.authSubject.tenantId ?? null;
    const result = await sendTemplatedEmail(ctx.ctx, {
      to,
      templateKey: op.templateKey,
      tenantId,
      vars: renderVars,
      fallback: {
        subject: op.subject,
        html: op.html,
        text: op.text,
      },
      ...(await emailAttachments(op, ctx, to)),
    });
    return result;
  }

  if (op.type === "document.render") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    const vars: Record<string, unknown> = {
      data: ctx.data,
      $user: {
        id: ctx.authSubject.userId,
        email: ctx.authSubject.email,
        roles: ctx.authSubject.roles,
      },
      $last: ctx.last,
      ...(op.vars ? (interpolate(op.vars, ctx) as Record<string, unknown>) : {}),
    };
    let rendered: Awaited<ReturnType<typeof renderDocument>>;
    try {
      rendered = await renderDocument(ctx.ctx, tenantId, {
        ...(op.templateKey ? { templateKey: op.templateKey } : {}),
        ...(op.html ? { html: op.html } : {}),
        vars,
        ...(op.filename ? { filename: interpolate(op.filename, ctx) as string } : {}),
      });
    } catch (e) {
      throw new FlowOpError(`document.render failed: ${(e as Error).message}`);
    }

    // Stored under a tenant-prefixed, RANDOM key. Not derived from the
    // filename: two invoices called `invoice.pdf` would otherwise overwrite
    // each other, and a filename comes from row data, so deriving the object
    // path from it lets a row decide where it lands.
    const key = `documents/${tenantId ?? "shared"}/${crypto.randomUUID()}/${rendered.filename}`;
    const stored = await ctx.ctx.storage.put({
      key,
      body: rendered.bytes,
      contentType: rendered.contentType,
    });

    if (op.writeBack) {
      const rowId = String(interpolate(op.writeBack.id, ctx) ?? "").trim();
      if (!rowId) {
        throw new FlowOpError(`document.render writeBack id "${op.writeBack.id}" rendered empty`);
      }
      if (!tenantId) {
        // The write is tenant-scoped; without one it would have to guess which
        // workspace's row to patch.
        throw new FlowOpError("document.render writeBack requires a workspace-bound run");
      }
      await updateItem(ctx.ctx, {
        slug: op.writeBack.collection,
        tenantId,
        id: rowId,
        data: { [op.writeBack.field]: key },
      });
    }

    return {
      key,
      filename: rendered.filename,
      size: stored.size,
      renderer: rendered.renderer,
    };
  }

  if (op.type === "document.sign") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    const vars: Record<string, unknown> = {
      data: ctx.data,
      $user: {
        id: ctx.authSubject.userId,
        email: ctx.authSubject.email,
        roles: ctx.authSubject.roles,
      },
      $last: ctx.last,
      ...(op.vars ? (interpolate(op.vars, ctx) as Record<string, unknown>) : {}),
    };

    // `signers` may be a literal list or a single template that resolves to
    // one — a row that carries its own counterparties (a lease with two
    // tenants) cannot be written out as a static array in the flow.
    const resolved = resolveWhole(op.signers as unknown, ctx);
    const list = Array.isArray(resolved) ? resolved : [];
    if (list.length === 0) {
      throw new FlowOpError("document.sign resolved to no signers");
    }
    const signers = list.map((entry) => {
      const person = (typeof entry === "string" ? { email: entry } : entry) as Record<string, unknown>;
      return {
        email: String(person.email ?? "").trim(),
        ...(person.name ? { name: String(person.name) } : {}),
        ...(person.role ? { role: String(person.role) } : {}),
      };
    });

    const str = (v: string | undefined): string | undefined => {
      if (v === undefined) return undefined;
      const out = String(interpolate(v, ctx) ?? "").trim();
      return out || undefined;
    };
    const notify = resolveWhole(op.notifyEmails as unknown, ctx);

    let created: Awaited<ReturnType<typeof createSignatureRequest>>;
    try {
      created = await createSignatureRequest(
        ctx.ctx,
        tenantId,
        {
          ...(op.templateKey ? { templateKey: op.templateKey } : {}),
          ...(op.html ? { html: op.html } : {}),
          vars,
          ...(str(op.title) ? { title: str(op.title)! } : {}),
          ...(str(op.message) ? { message: str(op.message)! } : {}),
          ...(str(op.filename) ? { filename: str(op.filename)! } : {}),
          signers,
          ...(op.ordered !== undefined ? { ordered: op.ordered } : {}),
          ...(op.expiresInDays !== undefined ? { expiresInDays: op.expiresInDays } : {}),
          ...(op.writeBack
            ? {
                writeBack: {
                  collection: op.writeBack.collection,
                  id: String(interpolate(op.writeBack.id, ctx) ?? "").trim(),
                  field: op.writeBack.field,
                },
              }
            : {}),
          ...(Array.isArray(notify) ? { notifyEmails: notify.map((e) => String(e)) } : {}),
        },
        ctx.authSubject.userId ?? null,
      );
    } catch (e) {
      throw new FlowOpError(`document.sign failed: ${(e as Error).message}`);
    }

    // NO signing links on the result. Whatever an op returns lands on `$last`,
    // which every op after it can read — a `webhook` posting `{{ $last }}`
    // onward, a `log` writing it to the server log. A link is a bearer
    // credential for somebody else's signature, so handing it to the flow
    // graph means it leaves through whichever op the author adds next.
    // Customise the invitation through the `signature_request` email template
    // instead, which is the right seam for it anyway.
    return {
      id: created.request.id,
      status: created.request.status,
      sent: created.sent,
      signers: created.request.signers.map((s) => ({ id: s.id, email: s.email, status: s.status })),
    };
  }

  if (op.type === "approval.request") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    const str = (v: string | undefined): string | undefined => {
      if (v === undefined) return undefined;
      const out = String(interpolate(v, ctx) ?? "").trim();
      return out || undefined;
    };

    const title = str(op.title);
    if (!title) throw new FlowOpError(`approval.request title "${op.title}" rendered empty`);

    // Same shape as `document.sign`'s signers: a literal list, or one template
    // resolving to a list, for a row that carries its own approvers.
    const resolved = resolveWhole(op.approvers as unknown, ctx);
    const list = Array.isArray(resolved) ? resolved : [];
    if (list.length === 0) throw new FlowOpError("approval.request resolved to no approvers");
    const approvers = list.map((entry) => {
      const person = (typeof entry === "string" ? { email: entry } : entry) as Record<string, unknown>;
      return {
        email: String(person.email ?? "").trim(),
        ...(person.name ? { name: String(person.name) } : {}),
        ...(person.role ? { role: String(person.role) } : {}),
      };
    });

    // The subject defaults to the triggering row: an event-triggered flow
    // almost always asks about the row that fired it, and writing it out again
    // in the op is noise that can drift from the trigger.
    const subject = op.subject
      ? {
          collection: String(interpolate(op.subject.collection, ctx) ?? "").trim(),
          id: String(interpolate(op.subject.id, ctx) ?? "").trim(),
        }
      : defaultSubject(ctx);

    const summaryRaw = resolveWhole(op.summary as unknown, ctx);
    const summary = Array.isArray(summaryRaw)
      ? summaryRaw.map((row) => {
          const cell = (typeof row === "string" ? { label: "", value: row } : row) as Record<string, unknown>;
          return { label: String(cell.label ?? ""), value: String(cell.value ?? "") };
        })
      : undefined;

    const notify = resolveWhole(op.notifyEmails as unknown, ctx);

    // Everything above is computed BEFORE unwinding, so a malformed op fails
    // here — as an ordinary op error the flow author can see in the run log —
    // rather than after the flow has already been checkpointed and there is
    // nobody left to report to.
    throw new FlowAwaiting(async (remainingOps, rejectedOps, state) => {
      const created = await createApprovalRequest(
        ctx.ctx,
        tenantId,
        {
          title,
          ...(str(op.message) ? { message: str(op.message)! } : {}),
          approvers,
          ...(op.policy ? { policy: op.policy } : {}),
          ...(op.quorum !== undefined ? { quorum: op.quorum } : {}),
          ...(op.ordered !== undefined ? { ordered: op.ordered } : {}),
          ...(op.expiresInHours !== undefined ? { expiresInHours: op.expiresInHours } : {}),
          ...(subject?.collection && subject.id ? { subject } : {}),
          ...(summary ? { summary } : {}),
          ...(op.writeBack
            ? {
                writeBack: {
                  ...(op.writeBack.collection ? { collection: op.writeBack.collection } : {}),
                  ...(op.writeBack.id
                    ? { id: String(interpolate(op.writeBack.id, ctx) ?? "").trim() }
                    : {}),
                  field: op.writeBack.field,
                  approvedValue: op.writeBack.approvedValue,
                  rejectedValue: op.writeBack.rejectedValue,
                },
              }
            : {}),
          ...(Array.isArray(notify) ? { notifyEmails: notify.map((e) => String(e)) } : {}),
          continuation: {
            kind: "flow-continuation",
            remainingOps,
            rejectedOps,
            data: state.data,
            authSubject: state.authSubject,
            last: state.last,
            subject: state.subject,
          },
        },
        ctx.authSubject.userId ?? null,
      );
      return { requestId: created.request.id };
    });
  }

  if (op.type === "report.deliver") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    if (!tenantId) {
      // The dashboard, its panels and the mail transport are all workspace-
      // scoped; without one the op would have to guess whose numbers to print.
      throw new FlowOpError("report.deliver requires a workspace-bound run");
    }
    const str = (v: string | undefined): string | undefined => {
      if (v === undefined) return undefined;
      const out = String(interpolate(v, ctx) ?? "").trim();
      return out || undefined;
    };
    const dashboardId = str(op.dashboardId);
    if (!dashboardId) throw new FlowOpError(`report.deliver dashboardId "${op.dashboardId}" rendered empty`);
    const to = str(op.to);
    // `to` present in the op but rendering empty means the template pointed at
    // something the row does not carry. Silently downgrading to render-only
    // would produce a scheduled report that stops arriving and never says so.
    if (op.to !== undefined && !to) {
      throw new FlowOpError(`report.deliver to "${op.to}" rendered empty`);
    }

    try {
      const out = await deliverReport(ctx.ctx, ctx.authSubject, tenantId, {
        dashboardId,
        ...(str(op.filename) ? { filename: str(op.filename)! } : {}),
        ...(op.pageOptions ? { pageOptions: op.pageOptions } : {}),
        ...(to
          ? {
              email: {
                to,
                ...(str(op.subject) ? { subject: str(op.subject)! } : {}),
                ...(op.templateKey ? { templateKey: op.templateKey } : {}),
              },
            }
          : {}),
      });
      return out;
    } catch (e) {
      throw new FlowOpError(`report.deliver failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "transform") {
    return interpolate(op.value, ctx);
  }

  if (op.type === "run-script") {
    const result = await runFunction(
      op.code,
      { ctx: ctx.ctx, auth: ctx.authSubject },
      { data: ctx.data, last: ctx.last },
      op.timeoutMs ?? 5_000,
    );
    if (!result.ok) {
      throw new FlowOpError(result.error ?? "script failed");
    }
    return result.value;
  }

  if (op.type === "condition") {
    const passes = matchesCondition(
      ctx.data,
      op.filter as Condition,
      ctx.authSubject,
    );
    const branch = passes ? op.then : op.else;
    if (branch) {
      for (const sub of branch) {
        ctx.last = await runOperation(sub, ctx);
      }
    }
    return { matched: passes };
  }

  if (op.type === "foreach") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    if (!tenantId) {
      // Same fail-closed rule every collection-touching op here follows: a run
      // we cannot attribute to a workspace must not read anybody's rows.
      throw new FlowOpError("foreach requires a workspace-scoped run");
    }
    const slug = String(interpolate(op.collection, ctx) ?? "").trim();
    if (!slug) throw new FlowOpError("foreach: collection is required");
    const collection = await loadCollection(ctx.ctx, tenantId, slug);
    const limit = Math.min(op.limit ?? FOREACH_MAX_ROWS, FOREACH_MAX_ROWS);

    const filters = [
      collection.tenantScoped
        ? sql`${sql.identifier("tenant_id")} = ${tenantId}`
        : null,
      deletedFilter(collection),
      collection.versioned ? sql`${sql.identifier("_status")} = 'published'` : null,
      op.filter
        ? compileCondition(op.filter as Condition, ctx.authSubject, undefined, undefined, {
            dialect: ctx.ctx.dialect,
          })
        : null,
    ];
    const order = foreachOrderBy(collection, op.sort);
    const rows = await queryAll<Record<string, unknown>>(
      ctx.ctx,
      sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} ${whereOf(...filters)}${order} LIMIT ${limit}`,
    );
    if (rows.length === limit) {
      // A loop that stops at the cap has covered less than "every row that
      // matches", and saying so is the only way an operator finds out before
      // the omission does something visible.
      console.warn(
        `[flow] foreach over ${slug} hit its ${limit}-row limit — later matching rows were not visited`,
      );
    }

    let visited = 0;
    for (const raw of rows) {
      const item = deserializeRow(
        raw,
        collection.fields,
        ctx.ctx.dialect,
        collection.ownerScoped,
        null,
        collection,
      );
      const rowId = raw[collection.pkColumn];
      // A per-iteration view over the same run: `last` still threads forward so
      // an op can read the previous one's result, but `item` and `subject` are
      // restored afterwards so nothing downstream inherits the final row.
      const iter: RunCtx = {
        ...ctx,
        item,
        subject:
          rowId === null || rowId === undefined || rowId === ""
            ? ctx.subject
            : { collection: collection.slug, id: String(rowId) },
      };
      for (const sub of op.do) {
        iter.last = await runOperation(sub, iter);
      }
      ctx.last = iter.last;
      visited++;
    }
    return { collection: slug, visited };
  }

  if (op.type === "notification") {
    const title = interpolate(op.title, ctx) as string;
    const body = op.body ? (interpolate(op.body, ctx) as string) : null;
    const url = op.url ? (interpolate(op.url, ctx) as string) : null;
    const userId = op.userId
      ? (interpolate(op.userId, ctx) as string)
      : op.userId === null
        ? null
        : null;
    const dialect = ctx.ctx.dialect;
    const t =
      dialect === "pg"
        ? pg.schema.notifications
        : sqlite.schema.notifications;
    // Stamp the originating workspace so the row (including broadcasts) is only
    // visible to that tenant — the notifications API filters reads by tenant_id.
    const tenantId = ctx.authSubject.tenantId ?? null;
    try {
      await (ctx.ctx.db as any).insert(t).values({
        id: crypto.randomUUID(),
        tenantId,
        userId: userId || null,
        title,
        body,
        url,
        flowId: null,
        readAt: null,
        createdAt: dialect === "pg" ? new Date() : Date.now(),
      });
      // Opt-in fan-out to the target user's push devices (never for broadcasts).
      if (op.push && userId) {
        try {
          await sendPushToUsers(ctx.ctx, tenantId, {
            userIds: [userId],
            title,
            body: body ?? title,
            url: url ?? undefined,
          });
        } catch {
          // push is best-effort here — the in-app row already landed
        }
      }
      return { sent: true, title };
    } catch (e) {
      throw new FlowOpError(
        `notification insert failed: ${(e as Error).message}`,
      );
    }
  }

  if (op.type === "push") {
    const title = op.title ? (interpolate(op.title, ctx) as string) : undefined;
    const body = op.body ? (interpolate(op.body, ctx) as string) : undefined;
    const url = op.url ? (interpolate(op.url, ctx) as string) : undefined;
    const userId = interpolate(op.userId, ctx) as string;
    const tenantId = ctx.authSubject.tenantId ?? null;
    try {
      // Same two-layer render as the `email` op: the flow's own `{{ … }}`
      // interpolation runs over the op's fields here, and `sendTemplatedPush`
      // then renders the stored template against `vars`.
      const result = await sendTemplatedPush(ctx.ctx, tenantId, {
        userIds: userId ? [userId] : [],
        templateKey: op.templateKey,
        vars: (interpolate(op.vars ?? {}, ctx) as Record<string, unknown>) ?? {},
        fallback: { title, body, url },
      });
      return { sent: result.sent, failed: result.failed };
    } catch (e) {
      throw new FlowOpError(`push send failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "sms") {
    const body = interpolate(op.body, ctx) as string;
    const from = op.from ? (interpolate(op.from, ctx) as string) : undefined;
    const tenantId = ctx.authSubject.tenantId ?? null;
    // The schema already rejects "both" and "neither" at save time; re-check
    // here because a flow row can predate the op or be written by the API.
    if ((op.to == null) === (op.userId == null)) {
      throw new FlowOpError("sms needs exactly one of `to` or `userId`");
    }
    try {
      if (op.to != null) {
        const to = String(interpolate(op.to, ctx) ?? "").trim();
        // Interpolation is where a bad recipient actually shows up: the op
        // stores `{{ data.phone }}` and the row supplies the value. An empty
        // render means the field was missing — say so rather than handing the
        // provider a blank number and reporting a "successful" 0-send.
        if (!to) {
          throw new FlowOpError(`sms recipient "${op.to}" rendered empty`);
        }
        if (!E164_PATTERN.test(to)) {
          // Name the misconfigured field, never the rendered value: this
          // message is persisted on the `flow.run` activity row, and the
          // value here is a customer's phone number. The template alone
          // says which column to go fix.
          //
          // The remedy is named because it now exists and because this is the
          // failure the phone field type was built for: a column of numbers
          // people typed will fail here row by row, at run time, long after the
          // write that caused it. Making the column a `phone` field
          // canonicalizes every future write and `collections normalize-phones`
          // fixes the rows already there. Nothing is canonicalized HERE on
          // purpose — a national number needs a region, and a flow has none to
          // read, so guessing one would text another country.
          throw new FlowOpError(
            `sms recipient "${op.to}" did not render to E.164 (e.g. +14155552671) — ` +
              "make that column a phone field so every write is canonicalized, " +
              "then run `backlex collections normalize-phones` over the existing rows",
          );
        }
        const result = await sendSmsToNumbers(ctx.ctx, tenantId, {
          numbers: [to],
          body,
          from,
        });
        return { sent: result.sent, failed: result.failed };
      }
      const userId = String(interpolate(op.userId, ctx) ?? "").trim();
      if (!userId) {
        throw new FlowOpError(`sms userId "${op.userId}" rendered empty`);
      }
      const result = await sendSmsToUsers(ctx.ctx, tenantId, {
        userIds: [userId],
        body,
        from,
      });
      return { sent: result.sent, failed: result.failed };
    } catch (e) {
      if (e instanceof FlowOpError) throw e;
      throw new FlowOpError(`sms send failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "ai.generate") {
    const prompt = String(interpolate(op.prompt, ctx) ?? "").trim();
    // Interpolation never fails — a template pointing at a column the row does
    // not carry renders to an empty string. Catching that here is the
    // difference between "the flow is misconfigured" and paying for a
    // generation on whitespace and putting its answer on `$last`.
    if (!prompt) throw new FlowOpError(`ai.generate prompt "${clip(op.prompt)}" rendered empty`);
    const system = op.system ? String(interpolate(op.system, ctx) ?? "").trim() || undefined : undefined;
    const model = optionalText(op.model);
    // Only the three the provider layer knows. A GraphQL-authored op can carry
    // anything here, and an unrecognised effort reaching an effort-capable
    // model is a provider 400 rather than a no-op.
    const effort =
      op.effort === "low" || op.effort === "medium" || op.effort === "high" ? op.effort : undefined;
    const reply = await generateForFlow(
      ctx,
      "ai.generate",
      {
        ...(system ? { system } : {}),
        user: prompt,
        ...(model ? { model } : {}),
        maxTokens: clampBound(op.maxTokens, AI_OP_DEFAULT_MAX_TOKENS, AI_OP_MAX_TOKENS),
        ...(effort ? { effort } : {}),
      },
      clampBound(op.timeoutMs, AI_OP_DEFAULT_TIMEOUT_MS, AI_OP_MAX_TIMEOUT_MS),
    );
    const text = reply.text.trim();
    // An empty completion is a step that reported success and produced nothing
    // for the next one to read. Say so here rather than letting `{{ $last.text }}`
    // render blank three ops later.
    if (!text) throw new FlowOpError("ai.generate: the model returned an empty answer");
    // `usage` is passed through exactly as it arrived: tokens on a direct
    // provider, neurons on the managed-cloud gateway, and ABSENT when the
    // provider said nothing. A zero here would read as "this was free".
    return reply.usage ? { text, usage: reply.usage } : { text };
  }

  if (op.type === "ai.classify") {
    // The schema rejects these at save time, and re-checking them here is what
    // makes them hold on GraphQL too: `operations` arrives there as an opaque
    // JSON scalar that never meets zod, so a `.refine()` binds REST alone. It
    // also covers a row written before the op existed. Same reason `sms`
    // re-checks its two addressing modes.
    // Every field is treated as `unknown`: on the GraphQL path none of them met
    // zod, so `labels` can be a string and an element can be a number, and an
    // unguarded `.trim()` here would be a TypeError where a named refusal
    // belongs.
    if (!Array.isArray(op.labels) || op.labels.length < 2 || !op.labels.every((l) => typeof l === "string" && l.trim() !== "")) {
      throw new FlowOpError("ai.classify needs at least two labels, each a non-empty string");
    }
    if (new Set(op.labels.map(foldLabel)).size !== op.labels.length) {
      throw new FlowOpError(
        "ai.classify labels must be distinct (they are matched case-insensitively)",
      );
    }
    const fallback = optionalText(op.fallback);
    if (op.fallback != null && !fallback) {
      throw new FlowOpError("ai.classify fallback must be a non-empty string");
    }
    if (fallback && !op.labels.some((l) => foldLabel(l) === foldLabel(fallback))) {
      throw new FlowOpError("ai.classify fallback must be one of labels");
    }
    const input = String(interpolate(op.input, ctx) ?? "").trim();
    if (!input) throw new FlowOpError(`ai.classify input "${clip(op.input)}" rendered empty`);
    const instructions = op.instructions
      ? String(interpolate(op.instructions, ctx) ?? "").trim() || undefined
      : undefined;
    // Labels are NOT interpolated, deliberately. The set is the contract with
    // whatever `condition` op reads `{{ $last.label }}` next; a set that
    // changed per row would make that condition unwritable.
    const reply = await generateForFlow(
      ctx,
      "ai.classify",
      {
        system: [
          "You are a classifier. Answer with EXACTLY one of the labels below and nothing else — no punctuation, no explanation, no reasoning.",
          `Labels: ${op.labels.join(" | ")}`,
          ...(instructions ? [instructions] : []),
        ].join("\n"),
        user: input,
        ...(optionalText(op.model) ? { model: optionalText(op.model) as string } : {}),
        // A label is a handful of tokens. The ceiling is what stops a model
        // that decides to explain itself from being billed for the essay.
        maxTokens: 32,
        // Mechanical extraction, the same call `agents/memory.ts` makes.
        effort: "low",
      },
      clampBound(op.timeoutMs, AI_OP_DEFAULT_TIMEOUT_MS, AI_OP_MAX_TIMEOUT_MS),
    );
    const label = matchLabel(reply.text, op.labels);
    if (label) return { label, matched: true };
    if (fallback) {
      // Resolve the fallback back to the label AS WRITTEN in `labels`, not as
      // typed in `fallback`. The two are allowed to differ in case (the check
      // above folds), and returning the author's `fallback` spelling would put
      // a value on `$last.label` that is not literally in the set — so a
      // following `condition` written against the set would not match it. The
      // whole promise of this op is that `$last.label` is one of `labels`.
      const fell = op.labels.find((l) => foldLabel(l) === foldLabel(fallback));
      if (fell) return { label: fell, matched: false };
    }
    // The answer itself is NOT named. This message is persisted on the
    // `flow.run` activity row, and a model asked to classify a support ticket
    // can echo the ticket back. The labels are the author's own config and are
    // the half that says what to go fix.
    throw new FlowOpError(
      `ai.classify: the model's answer matched none of [${op.labels.join(" | ")}] — ` +
        "set `fallback` to one of them if that should not fail the run",
    );
  }

  if (op.type === "payment.checkout") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    if (!tenantId) {
      throw new FlowOpError(
        "payment.checkout requires a tenant — the flow run has no workspace bound",
      );
    }
    // Almost every field here is a template over the triggering row, so the
    // interesting failures are render-time, not save-time.
    const rendered = String(interpolate(op.amount, ctx) ?? "").trim();
    const amount = Number(rendered);
    if (!Number.isInteger(amount) || amount <= 0) {
      // Name the template, not the rendered value: this message lands on the
      // persisted `flow.run` activity row, and the value is a customer's
      // invoice total. The template alone says which column to go fix.
      throw new FlowOpError(
        `payment.checkout amount "${op.amount}" did not render to a positive integer ` +
          `in minor units (1050 = 10.50)`,
      );
    }
    const text = (v: string | undefined): string | undefined => {
      if (v === undefined) return undefined;
      const out = String(interpolate(v, ctx) ?? "").trim();
      return out || undefined;
    };
    const writeBack = op.writeBack
      ? {
          collection: String(interpolate(op.writeBack.collection, ctx) ?? "").trim(),
          itemId: String(interpolate(op.writeBack.itemId, ctx) ?? "").trim(),
          urlField: op.writeBack.urlField,
          referenceField: op.writeBack.referenceField,
        }
      : undefined;
    if (writeBack && (!writeBack.collection || !writeBack.itemId)) {
      // A blank target would mint a live payment link and drop it on the
      // floor. Better a failed run than an unrecorded way to pay.
      throw new FlowOpError(
        `payment.checkout write-back target rendered empty ` +
          `("${op.writeBack?.collection}" / "${op.writeBack?.itemId}")`,
      );
    }

    const email = text(op.email);
    const name = text(op.customerName);
    try {
      const out = await createPaymentCheckout(ctx.ctx, tenantId, {
        provider: op.provider,
        providerId: op.providerId,
        amount,
        currency: String(interpolate(op.currency, ctx) ?? "").trim().toUpperCase(),
        description: text(op.description),
        customer: email || name ? { email, name } : undefined,
        successUrl: text(op.successUrl),
        cancelUrl: text(op.cancelUrl),
        reference: text(op.reference),
        writeBack,
      });
      // The URL is returned into `$last` so a following `email`/`sms` op can
      // actually send it — that pairing is the point of the op.
      return {
        url: out.url,
        reference: out.reference,
        provider: out.provider,
        expiresAt: out.expiresAt,
        writtenBack: Boolean(out.writtenBack),
      };
    } catch (e) {
      if (e instanceof FlowOpError) throw e;
      throw new FlowOpError(`payment.checkout failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "payment.refund") {
    const tenantId = ctx.authSubject.tenantId ?? null;
    if (!tenantId) {
      throw new FlowOpError(
        "payment.refund requires a tenant — the flow run has no workspace bound",
      );
    }
    const text = (v: string | undefined): string | undefined => {
      if (v === undefined) return undefined;
      const out = String(interpolate(v, ctx) ?? "").trim();
      return out || undefined;
    };
    const paymentRowId = text(op.paymentRowId);
    const externalId = text(op.externalId);
    const reference = text(op.reference);
    if (!paymentRowId && !externalId && !reference) {
      // The schema already refuses an op that names none of the three, so
      // reaching here means every one of them RENDERED empty — a template
      // pointing at a column the triggering row doesn't carry. Refunding
      // "whichever payment" instead is not a recoverable guess.
      throw new FlowOpError(
        `payment.refund could not tell which payment to refund — ` +
          `paymentRowId/externalId/reference all rendered empty`,
      );
    }

    // Absent means "everything still refundable", so an omitted amount is not
    // an error here the way it is for a checkout. A PRESENT one that renders to
    // nonsense still is.
    let amount: number | undefined;
    if (op.amount !== undefined) {
      const rendered = String(interpolate(op.amount, ctx) ?? "").trim();
      amount = Number(rendered);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new FlowOpError(
          `payment.refund amount "${op.amount}" did not render to a positive integer ` +
            `in minor units (1050 = 10.50) — omit it to refund the whole balance`,
        );
      }
    }

    try {
      const out = await refundPayment(ctx.ctx, tenantId, {
        provider: op.provider,
        providerId: op.providerId,
        paymentRowId,
        externalId,
        reference,
        amount,
        reason: op.reason,
        description: text(op.description),
      });
      // `status` rides along so a following `condition` op can branch on a
      // refund the provider has not actually decided yet.
      return {
        refundId: out.refundId,
        amount: out.amount,
        currency: out.currency,
        status: out.status,
        full: out.full,
        provider: out.provider,
        paymentRowId: out.paymentRowId,
      };
    } catch (e) {
      if (e instanceof FlowOpError) throw e;
      throw new FlowOpError(`payment.refund failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "integration") {
    const kind = interpolate(op.kind, ctx) as string;
    const text = interpolate(op.text, ctx) as string;
    const event = op.event ? (interpolate(op.event, ctx) as string) : "flow.run";
    // `payload` may be an object of templates or a single template string that
    // renders to JSON — mirrors how item.create/update accept `data`.
    let payload: Record<string, unknown> = {};
    const raw = op.payload === undefined ? {} : interpolate(op.payload, ctx);
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch {
        throw new FlowOpError("integration payload string is not valid JSON");
      }
    } else if (raw && typeof raw === "object") {
      payload = raw as Record<string, unknown>;
    }
    try {
      const out = await deliverIntegrationByKind(
        ctx.ctx.env,
        ctx.ctx,
        ctx.authSubject.tenantId ?? null,
        kind,
        { event, text, payload },
      );
      // A kind that isn't connected (or is paused) is reported, not thrown:
      // an integration outage shouldn't take the whole automation down.
      if (out.skipped) return { skipped: true, kind };
      if (!out.ok) throw new FlowOpError(`integration ${kind} responded ${out.status}`);
      return { status: out.status, kind };
    } catch (e) {
      if (e instanceof FlowOpError) throw e;
      throw new FlowOpError(`integration ${kind} failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "integration.task") {
    const kind = String(interpolate(op.kind, ctx) ?? "").trim();
    const task = String(interpolate(op.task, ctx) ?? "").trim();
    const collection = String(interpolate(op.collection, ctx) ?? "").trim();
    const itemId = String(interpolate(op.itemId, ctx) ?? "").trim();
    // An unrendered template is the likely cause — `{{ data.id }}` on a trigger
    // whose payload has no `id`. Saying so beats "row not found", which reads
    // as a deleted row rather than a step aimed at nothing.
    if (!itemId) {
      throw new FlowOpError(
        `integration.task "${kind}.${task}" has no row to act on — ` +
          `"${op.itemId}" rendered empty`,
      );
    }

    const tenantId = ctx.authSubject.tenantId ?? null;
    if (tenantId == null) {
      throw new FlowOpError(
        `integration.task "${kind}.${task}" requires a tenant — the flow run has no workspace bound`,
      );
    }

    const settings = (interpolate(op.settings ?? {}, ctx) ?? {}) as Record<string, unknown>;

    // Unlike the message step above, a missing connection FAILS the run rather
    // than reporting itself skipped. A chat notification nobody received is a
    // notification; a shipment nobody booked is an order the rest of the flow
    // then marks as shipped.
    const integrationId = await connectedIntegrationIdByKind(ctx.ctx, tenantId, kind);
    if (!integrationId) {
      throw new FlowOpError(
        `no connected "${kind}" integration in this workspace — connect it on Integrations, ` +
          `or resume it if it is paused`,
      );
    }

    try {
      const out = await runTask(ctx.ctx, tenantId, {
        integrationId,
        task,
        collection,
        itemId,
        settings,
        outputMapping: op.outputMapping,
        force: op.force,
      });
      // `reused` rides along so a following `condition` can tell a shipment
      // booked by THIS run from one a previous run had already booked.
      return {
        status: out.status,
        outputs: out.outputs,
        artifactKey: out.artifactKey,
        reused: out.reused,
        kind,
        task,
      };
    } catch (e) {
      if (e instanceof FlowOpError) throw e;
      throw new FlowOpError(`integration.task ${kind}.${task} failed: ${(e as Error).message}`);
    }
  }

  if (op.type === "function") {
    const name = interpolate(op.name, ctx) as string;
    const dialect = ctx.ctx.dialect;
    const t =
      dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;
    // Tenant-scoped lookup, fail-closed. The subject's tenant is pinned to the
    // flow row by every entry point, so it is always present for a legitimate
    // run. It previously fell back to a GLOBAL `eq(t.name, name)` when unbound,
    // which let a flow in one workspace resolve and execute another
    // workspace's function purely by name.
    const tenantId = ctx.authSubject.tenantId ?? null;
    if (tenantId == null) {
      throw new FlowOpError(
        `function "${name}" requires a tenant — the flow run has no workspace bound`,
      );
    }
    const where = and(eq(t.name, name), eq(t.tenantId, tenantId));
    const rows = (await (ctx.ctx.db as any)
      .select()
      .from(t)
      .where(where)
      .limit(1)) as Array<{
        code: string;
        timeoutMs: number;
        active: boolean | number;
      }>;
    const fn = rows[0];
    if (!fn) throw new FlowOpError(`function "${name}" not found`);
    if (!fn.active) throw new FlowOpError(`function "${name}" is inactive`);
    const input = op.input !== undefined ? interpolate(op.input, ctx) : ctx.data;
    const result = await runFunction(
      fn.code,
      { ctx: ctx.ctx, auth: ctx.authSubject },
      { data: input, last: ctx.last },
      fn.timeoutMs,
    );
    if (!result.ok) {
      throw new FlowOpError(result.error ?? `function "${name}" failed`);
    }
    return result.value;
  }

  if (op.type === "item.create" || op.type === "item.update") {
    // Tenant comes from the running auth subject only — every entry point pins
    // it to the flow's own workspace. It used to fall back to
    // `ctx.data.tenantId`, i.e. a value the triggering payload controls, which
    // let an op write into whichever workspace the payload named.
    const tenantId = ctx.authSubject.tenantId ?? null;
    if (!tenantId) {
      throw new FlowOpError(
        `${op.type} requires a tenant — the flow run has no workspace bound`,
      );
    }
    const slug = interpolate(op.collection, ctx) as string;
    const rawData = interpolate(op.data, ctx);
    let data: Record<string, unknown>;
    if (typeof rawData === "string") {
      try {
        data = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        throw new FlowOpError(
          `${op.type} data did not parse as JSON: "${rawData.slice(0, 80)}…"`,
        );
      }
    } else if (rawData && typeof rawData === "object") {
      data = rawData as Record<string, unknown>;
    } else {
      throw new FlowOpError(
        `${op.type} data must be an object or a JSON string`,
      );
    }
    if (op.type === "item.create") {
      const result = await createItem(ctx.ctx, {
        slug,
        tenantId,
        ownerId: ctx.authSubject.userId,
        data,
      });
      return result;
    }
    const id = interpolate(op.id, ctx) as string;
    if (!id) throw new FlowOpError("item.update needs an id");
    await updateItem(ctx.ctx, { slug, tenantId, id, data });
    return { id, updated: true };
  }

  if (op.type === "delay") {
    if (op.durationMs <= MAX_INLINE_DELAY_MS) {
      await sleep(op.durationMs);
      return { delayed: op.durationMs, persisted: false };
    }
    // Long delay — bubble out so runFlowOps can checkpoint the remaining
    // ops to scheduled_tasks. Inside nested branches (onSuccess/condition),
    // there's no checkpoint scope so this is rejected and we fall back to
    // an inline sleep at the cap (best-effort) — the compiler warns when
    // it sees nested long delays.
    throw new FlowDeferred(op.durationMs);
  }

  return undefined;
};

const runOperation = async (op: Operation, ctx: RunCtx): Promise<unknown> => {
  let result: unknown;
  try {
    result = await executeOp(op, ctx);
  } catch (e) {
    // Always bubble checkpoint signals — an onError handler swallowing one
    // would turn "the flow is waiting" into "the flow failed", and the parked
    // half would never be created.
    if (e instanceof FlowDeferred || e instanceof FlowAwaiting) throw e;
    const errResult = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    if (op.onError && op.onError.length > 0) {
      ctx.last = errResult;
      for (const sub of op.onError) {
        ctx.last = await runOperation(sub, ctx);
      }
      return errResult;
    }
    // No onError handler — bubble up so the flow halts.
    throw e;
  }
  // Read structurally rather than off the union: `approval.request` has no
  // `onSuccess`, on purpose — it always unwinds, so a success branch attached
  // to it could never run and offering one in the builder would be a lie.
  const onSuccess = (op as { onSuccess?: Operation[] }).onSuccess;
  if (onSuccess && onSuccess.length > 0) {
    ctx.last = result;
    for (const sub of onSuccess) {
      ctx.last = await runOperation(sub, ctx);
    }
  }
  return result;
};

/**
 * Run a flow's operations, and hand back whatever its `log` ops rendered.
 *
 * The collector is installed here rather than at each entry point so every
 * caller — event, cron, manual invoke, and a resumed continuation — records the
 * same thing without having to remember to. `foreach` builds its per-iteration
 * context by spreading this one, so the array reference is shared and lines
 * from inside a loop land in the same place.
 */
const runFlowOps = async (
  flow: Pick<FlowRow, "id" | "name" | "operations">,
  runCtx: RunCtx,
): Promise<FlowRunResult> => {
  if (!runCtx.log) runCtx.log = [];
  const result = await runFlowOpsInner(flow, runCtx);
  return runCtx.log.length ? { ...result, log: runCtx.log } : result;
};

const runFlowOpsInner = async (
  flow: Pick<FlowRow, "id" | "name" | "operations">,
  runCtx: RunCtx,
): Promise<FlowRunResult> => {
  for (let i = 0; i < flow.operations.length; i++) {
    const op = flow.operations[i] as Operation;
    try {
      runCtx.last = await runOperation(op, runCtx);
    } catch (e) {
      if (e instanceof FlowAwaiting) {
        // Everything after this op is the "once approved" branch; the op's own
        // `onRejected` is the other. Both are parked together, because the
        // decision may arrive days later in another process with nothing but
        // the request row to work from.
        const remainingOps = flow.operations.slice(i + 1) as Operation[];
        const rejectedOps = ((op as { onRejected?: Operation[] }).onRejected ?? []) as Operation[];
        try {
          const { requestId } = await e.create(remainingOps, rejectedOps, {
            data: runCtx.data,
            authSubject: runCtx.authSubject,
            last: runCtx.last,
            subject: runCtx.subject ?? null,
          });
          console.log(
            `[flow] ${flow.name} awaiting approval ${requestId} — ${remainingOps.length} op(s) parked`,
          );
          return { ok: true, error: null };
        } catch (err) {
          // Creating the request is what makes the pause real. If it fails the
          // flow has NOT paused — it has stopped — and saying so is the only
          // honest outcome; anything else reports a wait that nobody is in.
          console.error(`[flow] ${flow.name} approval create failed`, err);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (e instanceof FlowDeferred) {
        const remainingOps = flow.operations.slice(i + 1) as Operation[];
        if (remainingOps.length === 0) return { ok: true, error: null }; // nothing to resume to
        const runAt = new Date(Date.now() + e.durationMs);
        const payload: ResumePayload = {
          kind: "flow-continuation",
          flowName: flow.name,
          remainingOps,
          data: runCtx.data,
          authSubject: runCtx.authSubject,
          last: runCtx.last,
          subject: runCtx.subject ?? null,
        };
        try {
          await enqueueTask(runCtx.ctx, {
            flowId: (flow as { id?: string }).id ?? null,
            tenantId: runCtx.authSubject.tenantId ?? null,
            runAt,
            payload,
          });
          console.log(
            `[flow] ${flow.name} paused for ${e.durationMs}ms — ${remainingOps.length} op(s) queued`,
          );
          return { ok: true, error: null };
        } catch (err) {
          console.error(
            `[flow] ${flow.name} pause-enqueue failed`,
            err,
          );
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      console.error(`[flow] ${flow.name} failed`, e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, error: null };
};

/** Fire-and-forget activity row for a flow run so the per-flow KPI cards
 *  (last run / success rate / failures) have something to chew on. Failures
 *  carry `payload.error`; the `durationMs` is the wall-clock op time. */
const logFlowRun = async (
  ctx: Ctx,
  flow: Pick<FlowRow, "id" | "tenantId">,
  result: FlowRunResult,
  durationMs: number,
): Promise<void> => {
  await recordActivity(
    { db: ctx.db, dialect: ctx.dialect },
    {
      userId: null,
      tenantId: flow.tenantId ?? null,
      action: "run",
      collection: "system_flows",
      itemId: flow.id,
      payload: result.ok ? null : { error: result.error },
      response: result,
      durationMs,
    },
  );
};

/** Resume a previously checkpointed flow. Called by the scheduler tick
 *  after `claimDueTasks` returns a row. The continuation re-enters the
 *  same delay-aware runner so chained delays still checkpoint cleanly.
 *  Returns the run outcome — `ok: false` means the continuation halted on
 *  an unhandled op error, and the caller must NOT delete the task row
 *  (leave it claimed for inspection / manual re-queue). */
export const resumeContinuation = async (
  ctx: Ctx,
  payload: ResumePayload,
): Promise<FlowRunResult> => {
  const runCtx: RunCtx = {
    data: payload.data,
    authSubject: payload.authSubject,
    ctx,
    last: payload.last,
    subject: payload.subject ?? null,
  };
  return runFlowOps(
    {
      name: payload.flowName ?? "(scheduled)",
      operations: payload.remainingOps,
    } as Pick<FlowRow, "id" | "name" | "operations">,
    runCtx,
  );
};

/**
 * Run all event-triggered flows whose trigger pattern matches `<channel>:<event>`.
 */
export const runFlows = async (
  ctx: Ctx,
  /** Workspace the event originated in. Required: without it this loaded every
   *  active flow on the instance and matched on the `channel:event` string
   *  alone, so a flow created in one workspace fired on every other
   *  workspace's item writes — with the victim's row as `data`. */
  tenantId: string | null,
  channel: string,
  payload: { event: string; data: Record<string, unknown> },
): Promise<void> => {
  // Fail closed, exactly as `runEventFunctions` does: an event we cannot
  // attribute to a workspace must not fan out at all.
  if (!tenantId) return;
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.active, true), eq(t.tenantId, tenantId)))) as FlowRow[];
  if (rows.length === 0) return;

  const matching = rows.filter((r) => {
    if (r.trigger.startsWith("manual:") || r.trigger.startsWith("cron:")) {
      return false;
    }
    const pattern = r.trigger.startsWith("event:")
      ? r.trigger.slice("event:".length)
      : r.trigger;
    return matchesTrigger(pattern, channel, payload.event);
  });
  if (matching.length === 0) return;

  for (const flow of matching) {
    const subject = itemSubject(channel, payload.data);
    // Per flow, not per event: which relations to resolve is a property of the
    // flow's own text, and a flow that never dereferences one costs nothing.
    const data = await expandRelations(
      ctx,
      flow.tenantId ?? tenantId,
      subject?.collection,
      payload.data,
      flow.operations,
    );
    const runCtx: RunCtx = {
      data,
      // Pin the workspace on the subject so the per-op tenant resolution below
      // can never be steered by an attacker-visible `data.tenantId`.
      authSubject: {
        userId: null,
        email: null,
        roles: [],
        tenantId: flow.tenantId ?? tenantId,
      },
      ctx,
      last: undefined,
      subject,
    };
    const startedAt = Date.now();
    const result = await runFlowOps(flow, runCtx);
    await logFlowRun(ctx, flow, result, Date.now() - startedAt);
  }
};

/**
 * Run a single flow by id with a caller-supplied input payload. Used by
 * manual triggers (`POST /api/flows/:id/run`) and the cron scheduler.
 */
export const runFlowById = async (
  ctx: Ctx,
  flowId: string,
  data: Record<string, unknown>,
  authSubject: AuthSubject = { userId: null, email: null, roles: [] },
  /** A date-relative (`schedule:`) run is ABOUT a row, the way an event run is,
   *  so the caller can name it here. A manual or cron invoke passes nothing and
   *  keeps the old behaviour of having no subject at all. */
  opts: { subject?: { collection: string; id: string } | null } = {},
): Promise<FlowRunResult> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.id, flowId))) as FlowRow[];
  const flow = rows[0];
  if (!flow) return { ok: false, error: "flow not found" };
  if (!flow.active) return { ok: false, error: "flow is paused" };
  const tenantId = flow.tenantId ?? authSubject.tenantId ?? null;
  // A date-relative (`schedule:`) run is ABOUT a row and names it in
  // `opts.subject`, so it reads relations the same way an event run does. A
  // manual or cron invoke has no subject and is left exactly as it was.
  const runCtx: RunCtx = {
    data: await expandRelations(ctx, tenantId, opts.subject?.collection, data, flow.operations),
    // The flow row's own workspace is authoritative — a caller that forgot to
    // thread `tenantId` through must not degrade into an unscoped run, and a
    // `tenantId` in the caller-supplied `data` must never win.
    authSubject: { ...authSubject, tenantId },
    ctx,
    last: undefined,
    subject: opts.subject ?? null,
  };
  const startedAt = Date.now();
  const result = await runFlowOps(flow, runCtx);
  await logFlowRun(ctx, flow, result, Date.now() - startedAt);
  return result;
};

/**
 * Returns flows whose trigger is `cron:<5-field-pattern>` and which are
 * currently active. The scheduler decides which ones fire in a given tick.
 */
export const listCronFlows = async (
  ctx: Ctx,
): Promise<Array<{ id: string; name: string; pattern: string }>> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.active, true))) as FlowRow[];
  const out: Array<{ id: string; name: string; pattern: string }> = [];
  for (const r of rows) {
    if (r.trigger.startsWith("cron:")) {
      const pattern = r.trigger.slice("cron:".length).trim();
      if (pattern) out.push({ id: r.id, name: r.name, pattern });
    }
  }
  return out;
};
