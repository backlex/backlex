import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import {
  collapseChunkMatches,
  isVectorizable,
  passagesByItem,
  resolveModel,
  vectorNamespace,
  type Passage,
} from "../vectorize";

import { ftsRankedIds, isSearchable } from "../fts";
import { loadAppSettings } from "../settings";
import { hasLocalizedField, type CollectionRow } from "./collection-loader";
import { deserializeRow, projectFields } from "./serialize";
import { applySidecarFromRows, loadSidecarForRows } from "./i18n-sidecar";
import { sidecarFields } from "@backlex/db";
import {
  deletedFilter,
  draftFilter,
  fromOf,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "./sql-helpers";

// ── Relevance search (full-text / vector / hybrid) ───────────────────────────
// Extracted from routes/items/query.ts so REST and GraphQL share one
// implementation: mode resolution, the RRF fusion, and — critically — the
// permission/tenant/soft-delete/draft re-filtering at hydration that stops a
// vector hit the caller can't see from leaking.

/** Vector candidates fetched per pool slot, so collapsing a long row's chunks
 *  back to one id does not leave the pool short. Three is enough that a page
 *  of results survives even when every hit is a multi-chunk document. */
const CHUNK_OVERFETCH = 3;

export type SearchMode = "fts" | "vector" | "hybrid";

export interface SearchItemsInput {
  q: string;
  mode?: SearchMode;
  limit?: number;
  locale?: string | null;
  /**
   * Attach the passages that matched to each row, as `_passages`.
   *
   * Opt-in, because it is both extra payload and a wider read: a passage is
   * text as EMBEDDED, so it can contain a field the caller's field allow-list
   * would strip from the row itself. Where such an allow-list is in force this
   * returns nothing rather than a filtered guess — see the refusal below.
   */
  passages?: boolean;
}

export interface SearchItemsGates {
  /** Row-level permission clamp (null = unrestricted). */
  permWhere: SQL | null;
  /** Readable field allow-list (null = all). */
  permFields: Set<string> | null;
  /** Whether unpublished drafts are visible to the caller. */
  canSeeDrafts: boolean;
}

export const searchCollectionItems = async (
  ctx: Ctx,
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  input: SearchItemsInput,
  gates: SearchItemsGates,
): Promise<{ data: Record<string, unknown>[]; mode: SearchMode; limit: number }> => {
  const needle = input.q.trim();
  if (!needle) throw new AppError("VALIDATION", "`q` must be non-empty");
  const limit = input.limit ?? 20;

  const ftsOn = isSearchable(collection);
  const vecOn = isVectorizable(collection, ctx.env);

  // The toggle can be on while the index is still empty of inputs (no field
  // marked `searchable` / `vectorize`, no embedding model). Name the actual
  // missing piece so the 422 doesn't contradict what the admin sees in the
  // collection's settings.
  const ftsReason = collection.fts
    ? `full-text search is on, but no text field is marked "searchable" — mark at least one text/longtext field searchable, then run a re-index`
    : "full-text search is not enabled";
  const vecReason = !collection.vectorize
    ? "vector search is not enabled"
    : !resolveModel(collection, ctx.env)
      ? "vector search is on, but no embedding model is configured"
      : `vector search is on, but no text field is marked "vectorize"`;

  // Resolve the effective mode, rejecting requests for a backend the
  // collection hasn't enabled so the caller gets a precise 422 instead of
  // a silently-empty result.
  let mode: SearchMode;
  if (input.mode) {
    if (input.mode === "fts" && !ftsOn) {
      throw new AppError("VALIDATION", `Collection "${collection.slug}": ${ftsReason}.`);
    }
    if (input.mode === "vector" && !vecOn) {
      throw new AppError("VALIDATION", `Collection "${collection.slug}": ${vecReason}.`);
    }
    if (input.mode === "hybrid" && !(ftsOn && vecOn)) {
      const missing = [...(ftsOn ? [] : [ftsReason]), ...(vecOn ? [] : [vecReason])];
      throw new AppError(
        "VALIDATION",
        `Hybrid search needs both backends on collection "${collection.slug}": ${missing.join("; ")}.`,
      );
    }
    mode = input.mode;
  } else if (ftsOn && vecOn) {
    mode = "hybrid";
  } else if (ftsOn) {
    mode = "fts";
  } else if (vecOn) {
    mode = "vector";
  } else {
    throw new AppError(
      "VALIDATION",
      `Collection "${collection.slug}" is not searchable: ${ftsReason}; ${vecReason}.`,
    );
  }

  // Over-fetch candidates from each backend so that rows dropped by the
  // permission/visibility filters at hydration don't starve the page.
  const pool = Math.min(100, Math.max(limit, 50));
  const wantFts = mode === "fts" || mode === "hybrid";
  const wantVec = mode === "vector" || mode === "hybrid";

  // Filled by the vector pass when the caller asked for passages, so the
  // matched text survives into the response instead of being discarded once
  // its id has been read off it.
  let passages = new Map<string, Passage[]>();

  const vectorRankedIds = async (): Promise<string[]> => {
    const model = resolveModel(collection, ctx.env);
    if (!model) return [];
    const { values } = await ctx.embedding.embed({
      model,
      texts: [needle],
      intent: "query",
    });
    const matches = await ctx.vector.query(model, {
      values: values[0]!,
      // A long row is many chunks, so the same item can occupy several of the
      // top slots. Over-fetch so collapsing them still leaves a full pool —
      // without this a single long document could crowd out every other row.
      topK: pool * CHUNK_OVERFETCH,
      // Must be the SAME namespace the write path wrote to. It used to be the
      // bare slug while every write was scoped `<tenantId>:<slug>`, so this
      // searched a namespace nothing had ever been written to — silently, since
      // "no matches" and "wrong namespace" are the same empty array here.
      namespace: vectorNamespace(collection.slug, auth.tenantId ?? null),
    });
    // A passage is the chunk text as embedded, which is built from every
    // field flagged `vectorize` — including ones a field allow-list would
    // strip from the row at `projectFields`. Returning it anyway would route
    // around that clamp, so a restricted caller gets no passages at all rather
    // than a filtered guess: chunk boundaries do not follow field boundaries,
    // so a chunk cannot be reliably attributed to one field and censored.
    if (input.passages && gates.permFields === null) {
      passages = passagesByItem(matches);
    }
    // Chunk ids (`<itemId>#3`) must become item ids before anything downstream
    // sees them: they feed RRF below, and then a `WHERE pk IN (…)` that a
    // chunk id matches nothing in.
    return collapseChunkMatches(matches, pool);
  };

  const [ftsIds, vecIds] = await Promise.all([
    wantFts ? ftsRankedIds(ctx, collection, needle, pool) : Promise.resolve<string[]>([]),
    wantVec ? vectorRankedIds() : Promise.resolve<string[]>([]),
  ]);

  // Reciprocal Rank Fusion: each list contributes 1/(K + rank) per id, so a
  // row ranked highly by either backend floats up and rows ranked by both
  // win. K=60 is the canonical constant from the original RRF paper.
  const RRF_K = 60;
  const scores = new Map<string, number>();
  const fuse = (ids: string[]) => {
    ids.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  };
  fuse(ftsIds);
  fuse(vecIds);
  const fusedIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, limit);

  if (fusedIds.length === 0) {
    return { data: [], mode, limit };
  }

  // Hydrate the surviving ids from the physical table with EVERY read
  // filter re-applied — this is what enforces security on vector-sourced
  // ids (the vector store has no permission model). `fromOf`/`selectStar`
  // carry the adopted-collection ownership-join + aliased-column handling.
  const joined = usesOwnershipSideTable(collection);
  const baseTblId = sql.identifier(collection.physicalTable);
  const inList = sql.join(fusedIds.map((id) => sql`${id}`), sql`, `);
  const idWhere = joined
    ? sql`${baseTblId}.${sql.identifier(collection.pkColumn)} IN (${inList})`
    : sql`${sql.identifier(collection.pkColumn)} IN (${inList})`;
  const tenantWhereRaw = tenantFilter(collection, auth);
  const tenantWhere =
    joined && tenantWhereRaw && collection.tenantScoped && auth.tenantId
      ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
      : tenantWhereRaw;
  const deletedWhere = deletedFilter(collection, joined ? collection.physicalTable : undefined);
  const draftWhere = draftFilter(
    collection,
    gates.canSeeDrafts,
    undefined,
    joined ? collection.physicalTable : undefined,
  );
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(idWhere, gates.permWhere, tenantWhere, deletedWhere, draftWhere)}`,
  );

  const locale = input.locale ?? null;
  const defaultLocale =
    locale && locale !== "*" && hasLocalizedField(collection.fields)
      ? (await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null)).i18nDefaultLocale
      : null;
  const localizedDefs = sidecarFields(collection.fields);
  const sidecarByRow =
    localizedDefs.length > 0
      ? await loadSidecarForRows(
          ctx,
          collection.physicalTable,
          rows.map((r) => String(r[collection.pkColumn])),
          localizedDefs,
        )
      : new Map<string, Array<Record<string, unknown>>>();
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const base = deserializeRow(r, collection.fields, ctx.dialect, collection.ownerScoped);
    if (localizedDefs.length > 0) {
      applySidecarFromRows(
        base,
        sidecarByRow.get(String(r[collection.pkColumn])) ?? [],
        localizedDefs,
        ctx.dialect,
        locale,
        defaultLocale,
      );
    }
    const projected = projectFields(base, gates.permFields);
    byId.set(String(projected.id), projected);
  }
  // Re-order to the fused ranking — `IN (…)` doesn't preserve order, and
  // hydration may have dropped ids the caller can't see.
  const data = fusedIds
    .map((id) => byId.get(id))
    .filter((r): r is Record<string, unknown> => r != null)
    // Attached after the permission clamp and only to rows that survived it,
    // so a passage can never accompany a row the caller was not allowed to
    // see. A row matched by full-text alone has no passages and gets none —
    // an empty array would read as "this row matched no text".
    .map((r) =>
      input.passages && passages.has(String(r.id))
        ? { ...r, _passages: passages.get(String(r.id)) }
        : r,
    );

  return { data, mode, limit };
};
