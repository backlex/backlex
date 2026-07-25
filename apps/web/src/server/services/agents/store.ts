/**
 * Persistence helpers for the agent framework: agent definitions, threads, and
 * messages. Dual-dialect (pg | sqlite) like the rest of the service layer —
 * casts to `any` follow the same `noUncheckedIndexedAccess` + union-type
 * reasoning documented in CLAUDE.md.
 */
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
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
  /** Reasoning effort (`low` | `medium` | `high`); null = provider default. */
  effort: string | null;
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
  /** Who wrote a `user` message (null for assistant/tool rows, and for turns
   *  driven by an API key instead of a person). */
  userId: string | null;
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
  effort?: string | null;
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
    effort: input.effort ?? null,
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
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
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

/** A thread label a human can recognise: the first line of the opening prompt,
 *  whitespace-collapsed and clipped. Raw thread ids are unreadable in the
 *  history picker, so this is what the UI shows. */
export const threadTitleFrom = (message: string, max = 64): string => {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
};

export const listThreads = async (
  ctx: Ctx,
  tenantId: string,
  agentId?: string,
): Promise<ThreadRow[]> => {
  const t = threadsTable(ctx.dialect);
  const where = agentId
    ? and(eq(t.tenantId, tenantId), eq(t.agentId, agentId))
    : eq(t.tenantId, tenantId);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.updatedAt))) as ThreadRow[];

  // Threads created before titles were persisted (and any created with an
  // explicit null title) still need a readable label — derive it on read from
  // their opening user message rather than backfilling with a migration.
  const untitled = rows.filter((r) => !r.title);
  if (untitled.length === 0) return rows;
  const m = messagesTable(ctx.dialect);
  const firsts = (await (ctx.db as any)
    .select({ threadId: m.threadId, content: m.content, createdAt: m.createdAt })
    .from(m)
    .where(
      and(
        inArray(
          m.threadId,
          untitled.map((r) => r.id),
        ),
        eq(m.role, "user"),
      ),
    )
    .orderBy(asc(m.createdAt))) as {
    threadId: string;
    content: string;
  }[];
  const byThread = new Map<string, string>();
  for (const row of firsts) {
    if (!byThread.has(row.threadId) && row.content)
      byThread.set(row.threadId, threadTitleFrom(row.content));
  }
  return rows.map((r) =>
    r.title ? r : { ...r, title: byThread.get(r.id) ?? null },
  );
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

/** Name a thread after its OPENING prompt — the earliest user message, not the
 *  one that just arrived. Called after the new message is appended, so on a
 *  first turn those are the same row; on a thread that predates titles (or one
 *  a teammate picks up months later) it still names the conversation after how
 *  it started. No-op once the thread has a title, so an explicit one stands. */
export const ensureThreadTitle = async (ctx: Ctx, id: string): Promise<void> => {
  const t = threadsTable(ctx.dialect);
  const existing = (await (ctx.db as any)
    .select({ title: t.title })
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as { title: string | null }[];
  if (existing[0]?.title) return;

  const m = messagesTable(ctx.dialect);
  const first = (await (ctx.db as any)
    .select({ content: m.content })
    .from(m)
    .where(and(eq(m.threadId, id), eq(m.role, "user")))
    .orderBy(asc(m.createdAt))
    .limit(1)) as { content: string }[];
  const title = threadTitleFrom(first[0]?.content ?? "");
  if (!title) return;
  await (ctx.db as any)
    .update(t)
    .set({ title })
    .where(and(eq(t.id, id), or(isNull(t.title), eq(t.title, ""))));
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

// ── authors ───────────────────────────────────────────────────────────────

export interface ThreadAuthor {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

const usersTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.users : sqlite.schema.users;

/** Resolve the team members behind a transcript's `user_id`s in one query, so
 *  the admin can render "who asked" without an N+1 per message. */
export const listAuthors = async (
  ctx: Ctx,
  userIds: (string | null)[],
): Promise<ThreadAuthor[]> => {
  const ids = [...new Set(userIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return [];
  const u = usersTable(ctx.dialect);
  return (await (ctx.db as any)
    .select({ id: u.id, name: u.name, email: u.email, image: u.image })
    .from(u)
    .where(inArray(u.id, ids))) as ThreadAuthor[];
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
  userId?: string | null;
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
    userId: input.userId ?? null,
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
