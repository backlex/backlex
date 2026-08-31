/**
 * The vector namespace a write goes to and the one a read asks for must be the
 * same string, or the store is written to one place and searched in another.
 *
 * They were not. `services/vectorize.ts` scopes every write with the tenant
 * (`<tenantId>:<slug>`) so two workspaces owning a same-slug collection can't
 * read each other's vectors; `services/items/search.ts` asked for the bare
 * `collection.slug`. On any deployment where `tenantId` is non-null — which is
 * every multi-workspace install — `mode: "vector"` returned nothing and
 * `mode: "hybrid"` silently degraded to full-text only. `routes/vector.ts` had
 * the prefix right all along, which is why the raw vector API worked and the
 * collection search built on the same store did not.
 *
 * These tests state the invariant instead of a round trip, deliberately: the
 * bun harness has no vector store and no embedding provider (see
 * vector-search-contract.test.ts — `capabilities.store` is "none"), so an
 * end-to-end search cannot run here. Recording adapters make the two code paths
 * declare the namespace they use and compare them directly, which is the actual
 * contract and holds no matter what store is configured.
 *
 * The reads never return a match on purpose: an empty fused list short-circuits
 * `searchCollectionItems` before hydration, so these specs need only the three
 * ctx fields the namespace decision touches.
 */
import { describe, expect, test } from "bun:test";
import type { EmbeddingModel } from "@backlex/core";
import type { VectorMatch, VectorQuery, VectorRecord } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import { deleteVector, embedAndUpsert, type VectorizeMeta } from "../src/server/services/vectorize";
import { searchCollectionItems } from "../src/server/services/items/search";
import type { CollectionRow } from "../src/server/services/items/collection-loader";
import type { Ctx } from "../src/server/context";

const MODEL: EmbeddingModel = "bge-m3";
const TENANT = "tnt_01HQZX";

const FIELDS: FieldDef[] = [
  { name: "title", type: "text", vectorize: true } as unknown as FieldDef,
];

/** Vector-searchable, full-text off — so the mode resolves to "vector" with no
 *  FTS branch to muddy which namespace the assertion is reading. */
const meta: VectorizeMeta = {
  slug: "articles",
  physicalTable: "c_t1_articles",
  vectorize: true,
  vectorizeModel: MODEL,
  fields: FIELDS,
};

const collection = {
  ...meta,
  fts: false,
  ownerScoped: false,
  tenantScoped: true,
  softDelete: false,
  physicalTable: "c_articles",
} as unknown as CollectionRow;

/** Records the namespace each operation is handed, and never matches — an
 *  empty result is what keeps the read path from reaching hydration. */
const recorder = () => {
  const seen: { upsert: string[]; query: string[]; delete: string[] } = {
    upsert: [],
    query: [],
    delete: [],
  };
  const ctx = {
    env: {},
    embedding: {
      embed: async () => ({ values: [[0.1, 0.2, 0.3]], model: MODEL }),
    },
    vector: {
      upsert: async (_m: EmbeddingModel, records: VectorRecord[]) => {
        for (const r of records) seen.upsert.push(r.namespace ?? "<none>");
      },
      query: async (_m: EmbeddingModel, q: VectorQuery): Promise<VectorMatch[]> => {
        seen.query.push(q.namespace ?? "<none>");
        return [];
      },
      delete: async (_m: EmbeddingModel, _ids: string[], namespace?: string) => {
        seen.delete.push(namespace ?? "<none>");
      },
    },
  } as unknown as Ctx;
  return { ctx, seen };
};

const search = (ctx: Ctx, tenantId: string | null) =>
  searchCollectionItems(
    ctx,
    { tenantId } as never,
    collection,
    { q: "hello", mode: "vector" },
    { permWhere: null, permFields: null, canSeeDrafts: true },
  );

describe("vector namespace — write and read must agree", () => {
  test("a tenant-scoped write and the search that follows it use one namespace", async () => {
    const { ctx, seen } = recorder();

    await embedAndUpsert(ctx, meta, TENANT, "item-1", { title: "hello" });
    await search(ctx, TENANT);

    expect(seen.upsert).toEqual([`${TENANT}:articles`]);
    // The bug: this read asked for the bare slug, so it searched a namespace
    // nothing had ever been written to.
    expect(seen.query).toEqual(seen.upsert);
  });

  test("the tenant id is actually in the namespace, not merely consistent", async () => {
    // Guards against a "fix" that makes both sides bare — which would agree
    // with each other and hand one workspace another's vectors.
    const { ctx, seen } = recorder();

    await search(ctx, TENANT);

    expect(seen.query[0]).toBe(`${TENANT}:articles`);
    expect(seen.query[0]).toContain(TENANT);
  });

  test("a tenant-less install still agrees, on the bare slug", async () => {
    // Single-workspace self-host: `nsFor` deliberately falls back to the slug
    // rather than inventing a prefix, and this is the case that accidentally
    // worked before the fix. It must keep working after it.
    const { ctx, seen } = recorder();

    await embedAndUpsert(ctx, meta, null, "item-1", { title: "hello" });
    await search(ctx, null);

    expect(seen.upsert).toEqual(["articles"]);
    expect(seen.query).toEqual(["articles"]);
  });

  test("delete scopes the same way a write does", async () => {
    // A stale vector is deleted by namespace too; if this drifted, retired rows
    // would stay searchable forever in the namespace nobody swept.
    const { ctx, seen } = recorder();

    await embedAndUpsert(ctx, meta, TENANT, "item-1", { title: "hello" });
    await deleteVector(ctx, meta, TENANT, "item-1");

    // Compared as SETS, not as call sequences: since chunking, a write issues
    // a self-heal delete of its own (dropping any chunk ids the previous,
    // longer version of the row left behind), so the two arrays no longer have
    // the same length. The claim this test makes is about the namespace, and
    // every namespace on either side still has to be the one the write used.
    expect([...new Set(seen.delete)]).toEqual([...new Set(seen.upsert)]);
    expect(seen.delete.length).toBeGreaterThan(0);
  });

  test("two workspaces never share a namespace for the same collection", async () => {
    const { ctx, seen } = recorder();

    await search(ctx, "tnt_aaa");
    await search(ctx, "tnt_bbb");

    expect(seen.query[0]).not.toBe(seen.query[1]);
  });
});
