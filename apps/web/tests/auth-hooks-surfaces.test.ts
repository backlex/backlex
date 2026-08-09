/**
 * Multi-surface parity for auth hooks.
 *
 * REST is the reference; this pins GraphQL, the SDK and MCP to the same
 * semantics. Four invariants have to hold on EVERY surface, because a hook that
 * is safe over REST and unsafe over GraphQL is worse than no hook at all:
 *   1. the signing secret never comes back out,
 *   2. `onError` is never chosen for the caller,
 *   3. a target names exactly one of a URL or a function, and
 *   4. there is at most one hook per event per workspace.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { authHooksTools } from "../src/server/mcp/tools/auth-hooks";
import { AUTH_HOOK_EVENTS } from "../src/server/services/auth-hooks";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const SECRET = "whsec_AUTHHOOKSIGNINGSECRETDONOTLEAK=";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("auth hooks — GraphQL surface", () => {
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
      `mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id event targetType onError hasSecret enabled } }`,
      {
        d: {
          event: "before-user-created",
          targetType: "url",
          url: "https://app.example/hook",
          onError: "deny",
          secret: SECRET,
        },
      },
    );
    expect(made.errors).toBeUndefined();
    const id = made.data?.createAuthHook.id as string;
    expect(made.data?.createAuthHook.onError).toBe("deny");
    expect(made.data?.createAuthHook.hasSecret).toBe(true);

    const listed = await gql(`{ authHooks { id event onError } }`);
    expect(listed.data?.authHooks).toHaveLength(1);

    const updated = await gql(
      `mutation($i:String!,$d:AuthHookInput!){ updateAuthHook(id:$i, data:$d){ enabled } }`,
      { i: id, d: { enabled: false } },
    );
    expect(updated.data?.updateAuthHook.enabled).toBe(false);

    // The target does not exist, so the call fails — the point is that the
    // surface reports it rather than throwing an unhandled error.
    const tested = await gql(`mutation($i:String!){ testAuthHook(id:$i){ ok error } }`, { i: id });
    expect(tested.errors).toBeUndefined();
    expect(tested.data?.testAuthHook.ok).toBe(false);

    expect((await gql(`mutation($i:String!){ deleteAuthHook(id:$i) }`, { i: id })).errors).toBeUndefined();
    expect((await gql(`{ authHooks { id } }`)).data?.authHooks).toEqual([]);
  });

  test("the signing secret is never readable back", async () => {
    await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: {
        event: "custom-access-token",
        targetType: "url",
        url: "https://app.example/claims",
        onError: "allow",
        secret: SECRET,
      },
    });
    const listed = await gql(`{ authHooks { id event targetType url headers hasSecret } }`);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    // Not vacuous: the hook that holds the secret IS in the response.
    expect(listed.data?.authHooks).toHaveLength(1);
    expect(listed.data?.authHooks[0].hasSecret).toBe(true);
  });

  test("onError is required and constrained on this surface too", async () => {
    const missing = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "send-email", targetType: "url", url: "https://app.example/h" },
    });
    expect(missing.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const bogus = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "send-email", targetType: "url", url: "https://app.example/h", onError: "maybe" },
    });
    expect(bogus.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("an unknown event is refused rather than stored", async () => {
    // Stored metadata is untrusted: an event nothing ever fires would be a
    // hook the operator believes is running.
    const res = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "before-payment", targetType: "url", url: "https://a.test/h", onError: "deny" },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("a target that names neither side is refused", async () => {
    const noUrl = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "password-verification", targetType: "url", onError: "deny" },
    });
    expect(noUrl.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const noFn = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "password-verification", targetType: "function", onError: "deny" },
    });
    expect(noFn.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("a second hook for the same event is refused, not silently ignored", async () => {
    const d = {
      event: "password-verification",
      targetType: "url",
      url: "https://app.example/pv",
      onError: "deny",
    };
    const first = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, { d });
    expect(first.errors).toBeUndefined();
    const second = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, { d });
    expect(second.errors?.[0]?.extensions?.code).toBe("CONFLICT");
  });

  test("MOVING a hook onto a taken event is a conflict, not a driver error", async () => {
    // The unique index would raise either way; without the pre-check that
    // surfaces as an unhandled database error, i.e. a 500 for a plain
    // conflict. Found in the pre-commit security review of my own code.
    const a = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "send-email", targetType: "url", url: "https://a.test/a", onError: "deny" },
    });
    await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: { event: "before-user-created", targetType: "url", url: "https://a.test/b", onError: "deny" },
    });
    const moved = await gql(
      `mutation($i:String!,$d:AuthHookInput!){ updateAuthHook(id:$i, data:$d){ id } }`,
      { i: a.data?.createAuthHook.id, d: { event: "before-user-created" } },
    );
    expect(moved.errors?.[0]?.extensions?.code).toBe("CONFLICT");
  });

  test("an over-ceiling timeout is refused, not clamped", async () => {
    const res = await gql(`mutation($d:AuthHookInput!){ createAuthHook(data:$d){ id } }`, {
      d: {
        event: "send-email",
        targetType: "url",
        url: "https://app.example/h",
        onError: "deny",
        timeoutMs: 999999,
      },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("auth hooks — GraphQL is admin-gated", () => {
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

  test("every auth-hook field refuses an unauthenticated caller", async () => {
    // An auth hook can block sign-in and decide what is inside an access token,
    // so an unauthenticated read here would be both a disclosure and a map of
    // the workspace's admission gates.
    const probes = [
      `{ authHooks { id } }`,
      `mutation{ createAuthHook(data:{event:"send-email",targetType:"url",url:"https://a.test/h",onError:"deny"}){ id } }`,
      `mutation{ updateAuthHook(id:"x", data:{enabled:false}){ id } }`,
      `mutation{ deleteAuthHook(id:"x") }`,
      `mutation{ testAuthHook(id:"x"){ ok } }`,
    ];
    for (const q of probes) {
      const res = await anon(q);
      expect(["FORBIDDEN", "UNAUTHORIZED"]).toContain(res.errors?.[0]?.extensions?.code);
    }
  });
});

describe("auth hooks — REST is admin-gated", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });
  afterAll(() => h.cleanup());

  test("every route refuses an unauthenticated caller", async () => {
    const probes: Array<[string, RequestInit]> = [
      ["/api/admin/auth-hooks", {}],
      [
        "/api/admin/auth-hooks",
        json({ event: "send-email", targetType: "url", url: "https://a.test/h", onError: "deny" }),
      ],
      ["/api/admin/auth-hooks/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }],
      ["/api/admin/auth-hooks/x", { method: "DELETE" }],
      ["/api/admin/auth-hooks/x/test", { method: "POST" }],
    ];
    for (const [path, init] of probes) {
      const res = await h.fetch(path, init);
      expect([401, 403]).toContain(res.status);
    }
  });
});

describe("auth hooks — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("create → list → update → delete round-trips, secret excluded", async () => {
    const made = await client.authHooks.create({
      event: "custom-access-token",
      targetType: "url",
      url: "https://app.example/claims",
      onError: "deny",
      secret: SECRET,
    });
    expect(made.data.onError).toBe("deny");
    expect(made.data.hasSecret).toBe(true);

    const listed = await client.authHooks.list();
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed.data)).not.toContain(SECRET);

    const updated = await client.authHooks.update(made.data.id, { enabled: false });
    expect(updated.data.enabled).toBe(false);

    expect((await client.authHooks.delete(made.data.id)).ok).toBe(true);
    expect((await client.authHooks.list()).data).toEqual([]);
  });

  test("a function target round-trips with no url", async () => {
    const made = await client.authHooks.create({
      event: "before-user-created",
      targetType: "function",
      functionName: "admission",
      onError: "deny",
    });
    expect(made.data.targetType).toBe("function");
    expect(made.data.functionName).toBe("admission");
    expect(made.data.url).toBeNull();
    await client.authHooks.delete(made.data.id);
  });
});

describe("auth hooks — MCP surface", () => {
  test("the tool group covers the whole REST surface", () => {
    expect(authHooksTools.map((t) => t.name).sort()).toEqual([
      "auth_hooks.create",
      "auth_hooks.delete",
      "auth_hooks.list",
      "auth_hooks.test",
      "auth_hooks.update",
    ]);
  });

  test("create requires the event, the target kind and the failure policy", () => {
    const create = authHooksTools.find((t) => t.name === "auth_hooks.create")!;
    const schema = create.inputSchema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
      additionalProperties?: boolean;
    };
    // An agent must not be able to create a hook without stating the failure
    // policy — that is the decision the whole feature hinges on.
    expect(schema.required).toEqual(["event", "targetType", "onError"]);
    expect(schema.properties?.onError?.enum).toEqual(["allow", "deny"]);
    // The event list on the tool is the list the server actually fires, not a
    // hand-copied one that can go stale.
    expect(schema.properties?.event?.enum).toEqual([...AUTH_HOOK_EVENTS]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("every tool explains itself well enough for an agent to choose it", () => {
    for (const tool of authHooksTools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });
});
