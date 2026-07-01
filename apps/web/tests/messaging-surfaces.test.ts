/**
 * Multi-surface parity for direct messaging dispatch (push + SMS). MCP tools
 * (`messaging.send_push` / `messaging.send_sms`) already exist in
 * mcp/tools/notifications.ts; this pins the REST endpoints
 * (`/api/messaging/{push,sms}`), the GraphQL mutations (`sendPush`/`sendSms`),
 * and the SDK (`client.messaging.sendPush/sendSms`) to the same semantics:
 * dispatch-only (no in-app notification row), admin-or-self targeting, silent
 * no-op for recipients with nothing registered. Sends land on the console
 * adapters, which report one `sent` per registered device/number.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const myId = async (h: TestHarness): Promise<string> => {
  const me = await h.fetch("/api/me");
  return ((await me.json()) as { data: { id: string } }).data.id;
};

/** Second cookie-jar over the SAME database — signs up a non-admin member. */
const makeMember = async (h: TestHarness): Promise<TestHarness> => {
  const member = makeHarness({ SQLITE_PATH: h.env.SQLITE_PATH });
  const res = await member.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `msg-member-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      password: "correct-horse-battery",
      name: "Member",
    }),
  });
  if (!res.ok) throw new Error(`member sign-up failed: ${res.status}`);
  return member;
};

describe("messaging — REST surface", () => {
  let h: TestHarness;
  let adminId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    adminId = await myId(h);
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "rest-tok" }));
    await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155550101" }));
  });
  afterAll(() => h.cleanup());

  test("POST /api/messaging/push dispatches without an in-app row", async () => {
    const res = await h.fetch(
      "/api/messaging/push",
      json({ userId: adminId, title: "Hello", body: "from REST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number; failed: number };
    expect(body).toEqual({ ok: true, sent: 1, failed: 0 });

    // Dispatch-only: unlike /api/notifications?push=true, no in-app row.
    const inbox = await h.fetch("/api/notifications");
    expect(((await inbox.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  test("POST /api/messaging/push validates title/body", async () => {
    const res = await h.fetch("/api/messaging/push", json({ userId: adminId, title: "" }));
    expect(res.status).toBe(400);
  });

  test("a recipient with no devices is a silent no-op (sent: 0)", async () => {
    const member = await makeMember(h);
    const targetId = await myId(member);
    const res = await h.fetch(
      "/api/messaging/push",
      json({ userId: targetId, title: "Hi", body: "nobody home" }),
    );
    expect(((await res.json()) as { sent: number }).sent).toBe(0);
  });

  test("non-admins can only message themselves", async () => {
    const member = await makeMember(h);
    const selfId = await myId(member);
    const other = await member.fetch(
      "/api/messaging/push",
      json({ userId: adminId, title: "sneaky", body: "nope" }),
    );
    expect(other.status).toBe(403);
    const self = await member.fetch(
      "/api/messaging/push",
      json({ userId: selfId, title: "note to self", body: "ok" }),
    );
    expect(self.status).toBe(200);
  });
});

describe("messaging — GraphQL surface", () => {
  let h: TestHarness;
  let adminId: string;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, { ok: boolean; sent: number; failed: number }>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    adminId = await myId(h);
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "gql-tok" }));
    await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155550102" }));
  });
  afterAll(() => h.cleanup());

  test("sendPush mutation dispatches to registered devices", async () => {
    const res = await gql(
      `mutation($u:ID!){ sendPush(userId:$u, title:"Hello", body:"from GraphQL"){ ok sent failed } }`,
      { u: adminId },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.sendPush).toEqual({ ok: true, sent: 1, failed: 0 });
  });

  test("sendSms mutation dispatches to registered numbers", async () => {
    const res = await gql(
      `mutation($u:ID!){ sendSms(userId:$u, body:"sms from GraphQL"){ ok sent failed } }`,
      { u: adminId },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.sendSms).toEqual({ ok: true, sent: 1, failed: 0 });
  });

  test("non-admins are FORBIDDEN from targeting other users", async () => {
    const member = await makeMember(h);
    const res = (await (
      await member.fetch(
        "/api/graphql",
        json({
          query: `mutation($u:ID!){ sendPush(userId:$u, title:"x", body:"y"){ ok } }`,
          variables: { u: adminId },
        }),
      )
    ).json()) as { errors?: { extensions?: { code?: string } }[] };
    expect(res.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});

describe("messaging — SDK surface", () => {
  let h: TestHarness;
  let adminId: string;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    adminId = await myId(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("registerDevice → sendPush → sendSms round-trips", async () => {
    const dev = await client.messaging.registerDevice({ platform: "fcm", token: "sdk-tok" });
    expect(dev.data.id).toBeTruthy();
    await client.messaging.registerPhone({ phoneNumber: "+14155550103" });

    const push = await client.messaging.sendPush({
      userId: adminId,
      title: "Hello",
      body: "from the SDK",
    });
    expect(push).toEqual({ ok: true, sent: 1, failed: 0 });

    const sms = await client.messaging.sendSms({ userId: adminId, body: "sms from the SDK" });
    expect(sms).toEqual({ ok: true, sent: 1, failed: 0 });
  });
});
