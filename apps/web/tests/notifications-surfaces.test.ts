/**
 * Multi-surface parity for in-app notifications.
 *
 * The invariant every surface holds: **an administrator may notify anyone; a
 * non-admin may only notify themselves.** Without it the bell is a way for any
 * signed-in end user to put arbitrary text, and a URL, in front of every other
 * user of the workspace — a phishing surface built into the product.
 *
 * A broadcast (no `userId`) is the same privilege spelt differently, and is
 * refused the same way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { notificationsTools } from "../src/server/mcp/tools/notifications";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/notifications";

describe("notifications — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let adminId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    adminId = ((await (await h.fetch("/api/me")).json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => h.cleanup?.());

  test("SDK: send, list, count, mark read", async () => {
    const sent = await client.notifications.send({
      title: "Build finished",
      body: "Your export is ready",
      userId: adminId,
    });
    expect(typeof sent.data.id).toBe("string");

    const listed = await client.notifications.list();
    expect(listed.data.some((n) => n.id === sent.data.id)).toBe(true);

    const before = await client.notifications.unreadCount();
    expect(before.data.count).toBeGreaterThan(0);

    expect((await client.notifications.markRead(sent.data.id)).ok).toBe(true);
    const after = await client.notifications.unreadCount();
    expect(after.data.count).toBe(before.data.count - 1);
  });

  test("SDK: unreadOnly narrows the list rather than filtering it afterwards", async () => {
    const unread = await client.notifications.send({ title: "Still unread", userId: adminId });
    const read = await client.notifications.send({ title: "Already read", userId: adminId });
    await client.notifications.markRead(read.data.id);

    const listed = await client.notifications.list({ unread: true });
    expect(listed.data.some((n) => n.id === unread.data.id)).toBe(true);
    expect(listed.data.some((n) => n.id === read.data.id)).toBe(false);
  });

  test("markAllRead leaves nothing on the bell", async () => {
    await client.notifications.send({ title: "One", userId: adminId });
    await client.notifications.send({ title: "Two", userId: adminId });

    expect((await client.notifications.markAllRead()).ok).toBe(true);
    expect((await client.notifications.unreadCount()).data.count).toBe(0);
  });

  test("MCP: the tools an agent gets, including the push/SMS pair this module also owns", () => {
    const names = notificationsTools.map((t) => t.name).sort();
    expect(names).toContain("notifications.list");
    expect(names).toContain("notifications.send");
    expect(names).toContain("notifications.mark_read");
    // The other half of the module reaches the SDK through `messaging`, which
    // is why the parity registry names this module for `notifications`.
    expect(names).toContain("messaging.send_push");
  });

  test("the SDK points at routes that exist", async () => {
    const live = await client.notifications.send({ title: "Probe", userId: adminId });

    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeNotifications } = await import(
      "../../../packages/client/src/clients/notifications"
    );
    const n = makeNotifications(spy as never);
    await n.list({ limit: 5, unread: true });
    await n.unreadCount();
    await n.send({ title: "x" });
    await n.markRead(live.data.id);
    await n.markAllRead();
    expect(calls).toEqual([
      `GET ${BASE}?limit=5&unread=1`,
      `GET ${BASE}/_unread-count`,
      `POST ${BASE}`,
      `POST ${BASE}/${live.data.id}/read`,
      `POST ${BASE}/_read-all`,
    ]);

    // Dispatched for real against the LIVE id.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST" && path === BASE
          ? { body: JSON.stringify({ title: "probe", userId: adminId }) }
          : {}),
      });
      expect(`${call} → ${res.status}`).not.toContain("404");
    }
  });

  test("a non-admin may notify themselves and nobody else", async () => {
    // Signing up a second account switches the harness's session to it; this
    // user lands as `authenticated`, not admin.
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `plain-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Plain User",
      }),
    });
    expect(su.status).toBe(200);
    const myId = ((await (await h.fetch("/api/me")).json()) as { data: { id: string } }).data.id;
    expect(myId).not.toBe(adminId);

    // Positive control: without it, the refusals below could equally mean the
    // endpoint is broken for this user entirely.
    const own = await client.notifications.send({ title: "Note to self", userId: myId });
    expect(typeof own.data.id).toBe("string");

    // Someone else — refused.
    await expect(
      client.notifications.send({ title: "Phish", url: "https://evil.test", userId: adminId }),
    ).rejects.toBeDefined();

    // Omitting the target does NOT broadcast. The guard only fires on an
    // explicit foreign `userId`, and the insert falls back to the calling
    // identity — so the omission lands on the sender's own bell rather than
    // sailing past the check onto everyone else's. Closed, but only by the
    // fallback, which is why it is pinned: someone removing the `??
    // auth.userId` would turn this into a workspace-wide phishing surface
    // without touching the authorization line that looks like the guard.
    const omitted = await client.notifications.send({
      title: "No target given",
      url: "https://evil.test",
    });
    expect(typeof omitted.data.id).toBe("string");
    const mine = await client.notifications.list({ limit: 50 });
    const landed = mine.data.find((n) => n.id === omitted.data.id);
    // `userId === myId` is the assertion that separates the two outcomes. The
    // listing returns rows targeted at the caller PLUS broadcasts, so a row
    // that had become a broadcast would still show up here — carrying a null
    // `userId`. Asserting it is present would therefore prove nothing; that it
    // is addressed to this user is the whole finding.
    expect(landed?.userId).toBe(myId);

    // And nothing this user sent is addressed to the administrator.
    expect(mine.data.some((n) => n.userId === adminId)).toBe(false);
  });
});
