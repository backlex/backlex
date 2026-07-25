/**
 * Per-thread semantic memory for agents. Stores each turn's user + final
 * messages as embeddings under a thread-scoped namespace, and retrieves the
 * most relevant past snippets on each new turn. This gives cross-turn recall
 * beyond the raw transcript — useful once a thread grows past what fits in a
 * single prompt.
 *
 * Entirely best-effort: every call no-ops (and never throws) when no embedding
 * provider / default model is configured, exactly like `vectorize.ts`. Reuses
 * the same `ctx.embedding` + `ctx.vector` adapters.
 */
import { isEmbeddingModel, type EmbeddingModel } from "@backlex/core";
import type { Ctx } from "../../context";

/** Memory is scoped per (thread, agent), not per thread: a room hosts several
 *  agents and one must not retrieve another's recollection of the conversation
 *  — that would leak one persona's private notes into another's prompt.
 *
 *  Threads that predate rooms stored under the bare `agentmem:<threadId>`; those
 *  records simply stop being retrieved (memory is opt-in and best-effort, so
 *  this is a cold start, not data loss). */
const namespaceFor = (threadId: string, agentId: string) =>
  `agentmem:${threadId}:${agentId}`;

/** The embedding model to use for memory: the workspace's configured default.
 *  Memory has no per-field model the way collections do, so we lean on
 *  `EMBEDDING_DEFAULT_MODEL`. Returns null (→ memory disabled) when unset or
 *  not a known model. */
export const resolveMemoryModel = (ctx: Ctx): EmbeddingModel | null => {
  const candidate = ctx.env.EMBEDDING_DEFAULT_MODEL ?? null;
  if (candidate && isEmbeddingModel(candidate)) return candidate;
  return null;
};

/** Store one message as a memory record. No-op when memory can't run. */
export const storeMemory = async (
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
        namespace: namespaceFor(threadId, agentId),
        metadata: { threadId, agentId, messageId, content: text },
      },
    ]);
  } catch (e) {
    console.error(`[agent-memory] store failed for thread ${threadId}:`, e);
  }
};

/** Retrieve up to `topK` past snippets most relevant to `queryText`. Returns
 *  their stored content strings (most relevant first); empty array on any
 *  miss so the caller can `if (snippets.length)` unconditionally. */
export const retrieveMemory = async (
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
      topK,
      namespace: namespaceFor(threadId, agentId),
    });
    return matches
      .map((m) => {
        const content = (m.metadata as { content?: unknown } | undefined)?.content;
        return typeof content === "string" ? content : "";
      })
      .filter((s) => s.length > 0);
  } catch (e) {
    console.error(`[agent-memory] retrieve failed for thread ${threadId}:`, e);
    return [];
  }
};

/** Delete every memory record for a thread (called when a thread is deleted).
 *  We don't track the id set, so this is a best-effort no-op for stores that
 *  require explicit ids — the records are namespace-scoped and harmless. */
export const dropThreadMemory = async (
  ctx: Ctx,
  threadId: string,
  agentId: string,
  messageIds: string[],
): Promise<void> => {
  const model = resolveMemoryModel(ctx);
  if (!model || messageIds.length === 0) return;
  try {
    await ctx.vector.delete(model, messageIds, namespaceFor(threadId, agentId));
  } catch {
    /* best-effort */
  }
};
