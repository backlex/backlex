import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AuthSubject } from "@workeros/core";
import {
  runFunction,
  type SandboxBindings,
  type SandboxResult,
} from "./sandbox";
import type { Ctx } from "../context";
import type { DbCtx } from "./seed";

export interface FunctionRow {
  id: string;
  name: string;
  trigger: "http" | "event";
  pattern: string | null;
  code: string;
  timeoutMs: number;
  active: boolean | number;
}

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;

const matchesPattern = (
  pattern: string | null,
  channel: string,
  event: string,
): boolean => {
  if (!pattern) return false;
  const target = `${channel}:${event}`;
  if (pattern === target || pattern === channel) return true;
  const parts = pattern.split(":");
  const targetParts = target.split(":");
  if (parts.length > targetParts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "*") continue;
    if (parts[i] !== targetParts[i]) return false;
  }
  return true;
};

export const findByName = async (
  ctx: DbCtx,
  name: string,
): Promise<FunctionRow | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.name, name))
    .limit(1)) as FunctionRow[];
  return rows[0] ?? null;
};

export const invokeFunction = async (
  fn: FunctionRow,
  bindings: SandboxBindings,
  data: unknown,
): Promise<SandboxResult> => {
  return runFunction(fn.code, bindings, data, fn.timeoutMs);
};

export const runEventFunctions = async (
  ctx: Ctx,
  channel: string,
  payload: { event: string; data: Record<string, unknown> },
  auth: AuthSubject,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.trigger, "event"))) as FunctionRow[];
  const matches = rows.filter(
    (f) => f.active && matchesPattern(f.pattern, channel, payload.event),
  );
  if (matches.length === 0) return;
  await Promise.all(
    matches.map(async (fn) => {
      try {
        const result = await runFunction(
          fn.code,
          { ctx, auth },
          payload,
          fn.timeoutMs,
        );
        if (!result.ok) {
          console.error(`[fn:${fn.name}] error: ${result.error}`);
        } else if (result.logs.length > 0) {
          console.log(`[fn:${fn.name}] logs:\n${result.logs.join("\n")}`);
        }
      } catch (e) {
        console.error(`[fn:${fn.name}] crashed`, e);
      }
    }),
  );
};
