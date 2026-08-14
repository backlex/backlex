/**
 * Multi-surface parity for vector search.
 *
 * The invariant that matters most here is what happens on a deployment with NO
 * vector store, which is the default one: `capabilities()` must answer
 * `store: "none"` rather than fail. An application that opens a search box
 * should be able to ask whether search exists without the question being the
 * thing that breaks the page.
 *
 * The client degrades only where the answer really is "this deployment does
 * not offer it" — a missing route, or a not-implemented. A refused SESSION is
 * re-thrown, because reporting "no vector store" for an expired login would
 * send an application to fix the wrong thing.
 *
 * Namespaces are scoped by the server (`<tenant>:<name>`), which is what stops
 * two workspaces naming a namespace the same thing from reading each other's
 * vectors — see `vector-namespace-parity.test.ts` for the write/read agreement
 * that scoping depends on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { vectorTools } from "../src/server/mcp/tools/vector";
import { embeddingTools } from "../src/server/mcp/tools/embedding";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/vector";

describe("vector — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });

  afterAll(() => h.cleanup?.());

  test("capabilities answers on a deployment with no store, instead of failing", async () => {
    // The harness configures no vector store, which is exactly the case an
    // application has to survive.
    const caps = await client.vector.capabilities();
    expect(caps.store).toBe("none");
    expect(Array.isArray(caps.models)).toBe(true);
    // The model roster is still described, so a UI can say WHICH model it
    // would use once a store is configured rather than showing nothing.
    expect(caps.models.length).toBeGreaterThan(0);
  });

  test("the degrade is narrow — a refused session is re-thrown, not reported as 'no store'", async () => {
    const { makeVector } = await import("../../../packages/client/src/clients/vector");

    const unauthorized = makeVector({
      request: async () => {
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      },
    } as never);
    // If this resolved to `store: "none"`, an application would render "search
    // is unavailable on this plan" to a user whose session had simply expired.
    await expect(unauthorized.capabilities()).rejects.toBeDefined();

    const absent = makeVector({
      request: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    } as never);
    expect((await absent.capabilities()).store).toBe("none");
  });

  test("a search against a store-less deployment fails loudly rather than returning nothing", async () => {
    // Silently answering "no matches" is the failure mode this wave's fix
    // branch removed from the collection search path; the raw API must not
    // reintroduce it.
    await expect(
      client.vector.search({ model: "bge-m3", text: "anything", topK: 5 }),
    ).rejects.toBeDefined();
  });

  test("MCP: the tools an agent gets, across both modules", () => {
    expect(vectorTools.map((t) => t.name).sort()).toEqual([
      "vector.capabilities",
      "vector.search",
      "vector.upsert",
    ]);
    // `embedding.upsert` lives in its own module and reaches the SDK through
    // this same client, which is why the parity registry points it here.
    expect(embeddingTools.map((t) => t.name)).toEqual(["embedding.upsert"]);
  });

  test("the SDK points at routes that exist", async () => {
    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeVector } = await import("../../../packages/client/src/clients/vector");
    const vector = makeVector(spy as never);
    await vector.capabilities();
    await vector.upsert({ model: "bge-m3", records: [{ id: "a", values: [0.1] }] });
    await vector.query({ model: "bge-m3", values: [0.1], filter: { collection: "docs" } });
    await vector.delete({ model: "bge-m3", ids: ["a"] });
    await vector.embedUpsert({ model: "bge-m3", records: [{ id: "a", text: "hi" }] });
    await vector.search({ model: "bge-m3", text: "hi", filter: { collection: "docs" } });
    expect(calls).toEqual([
      `GET ${BASE}/capabilities`,
      `POST ${BASE}/upsert`,
      `POST ${BASE}/query`,
      `POST ${BASE}/delete`,
      `POST ${BASE}/embed-upsert`,
      `POST ${BASE}/search`,
    ]);

    // Dispatched for real. These will refuse for want of a store — what is
    // being checked is that they are refused by the HANDLER and not by the
    // router, so a 404 is the failure.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST"
          ? { body: JSON.stringify({ model: "bge-m3", values: [0.1], ids: ["a"], text: "hi", records: [] }) }
          : {}),
      });
      // Asserts the STATUS, and keeps `call` in the failure output so a real
      // miss still names the route. It used to substring-match the rendered
      // line for "404" — which a UUID like `…-4047-…` satisfies on its own, so
      // every one of these files failed a few runs in a hundred for no reason.
      expect({ call, status: res.status }).not.toMatchObject({ status: 404 });
    }
  });

  test("the SDK carries `filter` through, on both search paths", async () => {
    // The filter was silently dropped by two of the five stores until this
    // wave's fix branch; an SDK that omitted it from the body would put the
    // same hole back one layer up.
    const bodies: unknown[] = [];
    const spy = {
      request: async (_m: string, _p: string, body?: unknown) => {
        bodies.push(body);
        return { data: [] };
      },
    };
    const { makeVector } = await import("../../../packages/client/src/clients/vector");
    const vector = makeVector(spy as never);
    await vector.query({ model: "bge-m3", values: [0.1], filter: { collection: "docs" } });
    await vector.search({ model: "bge-m3", text: "hi", filter: { collection: "docs" } });

    for (const body of bodies) {
      expect((body as { filter?: Record<string, unknown> }).filter).toEqual({
        collection: "docs",
      });
    }
  });
});
