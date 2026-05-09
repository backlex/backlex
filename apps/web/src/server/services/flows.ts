import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { matchesCondition } from "@workeros/db";
import type { AuthSubject, Condition, Operation } from "@workeros/core";
import type { Ctx } from "../context";
import { runFunction } from "./sandbox";

export type { Operation };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

interface FlowRow {
  id: string;
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
    await ctx.ctx.email.send({
      to: interpolate(op.to, ctx) as string,
      subject: interpolate(op.subject, ctx) as string,
      text: interpolate(op.text, ctx) as string,
    });
    return { sent: true };
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

  return undefined;
};

const runOperation = async (op: Operation, ctx: RunCtx): Promise<unknown> => {
  let result: unknown;
  try {
    result = await executeOp(op, ctx);
  } catch (e) {
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
  flow: Pick<FlowRow, "name" | "operations">,
  runCtx: RunCtx,
): Promise<void> => {
  try {
    for (const op of flow.operations) {
      runCtx.last = await runOperation(op as Operation, runCtx);
    }
  } catch (e) {
    console.error(`[flow] ${flow.name} failed`, e);
  }
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
    await runFlowOps(flow, runCtx);
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
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.id, flowId))) as FlowRow[];
  const flow = rows[0];
  if (!flow) return;
  if (!flow.active) return;
  const runCtx: RunCtx = {
    data,
    authSubject,
    ctx,
    last: undefined,
  };
  await runFlowOps(flow, runCtx);
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
