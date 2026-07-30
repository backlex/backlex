/**
 * External vector stores (Pinecone, Qdrant).
 *
 * Both are PER-MODEL because an index/collection fixes its vector dimension at
 * creation. The failure that actually matters is not a bad HTTP call — it is
 * writing one model's vectors into another model's index, which succeeds
 * whenever the dimensions happen to match and then quietly poisons every search.
 * So most of these assert the model→index routing and the loud failure when a
 * model has no index.
 */
import { describe, expect, test } from "bun:test";
import { pineconeVectorAdapter } from "../src/server/adapters/vector.pinecone";
import { qdrantVectorAdapter } from "../src/server/adapters/vector.qdrant";

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** A fetch stub that records requests and replays a canned body. */
const recorder = (body: unknown = {}, status = 200) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const VEC = [0.1, 0.2, 0.3];

describe("Pinecone", () => {
  const make = (rec: ReturnType<typeof recorder>) =>
    pineconeVectorAdapter({
      apiKey: "pc-key",
      hosts: {
        "openai-3-small": "small-idx.svc.us-east-1.pinecone.io",
        "openai-3-large": "https://large-idx.svc.us-east-1.pinecone.io",
      },
      fetchImpl: rec.fetchImpl,
    });

  test("each model goes to its own index host", async () => {
    const rec = recorder();
    const a = make(rec);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC }]);
    await a.upsert("openai-3-large", [{ id: "1", values: VEC }]);
    expect(rec.calls[0]!.url).toBe("https://small-idx.svc.us-east-1.pinecone.io/vectors/upsert");
    // A host given with a scheme must not be double-prefixed.
    expect(rec.calls[1]!.url).toBe("https://large-idx.svc.us-east-1.pinecone.io/vectors/upsert");
  });

  test("a model with no index throws instead of writing somewhere else", async () => {
    const rec = recorder();
    // Silently routing to another model's index is the poisoning failure this
    // guards: same-dimension writes would be accepted.
    await expect(make(rec).upsert("bge-m3", [{ id: "1", values: VEC }])).rejects.toThrow(
      /no index configured for embedding model "bge-m3"/,
    );
    expect(rec.calls).toHaveLength(0);
  });

  test("the API key and version header travel on every call", async () => {
    const rec = recorder();
    await make(rec).upsert("openai-3-small", [{ id: "1", values: VEC }]);
    expect(rec.calls[0]!.headers["Api-Key"]).toBe("pc-key");
    // Omitting the version header makes Pinecone answer an unhelpful 400.
    expect(rec.calls[0]!.headers["X-Pinecone-API-Version"]).toBeTruthy();
  });

  test("a batch spanning namespaces is split, not filed under one", async () => {
    const rec = recorder();
    await make(rec).upsert("openai-3-small", [
      { id: "1", values: VEC, namespace: "a" },
      { id: "2", values: VEC, namespace: "b" },
      { id: "3", values: VEC },
    ]);
    // Pinecone namespaces live on the REQUEST, so one call per namespace.
    expect(rec.calls).toHaveLength(3);
    const namespaces = rec.calls.map((c) => c.body.namespace);
    expect(namespaces).toEqual(["a", "b", undefined]);
  });

  test("query maps filters into Pinecone's $eq form", async () => {
    const rec = recorder({ matches: [{ id: "x", score: 0.9, metadata: { k: 1 } }] });
    const out = await make(rec).query("openai-3-small", {
      values: VEC,
      topK: 5,
      namespace: "ns",
      filter: { tenant: "t1" },
    });
    expect(rec.calls[0]!.body).toMatchObject({
      topK: 5,
      namespace: "ns",
      // A bare value is rejected by Pinecone.
      filter: { tenant: { $eq: "t1" } },
      includeMetadata: true,
    });
    expect(out).toEqual([{ id: "x", score: 0.9, metadata: { k: 1 } }]);
  });

  test("an empty batch makes no request", async () => {
    const rec = recorder();
    const a = make(rec);
    await a.upsert("openai-3-small", []);
    await a.delete("openai-3-small", []);
    expect(rec.calls).toHaveLength(0);
  });

  test("an error surfaces Pinecone's own message", async () => {
    const rec = recorder({ message: "Vector dimension 1536 does not match 3072" }, 400);
    await expect(
      make(rec).upsert("openai-3-small", [{ id: "1", values: VEC }]),
    ).rejects.toThrow(/does not match 3072/);
  });
});

describe("Qdrant", () => {
  const make = (rec: ReturnType<typeof recorder>) =>
    qdrantVectorAdapter({
      url: "https://q.test:6333/",
      apiKey: "q-key",
      collections: { "openai-3-small": "small", "bge-m3": "bge" },
      fetchImpl: rec.fetchImpl,
    });

  test("each model goes to its own collection, trailing slash trimmed", async () => {
    const rec = recorder();
    const a = make(rec);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC }]);
    await a.upsert("bge-m3", [{ id: "1", values: VEC }]);
    expect(rec.calls[0]!.url).toBe("https://q.test:6333/collections/small/points?wait=true");
    expect(rec.calls[1]!.url).toBe("https://q.test:6333/collections/bge/points?wait=true");
  });

  test("a model with no collection throws instead of writing somewhere else", async () => {
    const rec = recorder();
    await expect(
      make(rec).upsert("openai-3-large", [{ id: "1", values: VEC }]),
    ).rejects.toThrow(/no collection configured for embedding model "openai-3-large"/);
    expect(rec.calls).toHaveLength(0);
  });

  test("the api-key header travels on every call", async () => {
    const rec = recorder();
    await make(rec).upsert("openai-3-small", [{ id: "1", values: VEC }]);
    expect(rec.calls[0]!.headers["api-key"]).toBe("q-key");
  });

  test("namespace is carried in the payload and filtered on", async () => {
    const rec = recorder({ result: [] });
    const a = make(rec);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC, namespace: "ns" }]);
    expect(rec.calls[0]!.body.points[0].payload).toMatchObject({ namespace: "ns" });

    await a.query("openai-3-small", { values: VEC, namespace: "ns", filter: { tenant: "t1" } });
    expect(rec.calls[1]!.body.filter.must).toEqual([
      { key: "namespace", match: { value: "ns" } },
      { key: "tenant", match: { value: "t1" } },
    ]);
  });

  test("a query with no namespace or filter sends no filter block", async () => {
    const rec = recorder({ result: [] });
    await make(rec).query("openai-3-small", { values: VEC });
    expect(rec.calls[0]!.body.filter).toBeUndefined();
    expect(rec.calls[0]!.body.limit).toBe(10);
  });

  test("hits map to VectorMatch with the id coerced to a string", async () => {
    // Qdrant point ids may be numeric; the contract is a string id.
    const rec = recorder({ result: [{ id: 42, score: 0.5, payload: { k: "v" } }] });
    const out = await make(rec).query("openai-3-small", { values: VEC });
    expect(out).toEqual([{ id: "42", score: 0.5, metadata: { k: "v" } }]);
  });

  test("an error surfaces Qdrant's own status.error", async () => {
    const rec = recorder({ status: { error: "Wrong input: Collection not found" } }, 404);
    await expect(make(rec).query("openai-3-small", { values: VEC })).rejects.toThrow(
      /Collection not found/,
    );
  });

  test("two namespaces holding the same record id get DISTINCT points", async () => {
    // Qdrant point ids are unique per collection and it has no native
    // namespaces, so a shared multi-tenant collection would have one workspace
    // overwrite the other's vector. Trivial to hit with an adopted table whose
    // primary key is an integer.
    const rec = recorder();
    const a = make(rec);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC, namespace: "tenantA:posts" }]);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC, namespace: "tenantB:posts" }]);
    const idA = rec.calls[0]!.body.points[0].id;
    const idB = rec.calls[1]!.body.points[0].id;
    expect(idA).not.toBe(idB);
    // Both must be legal Qdrant ids (u64 or UUID) — a raw "ns:id" string is not.
    for (const id of [idA, idB]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test("the point id is stable, so an upsert of the same record is idempotent", async () => {
    const rec = recorder();
    const a = make(rec);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC, namespace: "ns" }]);
    await a.upsert("openai-3-small", [{ id: "1", values: [0.9, 0.8, 0.7], namespace: "ns" }]);
    expect(rec.calls[0]!.body.points[0].id).toBe(rec.calls[1]!.body.points[0].id);
  });

  test("delete targets only the given namespace's point", async () => {
    const rec = recorder();
    const a = make(rec);
    await a.upsert("openai-3-small", [{ id: "1", values: VEC, namespace: "tenantB:posts" }]);
    const victimPoint = rec.calls[0]!.body.points[0].id;
    await a.delete("openai-3-small", ["1"], "tenantA:posts");
    // Deleting tenant A's record must not touch tenant B's point.
    expect(rec.calls[1]!.body.points).not.toContain(victimPoint);
    expect(rec.calls[1]!.body.points).toHaveLength(1);
  });

  test("query hands back the caller's id, not the hashed point id", async () => {
    const rec = recorder({
      result: [
        { id: "0f0e0d0c-0b0a-4908-8706-050403020100", score: 0.7, payload: { _backlex_id: "42", namespace: "ns", title: "x" } },
      ],
    });
    const out = await make(rec).query("openai-3-small", { values: VEC });
    expect(out[0]!.id).toBe("42");
    // Bookkeeping fields are stripped so metadata reads back as stored.
    expect(out[0]!.metadata).toEqual({ title: "x" });
  });

  test("an anonymous instance omits the api-key header entirely", async () => {
    const rec = recorder();
    const a = qdrantVectorAdapter({
      url: "http://localhost:6333",
      collections: { "bge-m3": "bge" },
      fetchImpl: rec.fetchImpl,
    });
    await a.upsert("bge-m3", [{ id: "1", values: VEC }]);
    expect(rec.calls[0]!.headers["api-key"]).toBeUndefined();
    // A local http instance must not be forced to https.
    expect(rec.calls[0]!.url.startsWith("http://localhost:6333/")).toBe(true);
  });
});
