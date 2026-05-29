import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { matchesCondition } from "@backlex/db";
import type { AuthSubject, Condition, Operation } from "@backlex/core";
import type { Ctx } from "../context";
import { runFunction } from "./sandbox";
import { sendTemplatedEmail } from "./email";
import { createItem, updateItem } from "./items-helpers";
import { enqueueTask, type ResumePayload } from "./scheduled-tasks";
import { recordActivity } from "./activity";

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
      const res = await fetch(url, init);
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
    const tenantId =
      ctx.authSubject.tenantId ??
      ((ctx.data as { tenantId?: string | null } | undefined)?.tenantId ?? null);
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
    });
    return result;
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
    try {
      await (ctx.ctx.db as any).insert(t).values({
        id: crypto.randomUUID(),
        userId: userId || null,
        title,
        body,
        url,
        flowId: null,
        readAt: null,
        createdAt: dialect === "pg" ? new Date() : Date.now(),
      });
      return { sent: true, title };
    } catch (e) {
      throw new FlowOpError(
        `notification insert failed: ${(e as Error).message}`,
      );
    }
  }

  if (op.type === "function") {
    const name = interpolate(op.name, ctx) as string;
    const dialect = ctx.ctx.dialect;
    const t =
      dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;
    // Tenant-scoped lookup. Flows execute under the runtime's authSubject;
    // when no tenant is bound (event triggers without auth), we fall back
    // to the row's own tenantId if the payload carries one — matching the
    // email template lookup behavior.
    const tenantId =
      ctx.authSubject.tenantId ??
      ((ctx.data as { tenantId?: string | null } | undefined)?.tenantId ?? null);
    const where =
      tenantId == null
        ? eq(t.name, name)
        : and(eq(t.name, name), eq(t.tenantId, tenantId));
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
    // Tenant resolution: prefer the running auth subject, fall back to the
    // event row's tenantId. Items are tenant-scoped at the DB layer, so an
    // unresolvable tenant is a hard error rather than a silent skip.
    const tenantId =
      ctx.authSubject.tenantId ??
      ((ctx.data as { tenantId?: string | null } | undefined)?.tenantId ?? null);
    if (!tenantId) {
      throw new FlowOpError(
        `${op.type} requires a tenant — none on auth subject or event payload`,
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
 *  same delay-aware runner so chained delays still checkpoint cleanly. */
export const resumeContinuation = async (
  ctx: Ctx,
  payload: ResumePayload,
): Promise<void> => {
  const runCtx: RunCtx = {
    data: payload.data,
    authSubject: payload.authSubject,
    ctx,
    last: payload.last,
  };
  await runFlowOps(
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
  channel: string,
  payload: { event: string; data: Record<string, unknown> },
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.active, true))) as FlowRow[];
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
      authSubject: { userId: null, email: null, roles: [] },
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
    authSubject,
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
