/**
 * Chunking, and the deletion problem underneath it.
 *
 * Before this, one row meant one vector and nothing in the write path looked
 * at length. Every embedding model here has a hard input ceiling — 8192 tokens
 * for bge-m3, 8191 for both OpenAI models — and the two providers failed a
 * long row differently and silently: OpenAI answers 400, which `embedAndUpsert`
 * catches and logs, so the row ends up with NO vector and is invisible to
 * `mode: "vector"` forever; Workers AI truncates, so only the opening of the
 * document is searchable. A knowledge base of long documents is exactly what
 * vector search is for, and it was the case that did not work.
 *
 * The half worth testing hardest is not the splitting — it is that a chunk
 * cannot outlive the text it came from. Chunk ids are derived
 * (`<itemId>#<n>`), the adapter contract deletes by explicit id across all five
 * stores, and none of them can delete by metadata filter. So a row edited from
 * five chunks down to two must actively drop the other three, or a search for
 * deleted text keeps finding the row.
 */
import { describe, expect, test } from "bun:test";
import {
  CHUNK_CHARS,
  MAX_CHUNKS,
  chunkId,
  chunkText,
  collapseChunkMatches,
  deleteVector,
  embedAndUpsert,
  itemIdOf,
  passagesByItem,
  staleChunkIds,
  type VectorizeMeta,
} from "../src/server/services/vectorize";

const meta: VectorizeMeta = {
  slug: "articles",
  vectorize: true,
  vectorizeModel: "bge-m3",
  fields: [{ name: "body", type: "longtext", vectorize: true } as never],
};

/** A ctx that records what reached the store, with an embedding stub that
 *  returns one vector per text so record/values alignment is real. */
const recorder = () => {
  const seen = {
    upserted: [] as Array<{ id: string; metadata: Record<string, unknown> }>,
    deleted: [] as string[],
    embedCalls: [] as string[][],
  };
  const ctx = {
    env: { EMBEDDING_DEFAULT_MODEL: "bge-m3" },
    embedding: {
      embed: async ({ texts }: { texts: string[] }) => {
        seen.embedCalls.push(texts);
        return { values: texts.map((_, i) => [i, 0, 0]) };
      },
    },
    vector: {
      upsert: async (_m: unknown, records: Array<{ id: string; metadata: Record<string, unknown> }>) => {
        seen.upserted.push(...records);
      },
      delete: async (_m: unknown, ids: string[]) => {
        seen.deleted.push(...ids);
      },
      query: async () => [],
    },
  } as never;
  return { ctx, seen };
};

describe("chunkText", () => {
  test("short text is one chunk and is not rewritten", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  test("blank text is no chunks at all, not one empty one", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  test("no chunk exceeds the budget, whatever the input", () => {
    // A single unbroken run with no separator anywhere is the case that has to
    // fall through to a hard cut.
    for (const text of ["x".repeat(9000), `${"word ".repeat(3000)}`, "a\n\n".repeat(4000)]) {
      for (const c of chunkText(text)) expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  test("it splits on a paragraph break rather than mid-sentence", () => {
    const a = "A".repeat(CHUNK_CHARS - 100);
    // Long enough that the whole thing cannot be one chunk, so the splitter
    // has to choose a boundary — and the paragraph break is the one it should
    // find, not the hard cut 100 characters later.
    const b = `Second paragraph starts here. ${"B".repeat(500)}`;
    const chunks = chunkText(`${a}\n\n${b}`);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toContain("Second paragraph starts here.");
  });

  test("chunks overlap, so a sentence across a boundary is findable from both", () => {
    const chunks = chunkText("z".repeat(CHUNK_CHARS * 2));
    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(CHUNK_CHARS * 2);
  });

  test("a document past the cap is truncated rather than looping forever", () => {
    const chunks = chunkText("q".repeat(CHUNK_CHARS * (MAX_CHUNKS + 20)));
    expect(chunks.length).toBe(MAX_CHUNKS);
  });
});

describe("chunk ids", () => {
  test("a single-chunk row keeps the bare item id", () => {
    // Backwards compatibility, and the reason this change needs no re-index:
    // every vector written before chunking is keyed by the bare id, and short
    // rows — nearly all of them — still are.
    expect(chunkId("item-1", 0, 1)).toBe("item-1");
  });

  test("a multi-chunk row is suffixed", () => {
    expect(chunkId("item-1", 2, 5)).toBe("item-1#2");
  });

  test("the item is recoverable from either form", () => {
    expect(itemIdOf("item-1")).toBe("item-1");
    expect(itemIdOf("item-1#7")).toBe("item-1");
    expect(itemIdOf("3f2b1c9e-77aa-4c1f-9d0e-9f0b2a3c4d5e")).toBe(
      "3f2b1c9e-77aa-4c1f-9d0e-9f0b2a3c4d5e",
    );
  });

  test("an adopted table's `#` in a primary key is not mistaken for a chunk", () => {
    // A managed collection's ids are UUIDs, but an adopted table's pk is
    // whatever the user's column holds — `order#42` is an ordinary value.
    // Splitting at the FIRST `#` would rewrite that row's id on every read and
    // write, making it unsearchable and orphaning its vectors past every
    // delete. Only a trailing `#<digits>` is a chunk suffix.
    expect(itemIdOf("order#42-b")).toBe("order#42-b");
    expect(itemIdOf("order#42-b#3")).toBe("order#42-b");
    expect(chunkId("order#42-b", 3, 5)).toBe("order#42-b#3");
  });
});

describe("collapsing matches back to items", () => {
  test("chunk ids become item ids", () => {
    // They feed RRF and then a `WHERE pk IN (…)`, which a chunk id matches
    // nothing in — a search that returned only chunk hits would come back
    // empty with no error anywhere.
    expect(collapseChunkMatches([{ id: "a#2" }, { id: "b" }], 10)).toEqual(["a", "b"]);
  });

  test("a row appears once, at its best chunk's rank", () => {
    // Matches arrive sorted by score, so first occurrence is the best passage.
    expect(
      collapseChunkMatches([{ id: "a#4" }, { id: "b#0" }, { id: "a#1" }, { id: "a#9" }], 10),
    ).toEqual(["a", "b"]);
  });

  test("a long document cannot outrank a better short one by having more chunks", () => {
    // The failure this prevents: `long` occupies four of the top five slots,
    // and RRF would give it four separate `1/(K+rank)` terms — scoring it as
    // four hits rather than one.
    const matches = [
      { id: "long#0" },
      { id: "long#1" },
      { id: "long#2" },
      { id: "short" },
      { id: "long#3" },
    ];
    expect(collapseChunkMatches(matches, 10)).toEqual(["long", "short"]);
  });

  test("the limit counts items, not chunks", () => {
    const matches = [{ id: "a#0" }, { id: "a#1" }, { id: "b#0" }, { id: "c" }];
    expect(collapseChunkMatches(matches, 2)).toEqual(["a", "b"]);
  });
});

describe("passages — what chunking is FOR", () => {
  // Chunking is only correctness until the matched passage comes back. Without
  // this, `/search` hydrates and returns the whole document and a caller
  // building a prompt has to re-chunk it client-side — redoing the work the
  // server just did and threw away.
  const match = (id: string, score: number, content: string, chunkIndex?: number) => ({
    id,
    score,
    metadata: { content, ...(chunkIndex === undefined ? {} : { chunkIndex }) },
  });

  test("passages group by item, best first", () => {
    const got = passagesByItem([
      match("a#2", 0.9, "second best of a", 2),
      match("b", 0.7, "all of b"),
      match("a#0", 0.5, "worse of a", 0),
    ]);
    expect(got.get("a")).toEqual([
      { text: "second best of a", score: 0.9, index: 2 },
      { text: "worse of a", score: 0.5, index: 0 },
    ]);
    expect(got.get("b")).toEqual([{ text: "all of b", score: 0.7, index: 0 }]);
  });

  test("at most `perItem` passages, so one long row cannot fill a prompt", () => {
    const got = passagesByItem(
      [0, 1, 2, 3, 4].map((i) => match(`a#${i}`, 1 - i / 10, `chunk ${i}`, i)),
      2,
    );
    expect(got.get("a")).toHaveLength(2);
  });

  test("a match with no stored content contributes nothing rather than an empty passage", () => {
    // A store written by a version before chunk metadata existed degrades
    // instead of returning `{ text: "" }`, which a prompt builder would
    // faithfully include.
    const got = passagesByItem([{ id: "a", score: 0.9 }, match("b", 0.8, "real text")]);
    expect(got.has("a")).toBe(false);
    expect(got.get("b")).toHaveLength(1);
  });
});

describe("a passage cannot route around the field allow-list", () => {
  /**
   * A source scan, not a behavioural test, and the reason is worth stating: the
   * bun harness runs on plain SQLite with no embedding provider and no vector
   * store, so `searchCollectionItems` can never reach its vector branch here.
   * The repo already uses source scans for exactly this kind of "condition that
   * must not be quietly loosened" (`ai-quota-gate.test.ts`,
   * `admin-ui-conventions.test.ts`).
   *
   * What it guards: a passage is the chunk text AS EMBEDDED, built from every
   * field flagged `vectorize`. The row itself is clamped by `projectFields`
   * against the caller's readable-field allow-list — so returning the passage
   * regardless would hand back, in full, a field the row was stripped of.
   * Chunk boundaries do not follow field boundaries, so the passage cannot be
   * censored per field either; the only correct answer is to withhold it.
   */
  test("the refusal is still in the vector branch", async () => {
    const src = await Bun.file(
      new URL("../src/server/services/items/search.ts", import.meta.url),
    ).text();
    expect(src).toContain("input.passages && gates.permFields === null");
  });

  test("passages are attached only to rows that survived hydration", async () => {
    // The other half: hydration is what re-applies tenant scope, row
    // permission, soft-delete and draft visibility to vector-sourced ids, so
    // the attach has to happen AFTER it and only for ids that came back.
    const src = await Bun.file(
      new URL("../src/server/services/items/search.ts", import.meta.url),
    ).text();
    const attachAt = src.indexOf("_passages:");
    const hydrateAt = src.indexOf("const rows = await queryAll");
    expect(hydrateAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(hydrateAt);
  });
});

describe("a chunk never outlives its text", () => {
  test("`staleChunkIds` covers the whole range above what was written", () => {
    const ids = staleChunkIds("item-1", 3);
    expect(ids).toContain("item-1"); // the bare id: this row used to be short
    expect(ids).toContain("item-1#3");
    expect(ids).toContain(`item-1#${MAX_CHUNKS - 1}`);
    expect(ids).not.toContain("item-1#2"); // just written — must survive
  });

  test("a single-chunk row does not delete its own bare id", () => {
    const ids = staleChunkIds("item-1", 1);
    expect(ids).not.toContain("item-1");
    expect(ids).toContain("item-1#0");
  });

  test("shrinking a row drops the chunks it no longer has", async () => {
    // The bug this exists to prevent: edit a long document down, and the
    // passages you removed keep matching queries because nothing deleted them.
    const { ctx, seen } = recorder();
    await embedAndUpsert(ctx, meta, "t1", "item-1", { body: "y".repeat(CHUNK_CHARS * 5) });
    const wrote = seen.upserted.map((r) => r.id);
    expect(wrote.length).toBeGreaterThan(3);

    seen.upserted.length = 0;
    seen.deleted.length = 0;
    await embedAndUpsert(ctx, meta, "t1", "item-1", { body: "short again" });

    expect(seen.upserted.map((r) => r.id)).toEqual(["item-1"]);
    // Every id the long version wrote, except the one just rewritten, is gone.
    for (const id of wrote) {
      if (id === "item-1") continue;
      expect(`${id} deleted: ${seen.deleted.includes(id)}`).toBe(`${id} deleted: true`);
    }
  });

  test("deleting the row deletes the bare id AND every chunk", async () => {
    const { ctx, seen } = recorder();
    await deleteVector(ctx, meta, "t1", "item-1");
    expect(seen.deleted).toContain("item-1");
    expect(seen.deleted).toContain("item-1#0");
    expect(seen.deleted).toContain(`item-1#${MAX_CHUNKS - 1}`);
  });

  test("emptying every vectorized field removes the row's vectors entirely", async () => {
    const { ctx, seen } = recorder();
    await embedAndUpsert(ctx, meta, "t1", "item-1", { body: "" });
    expect(seen.upserted).toEqual([]);
    expect(seen.deleted).toContain("item-1");
  });
});

describe("what the store receives", () => {
  test("a long row becomes several vectors, each carrying its own passage", async () => {
    const { ctx, seen } = recorder();
    await embedAndUpsert(ctx, meta, "t1", "item-1", { body: "w".repeat(CHUNK_CHARS * 3) });

    expect(seen.upserted.length).toBeGreaterThan(2);
    // One provider call for the whole row, not one per chunk.
    expect(seen.embedCalls.length).toBe(1);
    expect(seen.embedCalls[0]!.length).toBe(seen.upserted.length);

    for (const [i, r] of seen.upserted.entries()) {
      expect(r.id).toBe(`item-1#${i}`);
      expect(r.metadata.itemId).toBe("item-1");
      expect(r.metadata.chunkIndex).toBe(i);
      expect(r.metadata.chunkTotal).toBe(seen.upserted.length);
      // The chunk's own text, not the row's — a caller showing a snippet wants
      // the passage that matched, and a prompt built from whole rows is what
      // chunking exists to stop.
      expect(String(r.metadata.content).length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  test("a short row is unchanged from before chunking — no chunk metadata", async () => {
    const { ctx, seen } = recorder();
    await embedAndUpsert(ctx, meta, "t1", "item-1", { body: "a short article" });
    expect(seen.upserted.map((r) => r.id)).toEqual(["item-1"]);
    expect(seen.upserted[0]!.metadata.chunkIndex).toBeUndefined();
    expect(seen.upserted[0]!.metadata.content).toBe("body: a short article");
  });
});
