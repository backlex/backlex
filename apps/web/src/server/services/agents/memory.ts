/**
 * Agent memory, split into the two kinds that behave differently.
 *
 * **Episodic** — the raw turns. Every user message and final answer is embedded
 * under a per-(thread, agent) namespace and retrieved by similarity *blended
 * with recency*, because in a conversation "what we just said" is usually more
 * relevant than an equally-similar exchange from three weeks ago. High volume,
 * cheap, disposable: it stays vector-only and always stays inside its thread.
 *
 * **Semantic** — durable facts distilled out of the episodes by a short LLM
 * pass ("the production DB is Postgres on Neon", "Ayşe owns the billing
 * collection"). Few, long-lived, and the part an operator will want to read and
 * correct — so these get real rows in `agent_memories`, which also buys listing
 * and forgetting that the vector adapter contract can't provide.
 *
 * Both halves are entirely best-effort: every function no-ops (and never
 * throws) when no embedding provider / default model is configured, exactly
 * like `vectorize.ts`. A workspace with no embeddings still gets an agent — it
 * just doesn't get recall.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { isEmbeddingModel, type EmbeddingModel } from "@backlex/core";
import type { Ctx } from "../../context";
import { callClaude } from "../../mcp/ai-client";
import { aiMeterForTenant, assertAiQuota } from "../usage";

const memoriesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.agentMemories : sqlite.schema.agentMemories;
const messagesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.agentMessages : sqlite.schema.agentMessages;

const nowFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? new Date() : Date.now();

export type MemoryScope = "thread" | "agent";

export const parseMemoryScope = (v: unknown): MemoryScope =>
  v === "agent" ? "agent" : "thread";

/** Episodic memory is scoped per (thread, agent), not per thread: a room hosts
 *  several agents and one must not retrieve another's recollection of the
 *  conversation — that would leak one persona's private notes into another's
 *  prompt.
 *
 *  Threads that predate the episodic/semantic split stored under the bare
 *  `agentmem:<threadId>:<agentId>`; those records simply stop being retrieved
 *  (memory is opt-in and best-effort, so this is a cold start, not data loss). */
const episodicNamespace = (threadId: string, agentId: string) =>
  `agentep:${threadId}:${agentId}`;

/** Semantic namespace. Thread-scoped agents keep one pool per conversation;
 *  agent-scoped ones share a single pool across every thread. The scope is part
 *  of the namespace so flipping the setting can never make the *other* pool
 *  visible — see the `agents.memory_scope` schema comment. */
const semanticNamespace = (
  agentId: string,
  scope: MemoryScope,
  threadId: string,
) => (scope === "agent" ? `agentsem:${agentId}` : `agentsem:${agentId}:${threadId}`);

/** The embedding model to use for memory: the workspace's configured default.
 *  Memory has no per-field model the way collections do, so we lean on
 *  `EMBEDDING_DEFAULT_MODEL`. Returns null (→ memory disabled) when unset or
 *  not a known model. */
export const resolveMemoryModel = (ctx: Ctx): EmbeddingModel | null => {
  const candidate = ctx.env.EMBEDDING_DEFAULT_MODEL ?? null;
  if (candidate && isEmbeddingModel(candidate)) return candidate;
  return null;
};

// ── Episodic ────────────────────────────────────────────────────────────────

/** Store one message as an episodic record. No-op when memory can't run. */
export const storeEpisodic = async (
  ctx: Ctx,
  threadId: string,
  agentId: string,
  messageId: string,
  text: string,
): Promise<void> => {
  const model = resolveMemoryModel(ctx);
  if (!model || !text.trim()) return;
  try {
    const { values } = await ctx.embedding.embed({
      model,
      texts: [text],
      intent: "index",
    });
    await ctx.vector.upsert(model, [
      {
        id: messageId,
        values: values[0]!,
        namespace: episodicNamespace(threadId, agentId),
        // `at` drives the recency half of retrieval scoring. Stored on the
        // record because the vector store is the only thing we query here —
        // going back to `agent_messages` for timestamps would cost a second
        // round-trip per candidate.
        metadata: { threadId, agentId, messageId, content: text, at: Date.now() },
      },
    ]);
  } catch (e) {
    console.error(`[agent-memory] episodic store failed for ${threadId}:`, e);
  }
};

/** Half-life of the recency term, in days. Two weeks: long enough that a
 *  month-old exchange can still surface on a strong similarity match, short
 *  enough that yesterday's context wins a tie. */
const RECENCY_HALFLIFE_DAYS = 14;
/** How much of the blended score recency accounts for. Similarity stays the
 *  dominant term — recency breaks ties, it doesn't override relevance. */
const RECENCY_WEIGHT = 0.3;
/** Over-fetch factor before re-ranking, so the recency term can actually
 *  reorder the result rather than just shuffling an already-truncated list. */
const EPISODIC_OVERFETCH = 3;

export const recencyScore = (
  at: number | undefined,
  now: number,
): number => {
  if (!at || !Number.isFinite(at)) return 0;
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return 0.5 ** (ageDays / RECENCY_HALFLIFE_DAYS);
};

/** Retrieve up to `topK` past snippets, ranked by similarity blended with
 *  recency. Returns their stored content strings (best first); empty array on
 *  any miss so the caller can `if (snippets.length)` unconditionally. */
export const retrieveEpisodic = async (
  ctx: Ctx,
  threadId: string,
  agentId: string,
  queryText: string,
  topK = 4,
): Promise<string[]> => {
  const model = resolveMemoryModel(ctx);
  if (!model || !queryText.trim()) return [];
  try {
    const { values } = await ctx.embedding.embed({
      model,
      texts: [queryText],
      intent: "query",
    });
    const matches = await ctx.vector.query(model, {
      values: values[0]!,
      topK: topK * EPISODIC_OVERFETCH,
      namespace: episodicNamespace(threadId, agentId),
    });
    const now = Date.now();
    return matches
      .map((m) => {
        const meta = (m.metadata ?? {}) as { content?: unknown; at?: unknown };
        const content = typeof meta.content === "string" ? meta.content : "";
        const at = typeof meta.at === "number" ? meta.at : undefined;
        const blended =
          m.score * (1 - RECENCY_WEIGHT) + recencyScore(at, now) * RECENCY_WEIGHT;
        return { content, blended };
      })
      .filter((r) => r.content.length > 0)
      .sort((a, b) => b.blended - a.blended)
      .slice(0, topK)
      .map((r) => r.content);
  } catch (e) {
    console.error(`[agent-memory] episodic retrieve failed for ${threadId}:`, e);
    return [];
  }
};

/** Delete every episodic record for a thread (called when a thread is deleted).
 *  We don't track the id set beyond the message ids the caller passes, so this
 *  is a best-effort no-op for stores that require explicit ids — the records
 *  are namespace-scoped and harmless. */
export const dropThreadMemory = async (
  ctx: Ctx,
  threadId: string,
  agentId: string,
  messageIds: string[],
): Promise<void> => {
  const model = resolveMemoryModel(ctx);
  const t = memoriesTable(ctx.dialect);
  // Semantic rows are real rows, so they're always removable — even with no
  // embedding provider configured.
  try {
    await (ctx.db as any).delete(t).where(eq(t.threadId, threadId));
  } catch (e) {
    console.error(`[agent-memory] semantic drop failed for ${threadId}:`, e);
  }
  if (!model || messageIds.length === 0) return;
  try {
    await ctx.vector.delete(
      model,
      messageIds,
      episodicNamespace(threadId, agentId),
    );
  } catch {
    /* best-effort */
  }
};

// ── Semantic ────────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  tenantId: string | null;
  agentId: string;
  threadId: string | null;
  scope: string;
  content: string;
  embedded: boolean;
  hits: number;
  createdAt: Date | number;
  updatedAt: Date | number;
}

/** Cosine score at or above which a candidate fact is considered a restatement
 *  of one we already hold. Deliberately high — merging two facts that merely
 *  share a topic ("the DB is Postgres" / "the DB is at 90% disk") would lose
 *  the newer one silently, which is worse than carrying a near-duplicate. */
const DEDUPE_THRESHOLD = 0.93;

/** Facts kept per pool. Past this the oldest, least-retrieved rows are dropped
 *  — an unbounded fact list would eventually cost more prompt budget than the
 *  transcript it was meant to compress. */
const MAX_FACTS_PER_POOL = 60;

/** How many new messages must accumulate before a distillation pass runs.
 *  Every turn would burn an LLM call for almost no new information. */
export const DISTILL_EVERY_MESSAGES = 6;
/** Upper bound on how much transcript one pass reads. */
const DISTILL_WINDOW = 24;

const listPoolRows = async (
  ctx: Ctx,
  agentId: string,
  scope: MemoryScope,
  threadId: string,
): Promise<MemoryRow[]> => {
  const t = memoriesTable(ctx.dialect);
  const where =
    scope === "agent"
      ? and(eq(t.agentId, agentId), eq(t.scope, "agent"))
      : and(
          eq(t.agentId, agentId),
          eq(t.scope, "thread"),
          eq(t.threadId, threadId),
        );
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.createdAt))) as MemoryRow[];
};

/**
 * Retrieve the semantic facts most relevant to `queryText`.
 *
 * With an embedding provider this is a similarity query over the pool. Without
 * one it degrades to "the most recently learned facts" rather than returning
 * nothing — a distillation pass can still have run (facts are LLM-extracted,
 * not embedding-extracted), and recent facts beat no facts.
 */
export const retrieveSemantic = async (
  ctx: Ctx,
  agentId: string,
  scope: MemoryScope,
  threadId: string,
  queryText: string,
  topK = 5,
): Promise<string[]> => {
  try {
    const model = resolveMemoryModel(ctx);
    if (!model || !queryText.trim()) {
      const rows = await listPoolRows(ctx, agentId, scope, threadId);
      return rows.slice(0, topK).map((r) => r.content);
    }
    const { values } = await ctx.embedding.embed({
      model,
      texts: [queryText],
      intent: "query",
    });
    const matches = await ctx.vector.query(model, {
      values: values[0]!,
      topK,
      namespace: semanticNamespace(agentId, scope, threadId),
    });
    const hit = matches
      .map((m) => {
        const content = (m.metadata as { content?: unknown } | undefined)?.content;
        return { id: m.id, content: typeof content === "string" ? content : "" };
      })
      .filter((r) => r.content.length > 0);
    if (hit.length === 0) {
      const rows = await listPoolRows(ctx, agentId, scope, threadId);
      return rows.slice(0, topK).map((r) => r.content);
    }
    // Usage counter — best-effort, and deliberately not awaited into the
    // critical path's error handling: a failed counter must not cost recall.
    void bumpHits(ctx, hit.map((h) => h.id)).catch(() => {});
    return hit.map((r) => r.content);
  } catch (e) {
    console.error(`[agent-memory] semantic retrieve failed for ${agentId}:`, e);
    return [];
  }
};

const bumpHits = async (ctx: Ctx, ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  const t = memoriesTable(ctx.dialect);
  for (const id of ids) {
    await (ctx.db as any)
      .update(t)
      .set({ hits: sql`${t.hits} + 1`, updatedAt: nowFor(ctx.dialect) })
      .where(eq(t.id, id));
  }
};

/** Persist one fact (deduped against the pool) and index it for retrieval.
 *  Returns the created row, or null when it was a restatement of one we hold. */
export const rememberFact = async (
  ctx: Ctx,
  input: {
    tenantId: string | null;
    agentId: string;
    threadId: string;
    scope: MemoryScope;
    content: string;
  },
): Promise<MemoryRow | null> => {
  const content = input.content.trim();
  if (!content) return null;
  const t = memoriesTable(ctx.dialect);
  const model = resolveMemoryModel(ctx);
  const namespace = semanticNamespace(input.agentId, input.scope, input.threadId);

  let values: number[] | null = null;
  if (model) {
    try {
      const embedded = await ctx.embedding.embed({
        model,
        texts: [content],
        intent: "index",
      });
      values = embedded.values[0] ?? null;
      if (values) {
        const near = await ctx.vector.query(model, {
          values,
          topK: 1,
          namespace,
        });
        if ((near[0]?.score ?? 0) >= DEDUPE_THRESHOLD) return null;
      }
    } catch {
      // Embedding unavailable — fall through and store the fact unindexed
      // rather than losing it. `embedded: false` records that honestly.
      values = null;
    }
  }
  // Without embeddings, dedupe on normalized text. Weaker than cosine, but it
  // still stops the common case: the same pass re-extracting the same sentence.
  if (!values) {
    const existing = await listPoolRows(
      ctx,
      input.agentId,
      input.scope,
      input.threadId,
    );
    const norm = content.toLowerCase().replace(/\s+/g, " ");
    if (existing.some((r) => r.content.toLowerCase().replace(/\s+/g, " ") === norm))
      return null;
  }

  const now = nowFor(ctx.dialect);
  const row = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    agentId: input.agentId,
    threadId: input.threadId,
    scope: input.scope,
    content,
    embedded: Boolean(values),
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  if (values && model) {
    try {
      await ctx.vector.upsert(model, [
        {
          id: row.id,
          values,
          namespace,
          metadata: {
            agentId: input.agentId,
            threadId: input.threadId,
            content,
          },
        },
      ]);
    } catch {
      /* the row still exists and is listable; it just isn't searchable */
    }
  }
  return row as MemoryRow;
};

/** Drop one fact by id, from both the table and the vector store. Returns false
 *  when the id doesn't belong to this agent (or doesn't exist). */
export const forgetFact = async (
  ctx: Ctx,
  agentId: string,
  memoryId: string,
): Promise<boolean> => {
  const t = memoriesTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, memoryId), eq(t.agentId, agentId)))
    .limit(1)) as MemoryRow[];
  const row = rows[0];
  if (!row) return false;
  await (ctx.db as any).delete(t).where(eq(t.id, memoryId));
  const model = resolveMemoryModel(ctx);
  if (model && row.embedded) {
    try {
      await ctx.vector.delete(
        model,
        [memoryId],
        semanticNamespace(
          agentId,
          parseMemoryScope(row.scope),
          row.threadId ?? "",
        ),
      );
    } catch {
      /* best-effort — the row is gone, so it can no longer be retrieved by id */
    }
  }
  return true;
};

/** List an agent's facts, newest first. `threadId` narrows to one conversation's
 *  pool; omit it to see everything the agent holds. */
export const listFacts = async (
  ctx: Ctx,
  agentId: string,
  opts: { threadId?: string | null; limit?: number } = {},
): Promise<MemoryRow[]> => {
  const t = memoriesTable(ctx.dialect);
  const where = opts.threadId
    ? and(eq(t.agentId, agentId), eq(t.threadId, opts.threadId))
    : eq(t.agentId, agentId);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.createdAt))
    .limit(Math.min(200, Math.max(1, opts.limit ?? 100)))) as MemoryRow[];
};

const DISTILL_SYSTEM = [
  "You extract durable facts from a conversation transcript so an assistant can",
  "remember them in later sessions.",
  "",
  "Return ONLY a JSON array of short strings. No prose, no markdown fence.",
  "",
  "A fact qualifies when it is still true after this conversation ends:",
  "stable preferences, decisions that were made, names and roles of people or",
  "systems, constraints, and configuration. Write each as one self-contained",
  "sentence that makes sense with no other context.",
  "",
  "Do NOT extract: pleasantries, restatements of the assistant's own answers,",
  "anything that was only true during this exchange, or speculation. Prefer",
  "returning an empty array over inventing something.",
].join("\n");

/** Parse the model's reply into a fact list. Tolerant by design: a stray fence
 *  or a trailing sentence shouldn't cost the whole pass. */
export const parseFacts = (text: string): string[] => {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && f.length <= 300)
      .slice(0, 12);
  } catch {
    return [];
  }
};

/** Newest fact timestamp for a thread — the distillation cursor. Messages after
 *  it are what the next pass reads. */
const lastDistilledAt = async (
  ctx: Ctx,
  threadId: string,
): Promise<Date | number | null> => {
  const t = memoriesTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ createdAt: t.createdAt })
    .from(t)
    .where(eq(t.threadId, threadId))
    .orderBy(desc(t.createdAt))
    .limit(1)) as { createdAt: Date | number }[];
  return rows[0]?.createdAt ?? null;
};

/** How many user/assistant turns have landed since the last distillation pass.
 *  Cheap indexed count — the runner calls it after every turn to decide whether
 *  enqueueing a pass is worth it at all. */
export const pendingTurnCount = async (
  ctx: Ctx,
  threadId: string,
): Promise<number> => {
  const mt = messagesTable(ctx.dialect);
  const cursor = await lastDistilledAt(ctx, threadId);
  const conds = [eq(mt.threadId, threadId)];
  if (cursor != null) conds.push(gt(mt.createdAt, cursor as never));
  const rows = (await (ctx.db as any)
    .select({ n: sql<number>`count(*)` })
    .from(mt)
    .where(and(...conds))) as { n: number | string }[];
  return Number(rows[0]?.n ?? 0);
};

/**
 * Queue a distillation pass for this thread — but only once enough transcript
 * has accumulated to make the LLM call worth it. Enqueueing unconditionally
 * would put one no-op job on the queue per turn, which costs more in queue
 * churn than the pass it defers.
 *
 * Best-effort throughout: memory is a nice-to-have and must never fail a turn.
 */
export const scheduleDistillation = async (
  ctx: Ctx,
  input: {
    tenantId: string | null;
    agentId: string;
    threadId: string;
    scope: MemoryScope;
    model?: string | null;
  },
): Promise<boolean> => {
  try {
    if ((await pendingTurnCount(ctx, input.threadId)) < DISTILL_EVERY_MESSAGES)
      return false;
    const { enqueueJob } = await import("../jobs");
    await enqueueJob(ctx, {
      tenantId: input.tenantId,
      type: "agent.distill_memory",
      payload: {
        agentId: input.agentId,
        threadId: input.threadId,
        scope: input.scope,
        model: input.model ?? null,
      },
      // One attempt: a distillation that fails is re-attempted naturally on the
      // next turn, and retrying an LLM call on a schedule is a good way to burn
      // budget on a prompt that will fail the same way.
      maxAttempts: 1,
    });
    return true;
  } catch (e) {
    console.error(`[agent-memory] could not schedule distillation:`, e);
    return false;
  }
};

export interface DistillResult {
  /** Facts actually stored (post-dedupe). */
  learned: number;
  /** Why nothing was stored, when nothing was. */
  skipped?: "not-due" | "no-model" | "no-facts";
}

/**
 * Read the transcript written since the last pass and store whatever durable
 * facts it contains. Returns without calling the model when too few messages
 * have accumulated — the caller can invoke this after every turn.
 */
export const distillSemantic = async (
  ctx: Ctx,
  input: {
    tenantId: string | null;
    agentId: string;
    threadId: string;
    scope: MemoryScope;
    model?: string | null;
  },
): Promise<DistillResult> => {
  const mt = messagesTable(ctx.dialect);
  const cursor = await lastDistilledAt(ctx, input.threadId);
  const conds = [eq(mt.threadId, input.threadId)];
  if (cursor != null) conds.push(gt(mt.createdAt, cursor as never));
  const rows = (await (ctx.db as any)
    .select()
    .from(mt)
    .where(and(...conds))
    .orderBy(desc(mt.createdAt))
    .limit(DISTILL_WINDOW)) as {
    role: string;
    content: string;
    agentId: string | null;
  }[];

  // Tool rows are noise for fact extraction — they restate arguments the user
  // already said, in a shape the model would happily "remember" verbatim.
  const turns = rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .filter((r) => r.content.trim().length > 0)
    .reverse();
  if (turns.length < DISTILL_EVERY_MESSAGES) return { learned: 0, skipped: "not-due" };

  const transcript = turns
    .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
    .join("\n")
    .slice(0, 12_000);

  let facts: string[];
  try {
    await assertAiQuota(ctx, ctx.env, input.tenantId);
    const reply = await callClaude(ctx.env, {
      system: DISTILL_SYSTEM,
      user: transcript,
      model: input.model ?? undefined,
      maxTokens: 700,
      // Extraction is a mechanical read, not a reasoning task — the cheapest
      // effort tier is the right one and keeps the pass nearly free.
      effort: "low",
    }, aiMeterForTenant(ctx, input.tenantId));
    facts = parseFacts(reply.text);
  } catch (e) {
    console.error(`[agent-memory] distill failed for ${input.threadId}:`, e);
    return { learned: 0, skipped: "no-model" };
  }
  if (facts.length === 0) return { learned: 0, skipped: "no-facts" };

  let learned = 0;
  for (const content of facts) {
    const row = await rememberFact(ctx, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      threadId: input.threadId,
      scope: input.scope,
      content,
    });
    if (row) learned++;
  }
  await prunePool(ctx, input.agentId, input.scope, input.threadId);
  return { learned };
};

/** Keep a pool under {@link MAX_FACTS_PER_POOL}, dropping never-retrieved rows
 *  before ones an agent has actually used. */
const prunePool = async (
  ctx: Ctx,
  agentId: string,
  scope: MemoryScope,
  threadId: string,
): Promise<void> => {
  try {
    const rows = await listPoolRows(ctx, agentId, scope, threadId);
    if (rows.length <= MAX_FACTS_PER_POOL) return;
    const doomed = [...rows]
      .sort((a, b) => a.hits - b.hits || Number(a.createdAt) - Number(b.createdAt))
      .slice(0, rows.length - MAX_FACTS_PER_POOL);
    for (const row of doomed) await forgetFact(ctx, agentId, row.id);
  } catch (e) {
    console.error(`[agent-memory] prune failed for ${agentId}:`, e);
  }
};