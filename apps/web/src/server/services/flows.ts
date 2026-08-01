import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { matchesCondition } from "@backlex/db";
import { E164_PATTERN, buildIcs, icsContentType } from "@backlex/core";
import type { AuthSubject, Condition, EmailAttachment, Operation } from "@backlex/core";
import type { Ctx } from "../context";
import { runFunction } from "./sandbox";
import { sendTemplatedEmail } from "./email";
import { renderDocument } from "./documents";
import { sendPushToUsers } from "./push";
import { sendSmsToNumbers, sendSmsToUsers } from "./sms";
import { deliverIntegrationByKind } from "./integrations";
import { createPaymentCheckout } from "./payments";
import { createItem, updateItem } from "./items-helpers";
import { enqueueTask, type ResumePayload } from "./scheduled-tasks";
import { recordActivity } from "./activity";
import { fetchOutbound } from "./storage/hosts";

/** Inline-sleep cap. Anything longer is enqueued so the worker isn't
 *  blocked for minutes/hours at a time. */
const MAX_INLINE_DELAY_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export type { Operation };

/** Outcome of a flow execution. `ok: false` means the run halted on an
 *  unhandled op error; `error` carries the first failure message. A run
 *  that checkpointed on a long `delay` still counts as `ok` — the rest is
 *  queued, not failed. */
export interface FlowRunResult {
  ok: boolean;
  error: string | null;
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
}

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

/** Sentinel thrown by long `delay` ops at the top of a flow. The runner
 *  unwinds, persists the rest of the work to `scheduled_tasks`, and the
 *  scheduler picks it back up when the clock catches up. */
class FlowDeferred {
  constructor(public readonly durationMs: number) {}
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
    content: btoa(String.fromCharCode(...new TextEncoder().encode(content))),
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
 * Execute a single op and return its result. Throws FlowOpError on failure;
 * the caller wraps with try/catch to dispatch to onError branch.
 */
const executeOp = async (op: Operation, ctx: RunCtx): Promise<unknown> => {
  if (op.type === "log") {
    const message = interpolate(op.message, ctx) as string;
    console.log(`[flow] ${message}`);
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
    const title = interpolate(op.title, ctx) as string;
    const body = interpolate(op.body, ctx) as string;
    const url = op.url ? (interpolate(op.url, ctx) as string) : undefined;
    const userId = interpolate(op.userId, ctx) as string;
    const tenantId = ctx.authSubject.tenantId ?? null;
    try {
      const result = await sendPushToUsers(ctx.ctx, tenantId, {
        userIds: userId ? [userId] : [],
        title,
        body,
        url,
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
          throw new FlowOpError(
            `sms recipient "${op.to}" did not render to E.164 (e.g. +14155552671)`,
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
    // Always bubble FlowDeferred — onError handlers shouldn't swallow a
    // checkpoint signal.
    if (e instanceof FlowDeferred) throw e;
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
  if (op.onSuccess && op.onSuccess.length > 0) {
    ctx.last = result;
    for (const sub of op.onSuccess) {
      ctx.last = await runOperation(sub, ctx);
    }
  }
  return result;
};

const runFlowOps = async (
  flow: Pick<FlowRow, "id" | "name" | "operations">,
  runCtx: RunCtx,
): Promise<FlowRunResult> => {
  for (let i = 0; i < flow.operations.length; i++) {
    const op = flow.operations[i] as Operation;
    try {
      runCtx.last = await runOperation(op, runCtx);
    } catch (e) {
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
    const runCtx: RunCtx = {
      data: payload.data,
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
): Promise<FlowRunResult> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.id, flowId))) as FlowRow[];
  const flow = rows[0];
  if (!flow) return { ok: false, error: "flow not found" };
  if (!flow.active) return { ok: false, error: "flow is paused" };
  const runCtx: RunCtx = {
    data,
    // The flow row's own workspace is authoritative — a caller that forgot to
    // thread `tenantId` through must not degrade into an unscoped run, and a
    // `tenantId` in the caller-supplied `data` must never win.
    authSubject: {
      ...authSubject,
      tenantId: flow.tenantId ?? authSubject.tenantId ?? null,
    },
    ctx,
    last: undefined,
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
