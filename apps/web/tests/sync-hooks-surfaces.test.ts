/**
 * Multi-surface parity for sync hooks.
 *
 * REST is the reference; this pins GraphQL, the SDK and MCP to the same
 * semantics. Two invariants have to hold on EVERY surface, because a hook that
 * is safe over REST and unsafe over GraphQL is worse than no hook at all:
 *   1. the signing secret never comes back out, and
 *   2. `onError` is never chosen for the caller.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { syncHooksTools } from "../src/server/mcp/tools/sync-hooks";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const SECRET = "HOOK-SIGNING-SECRET-DO-NOT-LEAK";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("sync hooks — GraphQL surface", () => {
  let h: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("create → list → update → test → delete round-trips", async () => {
    const made = await gql(
      `mutation($d:SyncHookInput!){ createSyncHook(data:$d){ id name onError canMutate hasSecret enabled } }`,
      {
        d: {
          name: "gql-guard",
          url: "https://app.example/hook",
          events: ["posts.beforeCreate"],
          onError: "deny",
          secret: SECRET,
        },
      },
    );
    expect(made.errors).toBeUndefined();
    const id = made.data?.createSyncHook.id as string;
    expect(made.data?.createSyncHook.onError).toBe("deny");
    expect(made.data?.createSyncHook.hasSecret).toBe(true);

    const listed = await gql(`{ syncHooks { id name onError } }`);
    expect(listed.data?.syncHooks).toHaveLength(1);

    const updated = await gql(
      `mutation($i:String!,$d:SyncHookInput!){ updateSyncHook(id:$i, data:$d){ name enabled } }`,
      { i: id, d: { name: "renamed" } },
    );
    expect(updated.data?.updateSyncHook.name).toBe("renamed");

    // The target does not exist, so the call fails — the point is that the
    // surface reports it rather than throwing an unhandled error.
    const tested = await gql(`mutation($i:String!){ testSyncHook(id:$i){ ok error } }`, { i: id });
    expect(tested.errors).toBeUndefined();
    expect(tested.data?.testSyncHook.ok).toBe(false);

    expect((await gql(`mutation($i:String!){ deleteSyncHook(id:$i) }`, { i: id })).errors).toBeUndefined();
    expect((await gql(`{ syncHooks { id } }`)).data?.syncHooks).toEqual([]);
  });

  test("the signing secret is never readable back", async () => {
    await gql(`mutation($d:SyncHookInput!){ createSyncHook(data:$d){ id } }`, {
      d: {
        name: "secret-holder",
        url: "https://app.example/hook",
        events: ["*"],
        onError: "allow",
        secret: SECRET,
      },
    });
    const listed = await gql(`{ syncHooks { id name url events headers hasSecret } }`);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  test("onError is required and constrained on this surface too", async () => {
    const missing = await gql(`mutation($d:SyncHookInput!){ createSyncHook(data:$d){ id } }`, {
      d: { name: "x", url: "https://app.example/h", events: ["*"] },
    });
    expect(missing.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const bogus = await gql(`mutation($d:SyncHookInput!){ createSyncHook(data:$d){ id } }`, {
      d: { name: "x", url: "https://app.example/h", events: ["*"], onError: "maybe" },
    });
    expect(bogus.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("an over-ceiling timeout is refused, not clamped", async () => {
    const res = await gql(`mutation($d:SyncHookInput!){ createSyncHook(data:$d){ id } }`, {
      d: {
        name: "x",
        url: "https://app.example/h",
        events: ["*"],
        onError: "deny",
        timeoutMs: 999999,
      },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("sync hooks — GraphQL is admin-gated", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });
  afterAll(() => h.cleanup());

  /** No `seedAdmin` — these run with no session at all. */
  const anon = async (query: string) =>
    (await (await h.fetch("/api/graphql", json({ query }))).json()) as {
      data?: Record<string, any>;
      errors?: { extensions?: { code?: string } }[];
    };

  test("every sync-hook field refuses an unauthenticated caller", async () => {
    // A hook can block writes and holds a signing secret, so an unauthenticated
    // read here would be both a disclosure and a way to map the write gates.
    const probes = [
      `{ syncHooks { id } }`,
      `mutation{ createSyncHook(data:{name:"x",url:"https://a.test/h",events:["*"],onError:"deny"}){ id } }`,
      `mutation{ updateSyncHook(id:"x", data:{name:"y"}){ id } }`,
      `mutation{ deleteSyncHook(id:"x") }`,
      `mutation{ testSyncHook(id:"x"){ ok } }`,
    ];
    for (const q of probes) {
      const res = await anon(q);
      expect(["FORBIDDEN", "UNAUTHORIZED"]).toContain(res.errors?.[0]?.extensions?.code);
    }
  });
});

describe("sync hooks — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("create → list → update → delete round-trips", async () => {
    const made = await client.syncHooks.create({
      name: "sdk-guard",
      url: "https://app.example/hook",
      events: ["orders.beforeCreate"],
      onError: "deny",
      secret: SECRET,
      canMutate: true,
    });
    expect(made.data.onError).toBe("deny");
    expect(made.data.canMutate).toBe(true);
    expect(made.data.hasSecret).toBe(true);

    const listed = await client.syncHooks.list();
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed.data)).not.toContain(SECRET);

    const updated = await client.syncHooks.update(made.data.id, { enabled: false });
    expect(updated.data.enabled).toBe(false);

    expect((await client.syncHooks.delete(made.data.id)).ok).toBe(true);
    expect((await client.syncHooks.list()).data).toEqual([]);
  });
});

describe("sync hooks — MCP surface", () => {
  test("the tool group covers the whole REST surface", () => {
    expect(syncHooksTools.map((t) => t.name).sort()).toEqual([
      "sync_hooks.create",
      "sync_hooks.delete",
      "sync_hooks.list",
      "sync_hooks.test",
      "sync_hooks.update",
    ]);
  });

  test("create requires onError and constrains it to the two real answers", () => {
    const create = syncHooksTools.find((t) => t.name === "sync_hooks.create")!;
    const schema = create.inputSchema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
      additionalProperties?: boolean;
    };
    // An agent must not be able to create a hook without stating the failure
    // policy — that is the decision the whole feature hinges on.
    expect(schema.required).toContain("onError");
    expect(schema.properties?.onError?.enum).toEqual(["allow", "deny"]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("every tool explains itself well enough for an agent to choose it", () => {
    for (const tool of syncHooksTools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });
});
