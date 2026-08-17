import { isEmbeddingModel, type EmbeddingModel } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import type { Env } from "../env";

export interface VectorizeMeta {
  slug: string;
  vectorize: boolean;
  vectorizeModel: string | null;
  fields: FieldDef[];
}

/** Build the text we'll embed for an item by concatenating every field
 *  flagged `vectorize: true` on the collection's field defs. Non-string
 *  fields are coerced via `String(...)` — skipped if empty/null. Returns
 *  empty string when nothing is fit to embed (caller skips). */
const buildText = (
  row: Record<string, unknown>,
  fields: FieldDef[],
): string => {
  const parts: string[] = [];
  for (const f of fields) {
    if (!f.vectorize) continue;
    if (f.type !== "text" && f.type !== "longtext") continue;
    const v = row[f.name];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s) continue;
    parts.push(`${f.name}: ${s}`);
  }
  return parts.join("\n");
};

/**
 * How much text goes into one vector.
 *
 * Every embedding model here has a hard input ceiling in TOKENS — 8192 for
 * bge-m3, 8191 for both OpenAI models — and until chunking landed nothing in
 * this file looked at length at all. A row with a long `longtext` was sent
 * whole, and the two providers failed it differently and silently: OpenAI
 * answers 400, which `embedAndUpsert` catches and logs, so the row ends up with
 * NO vector and is invisible to `mode: "vector"` forever; Workers AI truncates,
 * so only the opening of the document is searchable. Neither surfaced anywhere
 * a user looks.
 *
 * The budget is in characters because that is the only unit portable across
 * providers without a tokenizer. 2000 is deliberately conservative — roughly
 * 500 English tokens, and about 1000 for Turkish, whose tokens run shorter —
 * so a chunk cannot approach a ceiling even in the worst-case script.
 */
export const CHUNK_CHARS = 2000;
/** Carried from the end of one chunk into the next, so a sentence split across
 *  a boundary is still retrievable from both sides. */
export const CHUNK_OVERLAP = 200;
/**
 * Chunks per row. 32 × 2000 = 64 KB of indexed text; past that a row is
 * truncated and the drop is logged rather than silently dropped.
 *
 * It is also the **delete bound**, which is the load-bearing half. Chunk ids
 * are derived (`<itemId>#<n>`), the adapter contract deletes by explicit id
 * across all five stores, and no store here can delete by metadata filter — so
 * when a row's text SHRINKS from five chunks to two, the way the other three
 * stop matching queries is that every write also deletes the tail of this
 * fixed range. A cap makes that one bounded call instead of an unanswerable
 * question.
 */
export const MAX_CHUNKS = 32;

/**
 * Split text on the largest natural boundary that fits, falling back to a hard
 * cut. Paragraphs first, then lines, then sentences — a chunk that ends
 * mid-clause retrieves worse than one that ends where the author paused.
 *
 * Returns `[]` for blank input and never returns a chunk longer than
 * `CHUNK_CHARS`.
 */
export const chunkText = (text: string, max = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const out: string[] = [];
  let rest = trimmed;
  while (rest.length > max && out.length < MAX_CHUNKS) {
    const window = rest.slice(0, max);
    // Search the back half only: a boundary in the first few characters would
    // produce a chunk so short that the overlap alone would exceed it, and the
    // loop would stop making progress.
    const floor = Math.floor(max / 2);
    let cut = -1;
    for (const sep of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= floor) {
        cut = at + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    // `overlap` is clamped below the cut so `next` is always shorter than
    // `rest` — otherwise a pathological input loops forever.
    rest = rest.slice(Math.max(cut - Math.min(overlap, cut - 1), 1));
  }
  if (rest.trim() && out.length < MAX_CHUNKS) out.push(rest.trim());
  return out;
};

/** The vector id for chunk `i` of an item.
 *
 *  Chunk 0 of a SINGLE-chunk row keeps the bare item id, which is what every
 *  vector written before chunking is keyed by. That is deliberate: short rows
 *  — the overwhelming majority — keep their existing vectors valid, so this
 *  change does not require a re-index to stop working. Only rows long enough
 *  to actually need splitting change key. */
export const chunkId = (itemId: string, i: number, total: number): string =>
  total <= 1 ? itemId : `${itemId}#${i}`;

/**
 * The item a vector id belongs to. Exported because every reader of a match
 * has to do this — a chunk id reaching a `WHERE pk IN (…)` matches nothing.
 *
 * Only a trailing `#<digits>` is stripped, not everything after the first `#`.
 * A managed collection's ids are UUIDs so either rule would do, but an
 * **adopted** table's primary key is whatever the user's column holds, and
 * `"order#42"` is an ordinary thing for one to contain. Splitting at the first
 * `#` would rewrite that row's id on every read and write, quietly making it
 * unsearchable and leaking orphan vectors past every delete.
 *
 * The residual ambiguity is a pk that itself ends in `#<digits>` AND is short
 * enough to be a single chunk: its bare vector id reads as "chunk N of the
 * shorter id". The consequence is a miss at hydration, never another row —
 * hydration re-applies the tenant, permission, soft-delete and draft filters,
 * so an id that does not belong to the caller cannot come back either way.
 */
export const itemIdOf = (vectorId: string): string => vectorId.replace(/#\d+$/, "");

/**
 * Ids to delete so no chunk of `itemId` outlives the text it came from.
 *
 * `keep` is how many chunks were just written, and the arithmetic follows from
 * `chunkId`'s single-chunk special case rather than from `keep` alone:
 *
 * - `keep === 1` — the write went to the BARE id, so every suffixed id is
 *   stale, `#0` included. Getting this wrong is subtle in the worst way: a
 *   long row edited down to one chunk would keep `#0`, which still holds the
 *   OPENING of the old text and still matches queries.
 * - `keep > 1` — `#0 … #(keep-1)` were just written; the bare id is stale
 *   (the row may have been short before) and so is the tail above `keep`.
 * - `keep === 0` — nothing was written; everything goes.
 *
 * Deleting an id that was never written is a no-op in every store, which is
 * what lets this be stateless — no chunk count is tracked anywhere.
 */
export const staleChunkIds = (itemId: string, keep: number): string[] => {
  const ids: string[] = [];
  if (keep !== 1) ids.push(itemId);
  const from = keep <= 1 ? 0 : keep;
  for (let i = from; i < MAX_CHUNKS; i++) ids.push(`${itemId}#${i}`);
  return ids;
};

/**
 * Collapse a chunk-level match list to one id per item, best chunk first.
 *
 * Every reader of a vector match has to do this, and doing it WRONG is quiet:
 * matches arrive sorted by score, so keeping the first occurrence keeps each
 * row's best passage — but keeping ALL of them would let a long document
 * outrank a better short one purely by occupying more slots. Downstream that
 * matters twice over, because the collection search fuses these ranks with
 * full-text ranks via RRF, where each surviving entry adds its own
 * `1/(K + rank)` term. Fusing five chunks of one row would score it as five
 * separate hits.
 */
export const collapseChunkMatches = (
  matches: ReadonlyArray<{ id: string }>,
  limit: number,
): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of matches) {
    const id = itemIdOf(m.id);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
};

/** One passage that matched, as retrieval returns it. */
export interface Passage {
  /** The chunk's own text — what belongs in an LLM prompt. */
  text: string;
  /** The store's similarity score for this chunk, not for the row. */
  score: number;
  /** Which chunk of the row this is; `0` for a row short enough not to split. */
  index: number;
}

/**
 * Group matches into passages per item, best first, at most `perItem` each.
 *
 * This is the half of chunking that makes it USEFUL rather than merely
 * correct. `/…/search` hydrates and returns whole rows, so a caller building a
 * prompt gets the entire document back and has to re-chunk it client-side to
 * find the part that actually matched — which is the work this server just
 * did and then threw away.
 *
 * The text comes from the vector record's `content` metadata, which is the
 * chunk as embedded. A match with no readable `content` contributes a score
 * but no text rather than an empty passage, so a store whose metadata was
 * written by an older version degrades instead of lying.
 */
export const passagesByItem = (
  matches: ReadonlyArray<{ id: string; score: number; metadata?: Record<string, unknown> }>,
  perItem = 3,
): Map<string, Passage[]> => {
  const out = new Map<string, Passage[]>();
  for (const m of matches) {
    const itemId = itemIdOf(m.id);
    const list = out.get(itemId) ?? [];
    if (list.length >= perItem) continue;
    const text = m.metadata?.content;
    if (typeof text !== "string" || !text) continue;
    const raw = m.metadata?.chunkIndex;
    list.push({ text, score: m.score, index: typeof raw === "number" ? raw : 0 });
    out.set(itemId, list);
  }
  return out;
};

/** Resolve the embedding model: row-level → env default → null (skip). */
export const resolveModel = (
  meta: { vectorizeModel: string | null },
  env: Pick<Env, "EMBEDDING_DEFAULT_MODEL">,
): EmbeddingModel | null => {
  const candidate = meta.vectorizeModel ?? env.EMBEDDING_DEFAULT_MODEL ?? null;
  if (candidate && isEmbeddingModel(candidate)) return candidate;
  return null;
};

/** Whether this collection will actually produce vectors on writes. */
export const isVectorizable = (meta: VectorizeMeta, env: Pick<Env, "EMBEDDING_DEFAULT_MODEL">): boolean => {
  if (!meta.vectorize) return false;
  if (!resolveModel(meta, env)) return false;
  return meta.fields.some(
    (f) => f.vectorize && (f.type === "text" || f.type === "longtext"),
  );
};

/**
 * Tenant-scope the vector namespace. The store is one index per model shared
 * across every workspace in a single-worker multi-tenant deployment, keyed
 * `<namespace>:<id>` — so two tenants owning a same-slug collection would
 * otherwise collide / read each other's vectors. Prefixing with the tenant id
 * isolates them. (Cloud runs one index per tenant, so the prefix is a harmless
 * no-op there.) Existing self-host data embedded under the bare slug must be
 * re-indexed via `POST /api/collections/:slug/vectorize`.
 *
 * **Exported because every path that touches the store must derive the
 * namespace from this one function.** It used to be private, so the collection
 * search path in `services/items/search.ts` hand-wrote the bare slug and
 * queried a namespace nothing had ever been written to — `mode: "vector"`
 * returned nothing on every multi-workspace install and `mode: "hybrid"`
 * degraded to full-text with no error. `routes/vector.ts::scopeNs` builds the
 * same join on top of this (it adds its own auth check and a no-namespace
 * fallback the write path has no use for). Pinned by
 * `tests/vector-namespace-parity.test.ts`.
 */
export const vectorNamespace = (slug: string, tenantId: string | null): string =>
  tenantId ? `${tenantId}:${slug}` : slug;

const vectorMetadata = (
  meta: VectorizeMeta,
  tenantId: string | null,
  itemId: string,
  text: string,
  model: EmbeddingModel,
  chunk?: { index: number; total: number },
): Record<string, unknown> => ({
  itemId,
  collection: meta.slug,
  tenantId: tenantId ?? null,
  // The chunk's own text, not the row's. A retrieval caller that shows a
  // snippet wants the passage that matched, and an LLM prompt built from
  // whole rows is the thing chunking exists to stop.
  content: text,
  model,
  ...(chunk && chunk.total > 1 ? { chunkIndex: chunk.index, chunkTotal: chunk.total } : {}),
});

/** Chunk a row's text and build the records for it. Shared by the single and
 *  batch write paths so they cannot disagree about ids or metadata. */
const recordsFor = (
  meta: VectorizeMeta,
  tenantId: string | null,
  itemId: string,
  chunks: string[],
  values: number[][],
  model: EmbeddingModel,
  offset: number,
) =>
  chunks.map((text, i) => ({
    id: chunkId(itemId, i, chunks.length),
    values: values[offset + i]!,
    namespace: vectorNamespace(meta.slug, tenantId),
    metadata: vectorMetadata(meta, tenantId, itemId, text, model, {
      index: i,
      total: chunks.length,
    }),
  }));

/** Embed an item and upsert it into the vector store. Failures are logged
 *  but never throw — vectorization is a best-effort side effect of the
 *  write, never a reason to refuse the underlying item operation. */
export const embedAndUpsert = async (
  ctx: Ctx,
  meta: VectorizeMeta,
  tenantId: string | null,
  itemId: string,
  row: Record<string, unknown>,
): Promise<void> => {
  if (!meta.vectorize) return;
  const model = resolveModel(meta, ctx.env);
  if (!model) return;
  const text = buildText(row, meta.fields);
  if (!text) {
    // Nothing to embed — also delete any prior vector so stale text doesn't
    // linger after a user empties every vectorized field.
    await safeDelete(ctx, meta, tenantId, [itemId]);
    return;
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    await safeDelete(ctx, meta, tenantId, staleChunkIds(itemId, 0));
    return;
  }
  if (text.length > MAX_CHUNKS * CHUNK_CHARS) {
    console.warn(
      `[vectorize] ${meta.slug}/${itemId}: ${text.length} chars exceeds the ${MAX_CHUNKS}-chunk cap — indexed the first ${MAX_CHUNKS * CHUNK_CHARS}`,
    );
  }
  try {
    const { values } = await ctx.embedding.embed({ model, texts: chunks, intent: "index" });
    await ctx.vector.upsert(
      model,
      recordsFor(meta, tenantId, itemId, chunks, values, model, 0),
    );
    // Self-heal: a row whose text shrank from five chunks to two leaves three
    // behind that still match queries, and no store here can delete by
    // metadata filter. Deleting the tail of the fixed range on every write is
    // what makes that impossible without tracking a count.
    await safeDelete(ctx, meta, tenantId, staleChunkIds(itemId, chunks.length));
  } catch (e) {
    console.error(
      `[vectorize] embed/upsert failed for ${meta.slug}/${itemId}:`,
      e,
    );
  }
};

/** Embed a batch in one provider call, then upsert. Used by the bulk
 *  backfill route. Returns the number of records successfully written. */
export const embedAndUpsertBatch = async (
  ctx: Ctx,
  meta: VectorizeMeta,
  tenantId: string | null,
  rows: Array<{ id: string; row: Record<string, unknown> }>,
): Promise<number> => {
  if (!meta.vectorize) return 0;
  const model = resolveModel(meta, ctx.env);
  if (!model) return 0;
  const prepared = rows
    .map(({ id, row }) => ({ id, chunks: chunkText(buildText(row, meta.fields)) }))
    .filter((r) => r.chunks.length > 0);
  if (prepared.length === 0) return 0;
  // One provider call for the whole batch's chunks, then each row's records
  // are sliced back out by the offset it contributed at.
  const texts = prepared.flatMap((p) => p.chunks);
  const { values } = await ctx.embedding.embed({ model, texts, intent: "index" });
  const records: Array<ReturnType<typeof recordsFor>[number]> = [];
  let offset = 0;
  for (const p of prepared) {
    records.push(...recordsFor(meta, tenantId, p.id, p.chunks, values, model, offset));
    offset += p.chunks.length;
  }
  await ctx.vector.upsert(model, records);
  // Backfill re-indexes rows that may already have vectors under a different
  // chunk count, so the same self-heal the single-write path does applies here
  // — otherwise re-running a backfill after shortening a document leaves the
  // old passages searchable.
  for (const p of prepared) {
    await safeDelete(ctx, meta, tenantId, staleChunkIds(p.id, p.chunks.length));
  }
  // The unit is ROWS, not records: the caller reports "n items vectorized",
  // and a long row is still one item.
  return prepared.length;
};

const safeDelete = async (
  ctx: Ctx,
  meta: VectorizeMeta,
  tenantId: string | null,
  ids: string[],
): Promise<void> => {
  const model = resolveModel(meta, ctx.env);
  if (!model) return;
  try {
    await ctx.vector.delete(model, ids, vectorNamespace(meta.slug, tenantId));
  } catch (e) {
    console.error(
      `[vectorize] delete failed for ${meta.slug}/${ids.join(",")}:`,
      e,
    );
  }
};

export const deleteVector = async (
  ctx: Ctx,
  meta: VectorizeMeta,
  tenantId: string | null,
  itemId: string,
): Promise<void> => {
  if (!meta.vectorize) return;
  // The bare id AND every chunk id. Deleting only the bare id was correct
  // while one row meant one vector; it would now leave every chunk of a long
  // document behind.
  await safeDelete(ctx, meta, tenantId, staleChunkIds(itemId, 0));
};

/** Batch delete — one adapter call per id set (bulk ops like the template
 *  clear-samples path). Best-effort like every other write hook here. */
export const deleteVectors = async (
  ctx: Ctx,
  meta: VectorizeMeta,
  tenantId: string | null,
  itemIds: string[],
): Promise<void> => {
  if (!meta.vectorize || itemIds.length === 0) return;
  await safeDelete(ctx, meta, tenantId, itemIds.flatMap((id) => staleChunkIds(id, 0)));
};
