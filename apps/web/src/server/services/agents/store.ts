/**
 * Persistence helpers for the agent framework: agent definitions, threads, and
 * messages. Dual-dialect (pg | sqlite) like the rest of the service layer —
 * casts to `any` follow the same `noUncheckedIndexedAccess` + union-type
 * reasoning documented in CLAUDE.md.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../../context";

export interface AgentRow {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  model: string | null;
  tools: string[];
  maxSteps: number;
  memory: boolean;
  active: boolean;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export interface ThreadRow {
  id: string;
  tenantId: string | null;
  agentId: string;
  title: string | null;
  status: string;
  createdBy: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface MessageRow {
  id: string;
  tenantId: string | null;
  threadId: string;
  role: MessageRole;
  content: string;
  toolName: string | null;
  toolArgs: unknown;
  toolResult: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: Date | number;
}

const agentsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agents : sqlite.schema.agents;
const threadsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agentThreads : sqlite.schema.agentThreads;
const messagesTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agentMessages : sqlite.schema.agentMessages;

const nowFor = (d: "pg" | "sqlite"): Date | number =>
  d === "pg" ? new Date() : Date.now();

// ── agents ────────────────────────────────────────────────────────────────

export const listAgents = async (
  ctx: Ctx,
  tenantId: string,
): Promise<AgentRow[]> => {
  const t = agentsTable(ctx.dialect);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(desc(t.createdAt))) as AgentRow[];
};

export const getAgent = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
): Promise<AgentRow | null> => {
  const t = agentsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as AgentRow[];
  return rows[0] ?? null;
};

export interface AgentInput {
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  tools?: string[];
  maxSteps?: number;
  memory?: boolean;
  active?: boolean;
}

export const createAgent = async (
  ctx: Ctx,
  tenantId: string,
  input: AgentInput,
): Promise<AgentRow> => {
  const t = agentsTable(ctx.dialect);
  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  const row = {
    id,
    tenantId,
    name: input.name,
    description: input.description ?? null,
    systemPrompt: input.systemPrompt ?? null,
    model: input.model ?? null,
    tools: input.tools ?? [],
    maxSteps: input.maxSteps ?? 8,
    memory: input.memory ?? false,
    active: input.active ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  return row as AgentRow;
};

export const updateAgent = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
  input: Partial<AgentInput>,
): Promise<void> => {
  const t = agentsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.memory !== undefined ? { memory: input.memory } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: nowFor(ctx.dialect),
    })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

export const deleteAgent = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
): Promise<void> => {
  const t = agentsTable(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

// ── threads ───────────────────────────────────────────────────────────────

export const listThreads = async (
  ctx: Ctx,
  tenantId: string,
  agentId?: string,
): Promise<ThreadRow[]> => {
  const t = threadsTable(ctx.dialect);
  const where = agentId
    ? and(eq(t.tenantId, tenantId), eq(t.agentId, agentId))
    : eq(t.tenantId, tenantId);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.updatedAt))) as ThreadRow[];
};

export const getThread = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
): Promise<ThreadRow | null> => {
  const t = threadsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as ThreadRow[];
  return rows[0] ?? null;
};

export const createThread = async (
  ctx: Ctx,
  tenantId: string,
  agentId: string,
  opts: { title?: string | null; createdBy?: string | null } = {},
): Promise<ThreadRow> => {
  const t = threadsTable(ctx.dialect);
  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  const row = {
    id,
    tenantId,
    agentId,
    title: opts.title ?? null,
    status: "idle",
    createdBy: opts.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  return row as ThreadRow;
};

export const setThreadStatus = async (
  ctx: Ctx,
  id: string,
  status: "idle" | "running" | "error",
): Promise<void> => {
  const t = threadsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({ status, updatedAt: nowFor(ctx.dialect) })
    .where(eq(t.id, id));
};

export const deleteThread = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
): Promise<void> => {
  const tt = threadsTable(ctx.dialect);
  const mt = messagesTable(ctx.dialect);
  await (ctx.db as any).delete(mt).where(eq(mt.threadId, id));
  await (ctx.db as any)
    .delete(tt)
    .where(and(eq(tt.id, id), eq(tt.tenantId, tenantId)));
};

// ── messages ──────────────────────────────────────────────────────────────

export const listMessages = async (
  ctx: Ctx,
  threadId: string,
): Promise<MessageRow[]> => {
  const t = messagesTable(ctx.dialect);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.threadId, threadId))
    .orderBy(asc(t.createdAt))) as MessageRow[];
};

export interface AppendMessageInput {
  threadId: string;
  tenantId: string | null;
  role: MessageRole;
  content?: string;
  toolName?: string | null;
  toolArgs?: unknown;
  toolResult?: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export const appendMessage = async (
  ctx: Ctx,
  input: AppendMessageInput,
): Promise<MessageRow> => {
  const t = messagesTable(ctx.dialect);
  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  const row = {
    id,
    tenantId: input.tenantId,
    threadId: input.threadId,
    role: input.role,
    content: input.content ?? "",
    toolName: input.toolName ?? null,
    toolArgs: input.toolArgs ?? null,
    toolResult: input.toolResult ?? null,
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    createdAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  // Bump the thread's updatedAt so thread lists sort by recent activity.
  const tt = threadsTable(ctx.dialect);
  await (ctx.db as any)
    .update(tt)
    .set({ updatedAt: now })
    .where(eq(tt.id, input.threadId));
  return row as MessageRow;
};
