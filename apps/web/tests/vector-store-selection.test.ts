/**
 * Which vector store `buildContext` picks, and what it then claims it can do.
 *
 * `vectorCaps` is what the admin UI reads to enable/disable models, so a wrong
 * answer here is worse than a failure: the UI offers a model that cannot work,
 * and the request dies at first embed. Two invariants are load-bearing:
 *   1. explicitly-configured stores beat the dialect's implicit one, and
 *   2. per-model stores only report ready for models they hold an index for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { buildContext } from "../src/server/context";
import { makeHarness, type TestHarness } from "./setup";

const harnesses: TestHarness[] = [];
const ctxWith = async (overrides: Record<string, unknown>) => {
  const h = makeHarness(overrides as never);
  harnesses.push(h);
  return buildContext(h.env);
};

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const PINECONE = {
  PINECONE_API_KEY: "pc",
  PINECONE_INDEX_OPENAI: "small.svc.pinecone.io",
};
const QDRANT = {
  QDRANT_URL: "https://q.test:6333",
  QDRANT_COLLECTION_BGE_M3: "bge",
};

describe("store selection", () => {
  test("no external config on Bun SQLite leaves vector search off", async () => {
    const ctx = await ctxWith({});
    // Bun SQLite has no vector primitives — claiming otherwise would fail at
    // first upsert with a cryptic SQL error.
    expect(ctx.vectorCaps.store).toBe("none");
  });

  test("Pinecone is used when a key AND at least one index are set", async () => {
    expect((await ctxWith(PINECONE)).vectorCaps.store).toBe("pinecone");
  });

  test("a Pinecone key with no index configured is NOT treated as a store", async () => {
    // Half-configured must not shadow whatever else is available, otherwise
    // every model fails with "no index" and the operator sees no way back.
    const ctx = await ctxWith({ PINECONE_API_KEY: "pc" });
    expect(ctx.vectorCaps.store).toBe("none");
  });

  test("a Qdrant collection with no URL is NOT treated as a store", async () => {
    const ctx = await ctxWith({ QDRANT_COLLECTION_BGE_M3: "bge" });
    expect(ctx.vectorCaps.store).toBe("none");
  });

  test("Qdrant is used when a URL AND at least one collection are set", async () => {
    expect((await ctxWith(QDRANT)).vectorCaps.store).toBe("qdrant");
  });

  test("Pinecone wins over Qdrant when both are configured", async () => {
    const ctx = await ctxWith({ ...PINECONE, ...QDRANT });
    expect(ctx.vectorCaps.store).toBe("pinecone");
  });

  test("Qdrant works without an API key (a local instance)", async () => {
    const ctx = await ctxWith({ QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION_BGE_M3: "bge" });
    expect(ctx.vectorCaps.store).toBe("qdrant");
  });
});

describe("per-model readiness", () => {
  test("a per-model store reports ready ONLY for models it has an index for", async () => {
    const ctx = await ctxWith({
      ...PINECONE,
      // Give bge-m3's provider a config so the provider side is not the reason
      // it is unready — the missing index must be.
      EMBEDDING_HTTP_URL: "https://embed.test",
      OPENAI_API_KEY: "sk-test",
    });
    expect(ctx.vectorCaps.store).toBe("pinecone");
    expect(ctx.vectorCaps.models["openai-3-small"]).toBe(true);
    // Configured provider, but no Pinecone index → not ready. Reporting true
    // here is what makes the UI offer a model that dies at upsert.
    expect(ctx.vectorCaps.models["openai-3-large"]).toBe(false);
    expect(ctx.vectorCaps.models["self-host-bge-m3"]).toBe(false);
  });

  test("a model with an index but no embedding provider is still unready", async () => {
    const ctx = await ctxWith(PINECONE);
    // openai-3-small has a Pinecone index, but no OPENAI_API_KEY to embed with.
    expect(ctx.vectorCaps.models["openai-3-small"]).toBe(false);
  });

  test("Qdrant readiness follows its own collection map", async () => {
    const ctx = await ctxWith({ ...QDRANT, EMBEDDING_HTTP_URL: "https://embed.test", OPENAI_API_KEY: "sk-test" });
    expect(ctx.vectorCaps.store).toBe("qdrant");
    expect(ctx.vectorCaps.models["bge-m3"]).toBe(false); // workers-ai provider absent
    expect(ctx.vectorCaps.models["openai-3-small"]).toBe(false); // no collection
  });

  test("with no store, no model is ready however many providers are configured", async () => {
    const ctx = await ctxWith({ OPENAI_API_KEY: "sk-test", EMBEDDING_HTTP_URL: "https://embed.test" });
    expect(ctx.vectorCaps.store).toBe("none");
    expect(Object.values(ctx.vectorCaps.models).every((v) => v === false)).toBe(true);
  });
});
