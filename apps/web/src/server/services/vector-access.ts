import { AppError, type AuthSubject } from "@backlex/core";
import type { Ctx } from "../context";
import type { CollectionRow } from "./items/collection-loader";
import { loadCollection } from "./items/collection-loader";
import { readableIds } from "./items/row-access";
import { resolvePermission, type ResolvedPermission } from "./permissions";
import { itemIdOf } from "./vectorize";

/**
 * A vector namespace is a collection slug, or it is free-form — and the store
 * cannot tell you which.
 *
 * `embedAndUpsert` writes a collection's chunks under `vectorNamespace(slug,
 * tenantId)`, and `routes/vector.ts::scopeNs` builds the identical string from
 * whatever the caller typed. So `{"namespace":"employees"}` on the raw
 * endpoints addresses the `employees` collection's index exactly, and those
 * endpoints were `requireUser`-only: any signed-in identity — including a
 * workspace's own app-plane end-users, who `route-planes.ts` admits here —
 * could read back `metadata.content`, the verbatim indexed text of rows whose
 * `GET /api/items/employees` is 403, and `delete` could silently destroy the
 * index behind every `mode: "vector"` search.
 *
 * Returns the collection when the namespace names one, `null` when it does
 * not. A free-form namespace stays what it has always been — a per-workspace
 * scratch space any member may use — because re-shaping it to `<tenant>:raw:…`
 * would orphan every vector already written under the old key.
 */
export const collectionForNamespace = async (
  ctx: Pick<Ctx, "db" | "dialect">,
  tenantId: string | null | undefined,
  namespace: string | undefined,
): Promise<CollectionRow | null> => {
  if (!namespace || !tenantId) return null;
  try {
    return await loadCollection(ctx, tenantId, namespace);
  } catch (e) {
    // Only "there is no such collection" means free-form. A collection that
    // exists but is registered against a table nobody may read (`FORBIDDEN`,
    // see `loadCollection`) must not fall through to the unguarded path.
    if (e instanceof AppError && e.code === "NOT_FOUND") return null;
    throw e;
  }
};

/**
 * Require the collection permission a namespace implies, if it implies one.
 *
 * `read` for query/search, `update` for upsert/embed-upsert/delete — the same
 * verbs `/api/items/{slug}/search` and the item write path ask for. The
 * refusal is `FORBIDDEN` and names the collection: the caller supplied the
 * slug, so nothing is disclosed by confirming it.
 */
export const requireNamespacePermission = async (
  ctx: Ctx,
  auth: AuthSubject & { tenantId?: string | null },
  namespace: string | undefined,
  action: "read" | "update",
): Promise<{ collection: CollectionRow; perm: ResolvedPermission } | null> => {
  const collection = await collectionForNamespace(ctx, auth.tenantId, namespace);
  if (!collection) return null;
  const perm = await resolvePermission(ctx, auth, collection.slug, action);
  if (!perm.allowed) {
    throw new AppError(
      "FORBIDDEN",
      `Namespace "${namespace}" is the vector index of collection "${collection.slug}" — ${action} permission on it is required`,
    );
  }
  return { collection, perm };
};

/**
 * Of these VECTOR ids, the ones whose row this identity may actually touch.
 *
 * The vector store has no permission model, so every id that comes out of it
 * has to be hydrated back through the physical table with the caller's own
 * read filters re-applied — the rule `searchCollectionItems` already follows
 * for the collection search path, and the reason vector-sourced ids are safe
 * there. All this adds over {@link readableIds} is the fold from a chunk id
 * (`<itemId>#3`) to the item id, because that is what the primary key holds.
 */
export const readableItemIds = async (
  ctx: Ctx,
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  perm: Pick<ResolvedPermission, "whereSql" | "isAdmin">,
  vectorIds: string[],
): Promise<Set<string>> =>
  readableIds(ctx, auth, collection, perm, vectorIds.map(itemIdOf));

/**
 * The matches whose row survives {@link readableItemIds}, with the row-derived
 * text removed when the caller holds a field allow-list.
 *
 * A chunk is built from every field flagged `vectorize`, so `metadata.content`
 * carries values `projectFields` would strip — and chunk boundaries do not
 * follow field boundaries, so it cannot be censored field by field. The same
 * conclusion `search.ts` reached about `_passages`: a restricted caller gets
 * the hit, not the text.
 *
 * `topK` is applied by the store before this runs, so a filtered query can
 * return fewer than `topK` matches. That is the honest answer — inflating the
 * fetch to refill the page would leak the *shape* of what was filtered out.
 */
export const clampMatchesToReadable = async (
  ctx: Ctx,
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  perm: Pick<ResolvedPermission, "whereSql" | "isAdmin" | "fields">,
  matches: Array<{ id: string; metadata?: Record<string, unknown> }>,
): Promise<Array<{ id: string; metadata?: Record<string, unknown> }>> => {
  const readable = await readableItemIds(
    ctx,
    auth,
    collection,
    perm,
    matches.map((m) => m.id),
  );
  const kept = matches.filter((m) => readable.has(itemIdOf(m.id)));
  if (perm.fields === null) return kept;
  return kept.map((m) => {
    if (!m.metadata || !("content" in m.metadata)) return m;
    const { content: _content, ...rest } = m.metadata;
    return { ...m, metadata: rest };
  });
};
