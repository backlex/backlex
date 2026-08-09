/**
 * Multi-surface parity for broadcast channels.
 *
 * REST is the reference. The invariants that have to hold on EVERY surface,
 * because a channel that is closed over REST and open over GraphQL is worse
 * than one that was never gated:
 *   1. an unmatched channel is refused, in both directions;
 *   2. reading a channel's history needs the SAME subscribe access a live
 *      subscription needs — GraphQL hand-builds its own resolvers and has
 *      repeatedly been the surface that skipped a guard;
 *   3. the sender identity is stamped server-side wherever a publish enters;
 *   4. rule CRUD is admin-only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { channelsTools } from "../src/server/mcp/tools/channels";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("broadcast channels — GraphQL surface", () => {
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

  test("create → list → explain → update → delete round-trips", async () => {
    const made = await gql(
      `mutation($d:BroadcastChannelRuleInput!){
         createBroadcastChannel(data:$d){ id pattern presence replay retentionHours enabled
           subscribe { access roles } publish { access } } }`,
      {
        d: {
          name: "Rooms",
          pattern: "room:{room}",
          subscribe: { access: "authenticated" },
          publish: { access: "roles", roles: ["admin"] },
          replay: true,
          retentionHours: 6,
        },
      },
    );
    expect(made.errors).toBeUndefined();
    const id = made.data?.createBroadcastChannel.id as string;
    expect(made.data?.createBroadcastChannel.publish.access).toBe("roles");

    const listed = await gql(`{ broadcastChannels { id pattern } }`);
    expect(listed.data?.broadcastChannels).toHaveLength(1);

    const explained = await gql(
      `query($c:String!){ channelExplain(channel:$c){ matched { pattern } params canSubscribe canPublish } }`,
      { c: "room:lobby" },
    );
    expect(explained.data?.channelExplain.matched.pattern).toBe("room:{room}");
    expect(explained.data?.channelExplain.params).toEqual({ room: "lobby" });
    expect(explained.data?.channelExplain.canSubscribe).toBe(true);

    const updated = await gql(
      `mutation($i:String!,$d:BroadcastChannelRuleInput!){ updateBroadcastChannel(id:$i, data:$d){ enabled } }`,
      { i: id, d: { enabled: false } },
    );
    expect(updated.data?.updateBroadcastChannel.enabled).toBe(false);

    const gone = await gql(`mutation($i:String!){ deleteBroadcastChannel(id:$i) }`, { i: id });
    expect(gone.errors).toBeUndefined();
    expect((await gql(`{ broadcastChannels { id } }`)).data?.broadcastChannels).toHaveLength(0);
  });

  test("history refuses a channel the caller may not subscribe to", async () => {
    // The rule exists but nobody satisfies it — so the guard, not the absence
    // of a rule, is what has to refuse. This is the assertion that would fail
    // if the GraphQL resolver read the log without re-checking access.
    await gql(
      `mutation($d:BroadcastChannelRuleInput!){ createBroadcastChannel(data:$d){ id } }`,
      {
        d: {
          name: "Locked",
          pattern: "locked:feed",
          subscribe: { access: "roles", roles: ["nobody-holds-this"] },
          publish: { access: "none" },
          replay: true,
        },
      },
    );
    const res = await gql(`query($c:String!){ channelHistory(channel:$c){ cursor } }`, {
      c: "locked:feed",
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  test("history refuses a channel with no rule at all", async () => {
    const res = await gql(`query($c:String!){ channelHistory(channel:$c){ cursor } }`, {
      c: "unruled:feed",
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  test("rule CRUD is admin-only on this surface too", async () => {
    // A fresh, session-less request: `requireFlowAdmin` is the shared gate, and
    // this is what proves GraphQL actually calls it.
    const res = (await (
      await h.app.request(
        "/api/graphql",
        {
          ...json({ query: `{ broadcastChannels { id } }` }),
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        } as RequestInit,
        h.env,
      )
    ).json()) as { errors?: { extensions?: { code?: string } }[] };
    expect(res.errors?.[0]?.extensions?.code).toBeDefined();
  });
});

describe("broadcast channels — MCP surface", () => {
  test("every REST verb has a tool, and the schemas name what the pattern grammar allows", () => {
    const names = channelsTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "channels.create",
      "channels.delete",
      "channels.explain",
      "channels.history",
      "channels.list",
      "channels.publish",
      "channels.update",
    ]);
    const create = channelsTools.find((t) => t.name === "channels.create")!;
    // The access enum is the contract an agent has to get right; if it drifts
    // from `ChannelAccessKind` the agent silently writes a rule that means
    // "nobody" instead of what it intended.
    const access = (create.inputSchema as any).properties.subscribe.properties.access.enum;
    expect(access).toEqual(["none", "public", "authenticated", "roles"]);
    expect(create.description).toContain("{name}");
  });

  test("history's limit matches the server's page cap", () => {
    const history = channelsTools.find((t) => t.name === "channels.history")!;
    expect((history.inputSchema as any).properties.limit.maximum).toBe(25);
  });
});

describe("broadcast channels — SDK surface", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("the SDK reaches the same endpoints the CLI and admin do", async () => {
    // Rather than booting a network client, assert the paths the SDK builds —
    // the failure this catches is a client pointed at a route that does not
    // exist, which typechecks perfectly.
    const { makeChannels } = await import("../../../packages/client/src/clients/channels");
    const calls: Array<[string, string, unknown]> = [];
    const core = {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push([method, path, body]);
        return {} as never;
      },
    } as never;
    const channels = makeChannels(core);
    await channels.list();
    await channels.create({} as never);
    await channels.update("r1", {});
    await channels.delete("r1");
    await channels.publish("chat:room", { hi: true }, "greeting");
    await channels.presence("chat:room", "hello", { cursor: 1 });
    await channels.history("chat:room", { since: "1.a", limit: 5 });
    await channels.explain("chat:room");

    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "GET /api/admin/realtime-channels",
      "POST /api/admin/realtime-channels",
      "PATCH /api/admin/realtime-channels/r1",
      "DELETE /api/admin/realtime-channels/r1",
      "POST /api/realtime/chat%3Aroom/publish",
      "POST /api/realtime/chat%3Aroom/publish",
      "GET /api/realtime/chat%3Aroom/replay?since=1.a&limit=5",
      "GET /api/realtime/chat%3Aroom/explain",
    ]);
    // A presence call must be distinguishable from a message on the wire, or
    // the server would retain it.
    expect(calls[5]![2]).toMatchObject({ kind: "presence", t: "hello" });
  });

  test("those SDK paths are routes that actually exist", async () => {
    // Percent-encoded channel names have to survive routing — `chat:room`
    // encodes to `chat%3Aroom`, and a route that only matched the raw form
    // would 404 for every SDK caller while passing every hand-written test.
    const res = await h.fetch("/api/realtime/chat%3Aroom/explain");
    expect(res.status).toBe(200);
  });
});
