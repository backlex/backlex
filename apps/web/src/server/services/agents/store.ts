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
  /** Stable `@`-mention token, unique per workspace. */
  handle: string | null;
  description: string | null;
  systemPrompt: string | null;
  model: string | null;
  /** Reasoning effort (`low` | `medium` | `high`); null = provider default. */
  effort: string | null;
  tools: string[];
  maxSteps: number;
  memory: boolean;
  /** `thread` | `agent` — how far distilled semantic facts reach. See the
   *  schema comment on `agents.memory_scope`. */
  memoryScope: string;
  active: boolean;
  /** Reachable by the workspace's END USERS, not just operators. False by
   *  default — see the schema comment on `agents.app_access`. */
  appAccess: boolean;
  createdAt: Date | number;
  updatedAt: Date | number;
}

/** How a room decides who answers a message that mentions nobody. */
export type ThreadRouting = "mention" | "default" | "auto";
export const THREAD_ROUTINGS: ThreadRouting[] = ["mention", "default", "auto"];

export interface ThreadRow {
  id: string;
  tenantId: string | null;
  /** Legacy single-agent pin — null on a room. Membership lives in
   *  `agent_thread_agents`; a pinned thread is a one-participant room. */
  agentId: string | null;
  title: string | null;
  status: string;
  routing: ThreadRouting;
  defaultAgentId: string | null;
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
  /** Which agent wrote an assistant/tool row. Null on user rows — and on rows
   *  written before rooms existed that we couldn't attribute. */
  agentId: string | null;
  content: string;
  toolName: string | null;
  toolArgs: unknown;
  toolResult: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: Date | number;
}

export interface RunRow {
  id: string;
  tenantId: string | null;
  threadId: string;
  agentId: string;
  jobId: string | null;
  status: "queued" | "running" | "done" | "error";
  startedBy: string | null;
  triggerMessageId: string | null;
  error: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}

const agentsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agents : sqlite.schema.agents;
const threadsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agentThreads : sqlite.schema.agentThreads;
const messagesTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agentMessages : sqlite.schema.agentMessages;
const threadAgentsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agentThreadAgents : sqlite.schema.agentThreadAgents;
const runsTable = (d: "pg" | "sqlite") =>
  d === "pg" ? pg.schema.agentRuns : sqlite.schema.agentRuns;

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

/** Turn a display name into a mention handle: lowercased, whitespace as
 *  dashes. Unicode letters survive on purpose — a Turkish-named agent gets a
 *  Turkish handle, and mentions are resolved against the room's known handles
 *  rather than a strict charset. Mirrors the migration's backfill.
 *
 *  **Deliberately NOT `@backlex/db/slug`**, which the four other slugifiers in
 *  this repo were folded into. A mention handle is typed by a person after `@`
 *  in a chat box, not put in a URL, so the ASCII fold that makes a slug
 *  addressable would make this one unrecognisable to the people using it. The
 *  divergence is the point; a test pins both so it stays intentional rather
 *  than becoming drift. */
export const slugifyHandle = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, "-").replace(/^-+|-+$/g, "");

/** Pick a handle that's free in this workspace, suffixing on collision. Called
 *  on create (and on rename when the caller didn't pin one explicitly), so two
 *  agents can never share the token a room member types after `@`. */
export const uniqueHandle = async (
  ctx: Ctx,
  tenantId: string,
  desired: string,
  excludeAgentId?: string,
): Promise<string> => {
  const t = agentsTable(ctx.dialect);
  const base = slugifyHandle(desired) || "agent";
  const rows = (await (ctx.db as any)
    .select({ id: t.id, handle: t.handle })
    .from(t)
    .where(eq(t.tenantId, tenantId))) as { id: string; handle: string | null }[];
  const taken = new Set(
    rows.filter((r) => r.id !== excludeAgentId && r.handle).map((r) => r.handle as string),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
};

export interface AgentInput {
  name: string;
  handle?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  effort?: string | null;
  tools?: string[];
  maxSteps?: number;
  memory?: boolean;
  /** `thread` | `agent` — how far distilled semantic facts reach. */
  memoryScope?: string;
  active?: boolean;
  /** Open this agent to the workspace's END USERS. Off unless asked for — see
   *  the schema comment on `agents.app_access`. */
  appAccess?: boolean;
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
    handle: await uniqueHandle(ctx, tenantId, input.handle || input.name),
    description: input.description ?? null,
    systemPrompt: input.systemPrompt ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    tools: input.tools ?? [],
    maxSteps: input.maxSteps ?? 8,
    memory: input.memory ?? false,
    memoryScope: input.memoryScope === "agent" ? "agent" : "thread",
    active: input.active ?? true,
    appAccess: input.appAccess ?? false,
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
      // An explicit handle is normalised + de-duped; a bare rename leaves the
      // existing handle alone, since a room's transcript already mentions it.
      ...(input.handle
        ? { handle: await uniqueHandle(ctx, tenantId, input.handle, id) }
        : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.memory !== undefined ? { memory: input.memory } : {}),
      ...(input.memoryScope !== undefined
        ? { memoryScope: input.memoryScope === "agent" ? "agent" : "thread" }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.appAccess !== undefined ? { appAccess: input.appAccess } : {}),
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

/**
 * Open a conversation. Passing `agentId` pins it to one agent — the pre-rooms
 * shape, which also becomes its own single participant and answers every
 * message (`routing: "default"`). Passing null opens a room whose participants
 * are added separately and which, by default, only answers when mentioned.
 */
export const createThread = async (
  ctx: Ctx,
  tenantId: string,
  agentId: string | null,
  opts: {
    title?: string | null;
    createdBy?: string | null;
    routing?: ThreadRouting;
    defaultAgentId?: string | null;
    agentIds?: string[];
  } = {},
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
    routing: opts.routing ?? (agentId ? "default" : "mention"),
    defaultAgentId: opts.defaultAgentId ?? agentId ?? null,
    createdBy: opts.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  const members = [...new Set([...(agentId ? [agentId] : []), ...(opts.agentIds ?? [])])];
  for (const memberId of members) await addThreadAgent(ctx, tenantId, id, memberId);
  return row as ThreadRow;
};

export interface ThreadPatch {
  title?: string | null;
  routing?: ThreadRouting;
  defaultAgentId?: string | null;
}

export const updateThread = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
  patch: ThreadPatch,
): Promise<void> => {
  const t = threadsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.routing !== undefined ? { routing: patch.routing } : {}),
      ...(patch.defaultAgentId !== undefined
        ? { defaultAgentId: patch.defaultAgentId }
        : {}),
      updatedAt: nowFor(ctx.dialect),
    })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

// ── room membership ───────────────────────────────────────────────────────

/** Agent ids in a room, oldest first. */
export const listThreadAgentIds = async (
  ctx: Ctx,
  threadId: string,
): Promise<string[]> => {
  const t = threadAgentsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ agentId: t.agentId, createdAt: t.createdAt })
    .from(t)
    .where(eq(t.threadId, threadId))
    .orderBy(asc(t.createdAt))) as { agentId: string }[];
  return rows.map((r) => r.agentId);
};

/** Participants for several rooms at once — the room list renders a chip per
 *  agent, and an N+1 per room would make that list a query storm. */
export const listThreadAgentIdsFor = async (
  ctx: Ctx,
  threadIds: string[],
): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>();
  if (threadIds.length === 0) return out;
  const t = threadAgentsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ threadId: t.threadId, agentId: t.agentId, createdAt: t.createdAt })
    .from(t)
    .where(inArray(t.threadId, threadIds))
    .orderBy(asc(t.createdAt))) as { threadId: string; agentId: string }[];
  for (const r of rows) {
    const bucket = out.get(r.threadId) ?? [];
    bucket.push(r.agentId);
    out.set(r.threadId, bucket);
  }
  return out;
};

/** Idempotent — re-adding an agent already in the room is a no-op, so the
 *  route doesn't need a read-then-write race. */
export const addThreadAgent = async (
  ctx: Ctx,
  tenantId: string,
  threadId: string,
  agentId: string,
): Promise<void> => {
  const t = threadAgentsTable(ctx.dialect);
  await (ctx.db as any)
    .insert(t)
    .values({ tenantId, threadId, agentId, createdAt: nowFor(ctx.dialect) })
    .onConflictDoNothing();
};

export const removeThreadAgent = async (
  ctx: Ctx,
  threadId: string,
  agentId: string,
): Promise<void> => {
  const t = threadAgentsTable(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.threadId, threadId), eq(t.agentId, agentId)));
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

/**
 * Recompute `agent_threads.status` from the runs still holding a lock.
 *
 * The thread-level status is no longer the lock (that's `agent_runs`) — it's a
 * summary kept for the clients and surfaces that already read it. In a room two
 * agents can be mid-turn at once, so a finishing run must not flip the thread
 * to `idle` while its room-mate is still working.
 */
export const syncThreadStatus = async (
  ctx: Ctx,
  threadId: string,
): Promise<void> => {
  const active = await listActiveRuns(ctx, threadId);
  if (active.length > 0) {
    await setThreadStatus(ctx, threadId, "running");
    return;
  }
  // Quiet now — but a thread whose last turn blew up still reads `error`, the
  // way it did when the thread itself was the unit of work.
  const t = runsTable(ctx.dialect);
  const last = (await (ctx.db as any)
    .select({ status: t.status })
    .from(t)
    .where(eq(t.threadId, threadId))
    .orderBy(desc(t.createdAt))
    .limit(1)) as { status: string }[];
  await setThreadStatus(ctx, threadId, last[0]?.status === "error" ? "error" : "idle");
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
  const at = threadAgentsTable(ctx.dialect);
  const rt = runsTable(ctx.dialect);
  await (ctx.db as any).delete(mt).where(eq(mt.threadId, id));
  await (ctx.db as any).delete(at).where(eq(at.threadId, id));
  await (ctx.db as any).delete(rt).where(eq(rt.threadId, id));
  await (ctx.db as any)
    .delete(tt)
    .where(and(eq(tt.id, id), eq(tt.tenantId, tenantId)));
};

// ── runs (the per-agent lock) ─────────────────────────────────────────────

/** How long an unfinished run may sit before it's treated as a dead isolate
 *  rather than a live turn. A run heartbeats `updatedAt` on every persisted
 *  step, so this only trips on a turn whose process actually went away. */
export const STALE_RUN_MS = 120_000;

const msOf = (v: Date | number): number =>
  typeof v === "number" ? v : new Date(v).getTime();

export const getRun = async (
  ctx: Ctx,
  id: string,
  tenantId: string,
): Promise<RunRow | null> => {
  const t = runsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as RunRow[];
  return rows[0] ?? null;
};

/** Runs still holding a lock on this thread — what the UI renders as "agent X
 *  is working" and what makes a second turn for the same agent a conflict. */
export const listActiveRuns = async (
  ctx: Ctx,
  threadId: string,
): Promise<RunRow[]> => {
  const t = runsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.threadId, threadId), inArray(t.status, ["queued", "running"])))
    .orderBy(asc(t.createdAt))) as RunRow[];
  return rows;
};

/**
 * Take the lock for one agent in one thread, or report who's holding it.
 *
 * The `agent_runs_active_idx` partial unique index is the actual mutex: a
 * second insert for the same (thread, agent) while one is `queued`/`running`
 * violates it. Different agents don't collide, which is the whole point —
 * a room where two agents are mentioned answers with both, in parallel.
 *
 * A run whose isolate died leaves the lock held; `STALE_RUN_MS` past its last
 * heartbeat we fail it and take over, so a zombie can't wedge an agent forever.
 */
export const claimRun = async (
  ctx: Ctx,
  input: {
    tenantId: string;
    threadId: string;
    agentId: string;
    startedBy?: string | null;
    triggerMessageId?: string | null;
    jobId?: string | null;
  },
): Promise<{ ok: true; run: RunRow } | { ok: false; heldBy: RunRow }> => {
  const t = runsTable(ctx.dialect);
  const now = nowFor(ctx.dialect);

  const existing = (await (ctx.db as any)
    .select()
    .from(t)
    .where(
      and(
        eq(t.threadId, input.threadId),
        eq(t.agentId, input.agentId),
        inArray(t.status, ["queued", "running"]),
      ),
    )
    .limit(1)) as RunRow[];
  const held = existing[0];
  if (held) {
    if (Date.now() - msOf(held.updatedAt) < STALE_RUN_MS) {
      return { ok: false, heldBy: held };
    }
    await setRunStatus(ctx, held.id, "error", "the previous turn stopped responding");
  }

  const row: RunRow = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    threadId: input.threadId,
    agentId: input.agentId,
    jobId: input.jobId ?? null,
    status: "queued",
    startedBy: input.startedBy ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await (ctx.db as any).insert(t).values(row);
  } catch (e) {
    // Lost the race to a concurrent claim — the index did its job. Re-read so
    // the caller can name who's holding it instead of surfacing a raw DB error.
    const raced = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        and(
          eq(t.threadId, input.threadId),
          eq(t.agentId, input.agentId),
          inArray(t.status, ["queued", "running"]),
        ),
      )
      .limit(1)) as RunRow[];
    if (raced[0]) return { ok: false, heldBy: raced[0] };
    throw e;
  }
  return { ok: true, run: row };
};

export const setRunStatus = async (
  ctx: Ctx,
  id: string,
  status: RunRow["status"],
  error?: string | null,
): Promise<void> => {
  const t = runsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      status,
      ...(error !== undefined ? { error } : {}),
      updatedAt: nowFor(ctx.dialect),
    })
    .where(eq(t.id, id));
};

/** Heartbeat — keeps the stale-takeover window from tripping on a long turn. */
export const touchRun = async (ctx: Ctx, id: string): Promise<void> => {
  const t = runsTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({ updatedAt: nowFor(ctx.dialect) })
    .where(eq(t.id, id));
};

export const setRunJobId = async (
  ctx: Ctx,
  id: string,
  jobId: string,
): Promise<void> => {
  const t = runsTable(ctx.dialect);
  await (ctx.db as any).update(t).set({ jobId }).where(eq(t.id, id));
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
  /** Which agent wrote it — required for assistant/tool rows in a room, or the
   *  transcript can't render a byline. */
  agentId?: string | null;
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
    agentId: input.agentId ?? null,
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
