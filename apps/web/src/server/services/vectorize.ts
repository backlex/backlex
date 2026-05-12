import { isEmbeddingModel, type EmbeddingModel } from "@workeros/core";
import type { FieldDef } from "@workeros/db";
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

const vectorMetadata = (
  meta: VectorizeMeta,
  tenantId: string | null,
  itemId: string,
  text: string,
  model: EmbeddingModel,
): Record<string, unknown> => ({
  itemId,
  collection: meta.slug,
  tenantId: tenantId ?? null,
  content: text,
  model,
});

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
    await safeDelete(ctx, meta, [itemId]);
    return;
  }
  try {
    const { values } = await ctx.embedding.embed({ model, texts: [text] });
    await ctx.vector.upsert(model, [
      {
        id: itemId,
        values: values[0]!,
        namespace: meta.slug,
        metadata: vectorMetadata(meta, tenantId, itemId, text, model),
      },
    ]);
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
    .map(({ id, row }) => ({ id, text: buildText(row, meta.fields) }))
    .filter((r) => r.text.length > 0);
  if (prepared.length === 0) return 0;
  const { values } = await ctx.embedding.embed({
    model,
    texts: prepared.map((p) => p.text),
  });
  const records = prepared.map((p, i) => ({
    id: p.id,
    values: values[i]!,
    namespace: meta.slug,
    metadata: vectorMetadata(meta, tenantId, p.id, p.text, model),
  }));
  await ctx.vector.upsert(model, records);
  return records.length;
};

const safeDelete = async (
  ctx: Ctx,
  meta: VectorizeMeta,
  ids: string[],
): Promise<void> => {
  const model = resolveModel(meta, ctx.env);
  if (!model) return;
  try {
    await ctx.vector.delete(model, ids, meta.slug);
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
  itemId: string,
): Promise<void> => {
  if (!meta.vectorize) return;
  await safeDelete(ctx, meta, [itemId]);
};
