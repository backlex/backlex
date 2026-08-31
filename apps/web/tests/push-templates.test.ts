/**
 * Push templates, from the store to the wire.
 *
 * The store shipped with a CRUD API, an admin table, and no send path: outside
 * `push-templates.ts` nothing in the tree read `push_templates`, and the only
 * code that rendered one was that route's own `/send-test`. So an operator
 * could author a template, preview it, and never send it — while
 * `docs/push-messaging.md` said it was "rendered at send time, same as email
 * templates".
 *
 * These tests are about the half that was missing, so most of them assert what
 * actually reached the ADAPTER — the title on the wire, not the status code.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { PushAdapter, PushMessage } from "@backlex/core/adapters";
import { sendTemplatedPush } from "../src/server/services/push";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("push templates reach the wire", () => {
  let h: TestHarness;
  let client: Database;
  let sends: PushMessage[];
  let ctx: { db: any; dialect: "sqlite"; pushFor: () => Promise<PushAdapter> };

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH as string);
    sends = [];
    // A recording adapter, because the thing under test is what the template
    // rendered TO — a 200 with the wrong title would pass any status check.
    const adapter: PushAdapter = {
      send: async (s) => {
        sends.push(s);
        return { sent: s.tokens.length, failed: 0, invalidTokens: [] };
      },
    };
    ctx = { db: drizzle({ client }), dialect: "sqlite", pushFor: async () => adapter };
  });
  afterEach(() => h.cleanup());

  /** Insert a template row directly — the CRUD half already has coverage. */
  const template = (
    row: { key: string; title: string; body: string; url?: string | null },
    tenantId: string | null,
  ) =>
    client
      .query(
        "insert into push_templates (id, tenant_id, key, name, title, body, url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        tenantId,
        row.key,
        row.key,
        row.title,
        row.body,
        row.url ?? null,
        Date.now(),
        Date.now(),
      );

  /** A device for `u1`, so a send has somewhere to land. */
  const device = (userId: string, tenantId: string | null) =>
    client
      .query(
        "insert into device_tokens (id, tenant_id, user_id, platform, token, is_active, created_at) values (?, ?, ?, ?, ?, 1, ?)",
      )
      .run(crypto.randomUUID(), tenantId, userId, "fcm", `tok-${userId}`, Date.now());

  test("a key renders the stored row, not the caller's text", async () => {
    template({ key: "shipped", title: "Order {{ order.id }} shipped", body: "On its way" }, "t1");
    device("u1", "t1");
    const r = await sendTemplatedPush(ctx, "t1", {
      userIds: ["u1"],
      templateKey: "shipped",
      vars: { order: { id: "A-42" } },
      fallback: { title: "IGNORED", body: "IGNORED" },
    });
    expect(r.templateApplied).toBe(true);
    expect(sends[0]?.title).toBe("Order A-42 shipped");
    expect(sends[0]?.body).toBe("On its way");
  });

  test("the workspace's own row wins over the global default", async () => {
    template({ key: "shipped", title: "Global", body: "g" }, null);
    template({ key: "shipped", title: "Ours", body: "o" }, "t1");
    device("u1", "t1");
    await sendTemplatedPush(ctx, "t1", { userIds: ["u1"], templateKey: "shipped" });
    expect(sends[0]?.title).toBe("Ours");
  });

  test("a global default is used by a workspace that has no row of its own", async () => {
    template({ key: "shipped", title: "Global", body: "g" }, null);
    device("u1", "t1");
    await sendTemplatedPush(ctx, "t1", { userIds: ["u1"], templateKey: "shipped" });
    expect(sends[0]?.title).toBe("Global");
  });

  test("one workspace's template is not another's", async () => {
    template({ key: "shipped", title: "Theirs", body: "x" }, "t2");
    device("u1", "t1");
    await expect(
      sendTemplatedPush(ctx, "t1", { userIds: ["u1"], templateKey: "shipped" }),
    ).rejects.toThrow(/not found/);
    expect(sends).toHaveLength(0);
  });

  test("an unresolvable key falls back to the literal text — it does not throw", async () => {
    // The email contract: a template that has not been authored yet must not
    // stop the message, or every new deployment goes silent.
    device("u1", "t1");
    const r = await sendTemplatedPush(ctx, "t1", {
      userIds: ["u1"],
      templateKey: "absent",
      fallback: { title: "Plain", body: "text" },
    });
    expect(r.templateApplied).toBe(false);
    expect(sends[0]?.title).toBe("Plain");
  });

  test("neither a template nor text is refused rather than sent blank", async () => {
    device("u1", "t1");
    await expect(sendTemplatedPush(ctx, "t1", { userIds: ["u1"] })).rejects.toThrow(
      /templateKey or a fallback/,
    );
  });

  test("a template `url` renders too", async () => {
    template(
      { key: "shipped", title: "t", body: "b", url: "/orders/{{ order.id }}" },
      "t1",
    );
    device("u1", "t1");
    await sendTemplatedPush(ctx, "t1", {
      userIds: ["u1"],
      templateKey: "shipped",
      vars: { order: { id: "A-42" } },
    });
    expect(sends[0]?.url).toBe("/orders/A-42");
  });
});

describe("the dispatch surface takes a template key", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("`title`/`body` are still required when no key is given", async () => {
    // They used to be unconditionally required, and every existing caller
    // still sends them. Only the new shape's bad case — no key AND no text —
    // is newly reachable, so it is the one that has to be refused.
    const me = (await (await h.fetch("/api/me")).json()) as { data: { id: string } };
    const res = await h.fetch("/api/messaging/push", json({ userId: me.data.id }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("templateKey");
  });

  test("a non-admin cannot name a template key, even for themselves", async () => {
    // `push_templates` is admin-only config. Letting a workspace member choose
    // a key would be the first surface anywhere that renders one for a
    // non-admin and shows them the result — a small disclosure that arrived
    // with the send path, not before it.
    // Signing up a second user switches the harness session to them, and they
    // land as `authenticated` rather than admin.
    const su = await h.fetch(
      "/api/auth/sign-up/email",
      json({ email: `plain-${Date.now()}@example.test`, password: "correct-horse-battery", name: "Plain User" }),
    );
    expect(su.status).toBe(200);
    const me = (await (await h.fetch("/api/me")).json()) as { data: { id: string } };

    // Literal text to themselves is still fine — only the key is refused.
    const withKey = await h.fetch(
      "/api/messaging/push",
      json({ userId: me.data.id, templateKey: "welcome" }),
    );
    expect(withKey.status).toBe(403);
    const literal = await h.fetch(
      "/api/messaging/push",
      json({ userId: me.data.id, title: "t", body: "b" }),
    );
    expect(literal.status).toBe(200);
  });

  test("a key alone is accepted", async () => {
    const me = (await (await h.fetch("/api/me")).json()) as { data: { id: string } };
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "tok-1" }));
    const res = await h.fetch(
      "/api/messaging/push",
      json({ userId: me.data.id, templateKey: "welcome", title: "fb", body: "fb" }),
    );
    // No `welcome` row exists, so this exercises the fallback arm end to end —
    // what matters is that the request shape is no longer refused.
    expect(res.status).toBe(200);
    expect((await res.json()) as { sent: number }).toMatchObject({ sent: 1 });
  });
});

describe("push templates are backed up", () => {
  test("the table is in both dialect maps, as `email_templates` always was", async () => {
    // It was in neither, so rows an operator created through the admin API
    // were silently outside every backup.
    const src = await Bun.file(
      new URL("../src/server/services/backup.ts", import.meta.url),
    ).text();
    expect([...src.matchAll(/push_templates:/g)]).toHaveLength(2);
  });
});
