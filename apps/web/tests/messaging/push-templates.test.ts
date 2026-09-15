/**
 * Push templates, from the store to the wire.
 *
 * The store shipped with a CRUD API, an admin table, and no send path: outside
 * `push/templates.ts` nothing in the tree read `push_templates`, and the only
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
import { sendTemplatedPush } from "../../src/server/services/messaging/push";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

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

describe("shared defaults are copy-on-write", () => {
  // PATCH and DELETE used to scope by `id AND (tenant_id = ? OR tenant_id IS
  // NULL)`, so a workspace admin could rewrite or delete an instance-wide row for
  // every workspace. It was latent only because nothing seeds one — so the shared
  // row is planted around the API here, and asserted in the database itself
  // rather than through the API that used to be the problem (#385).
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  interface Row {
    id: string;
    tenantId: string | null;
    key: string;
    name: string;
    title: string;
    body: string;
    url: string | null;
    inherited: boolean;
    overridesDefault: boolean;
  }

  const harnessWithDefault = async (): Promise<TestHarness> => {
    const harness = makeHarness();
    await seedAdmin(harness);
    const db = new Database(harness.env.SQLITE_PATH as string);
    try {
      db.query(
        "insert into push_templates (id, tenant_id, key, name, title, body, url, created_at, updated_at) values (?, NULL, 'shipped', 'Order shipped', 'Order {{ order.id }} shipped', 'On its way', '/orders/{{ order.id }}', ?, ?)",
      ).run(crypto.randomUUID(), Date.now(), Date.now());
    } finally {
      db.close();
    }
    return harness;
  };

  const sharedRow = (harness: TestHarness) => {
    const db = new Database(harness.env.SQLITE_PATH as string);
    try {
      return db
        .query("select id, title, body, url from push_templates where tenant_id is null and key = 'shipped'")
        .get() as { id: string; title: string; body: string; url: string | null } | null;
    } finally {
      db.close();
    }
  };

  const list = async (harness: TestHarness, headers: Record<string, string> = {}) => {
    const res = await harness.fetch("/api/admin/push-templates", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Row[] }).data;
  };

  test("the list shows one row per key, and the shared row reads as inherited", async () => {
    h = await harnessWithDefault();
    const rows = (await list(h)).filter((r) => r.key === "shipped");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inherited).toBe(true);
    expect(rows[0]!.overridesDefault).toBe(false);
  });

  test("saving a default creates the workspace's copy and leaves the shared row alone", async () => {
    h = await harnessWithDefault();
    const before = sharedRow(h)!;
    expect(before).not.toBeNull();

    const res = await h.fetch(
      `/api/admin/push-templates/${before.id}`,
      json({ title: "Workspace wording" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { data: Row }).data;
    expect(saved.id).not.toBe(before.id);
    expect(saved.tenantId).not.toBeNull();
    expect(saved.key).toBe("shipped");
    expect(saved.title).toBe("Workspace wording");
    // Everything the patch did not name is copied from the default, not blanked.
    expect(saved.body).toBe(before.body);
    expect(saved.url).toBe(before.url);
    expect(saved.overridesDefault).toBe(true);
    expect(sharedRow(h)).toEqual(before);

    const rows = (await list(h)).filter((r) => r.key === "shipped");
    expect(rows.map((r) => r.id)).toEqual([saved.id]);

    // A stale tab still holding the SHARED id saves into the same copy rather
    // than colliding with it on the (tenant_id, key) unique index.
    const again = await h.fetch(
      `/api/admin/push-templates/${before.id}`,
      json({ title: "Second save" }, "PATCH"),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: Row }).data.id).toBe(saved.id);
    expect(sharedRow(h)).toEqual(before);
  });

  test("another workspace keeps rendering the default", async () => {
    h = await harnessWithDefault();
    const other = await h.fetch("/api/tenants", json({ name: `Other ${`${Date.now()}`.slice(-6)}` }));
    expect(other.status).toBe(201);
    const theirs = ((await other.json()) as { data: { id: string; slug: string } }).data;

    const res = await h.fetch(
      `/api/admin/push-templates/${sharedRow(h)!.id}`,
      json({ title: "Only here" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const mine = ((await res.json()) as { data: Row }).data.tenantId!;
    expect(mine).not.toBe(theirs.id);

    const listed = (await list(h, { "X-Backlex-Tenant": theirs.slug })).find((r) => r.key === "shipped");
    expect(listed?.title).toBe("Order {{ order.id }} shipped");
    expect(listed?.inherited).toBe(true);

    // And what actually reaches each workspace's devices, not only the listing.
    const client = new Database(h.env.SQLITE_PATH as string);
    try {
      const sends: PushMessage[] = [];
      const adapter: PushAdapter = {
        send: async (s) => {
          sends.push(s);
          return { sent: s.tokens.length, failed: 0, invalidTokens: [] };
        },
      };
      // Typed like the recording ctx above: a schema-less drizzle handle is not
      // the app's `DbCtx`, and the service only needs its query builder.
      const ctx: { db: any; dialect: "sqlite"; pushFor: () => Promise<PushAdapter> } = {
        db: drizzle({ client }),
        dialect: "sqlite",
        pushFor: async () => adapter,
      };
      for (const tenantId of [mine, theirs.id]) {
        client
          .query(
            "insert into device_tokens (id, tenant_id, user_id, platform, token, is_active, created_at) values (?, ?, 'u1', 'fcm', ?, 1, ?)",
          )
          .run(crypto.randomUUID(), tenantId, `tok-${tenantId}`, Date.now());
      }
      const vars = { order: { id: "A-42" } };
      await sendTemplatedPush(ctx, mine, { userIds: ["u1"], templateKey: "shipped", vars });
      await sendTemplatedPush(ctx, theirs.id, { userIds: ["u1"], templateKey: "shipped", vars });
      expect(sends.map((s) => s.title)).toEqual(["Only here", "Order A-42 shipped"]);
    } finally {
      client.close();
    }
  });

  test("a default cannot be re-keyed or deleted from a workspace", async () => {
    h = await harnessWithDefault();
    const shared = sharedRow(h)!;

    const rekey = await h.fetch(`/api/admin/push-templates/${shared.id}`, json({ key: "shipped_v2" }, "PATCH"));
    expect(rekey.status).toBe(422);

    const del = await h.fetch(`/api/admin/push-templates/${shared.id}`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(sharedRow(h)).toEqual(shared);
  });

  test("deleting the copy restores the default, and says which row now applies", async () => {
    h = await harnessWithDefault();
    const shared = sharedRow(h)!;
    const saved = (
      (await (
        await h.fetch(`/api/admin/push-templates/${shared.id}`, json({ title: "Mine" }, "PATCH"))
      ).json()) as { data: Row }
    ).data;

    const del = await h.fetch(`/api/admin/push-templates/${saved.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const restored = ((await del.json()) as { data: Row | null }).data;
    expect(restored?.id).toBe(shared.id);
    expect(restored?.inherited).toBe(true);
    expect((await list(h)).find((r) => r.key === "shipped")?.id).toBe(shared.id);
  });

  test("creating under a default's key is the override, and a key the workspace owns is a 409", async () => {
    h = await harnessWithDefault();
    const input = { key: "shipped", name: "Ours", title: "Ours", body: "o" };
    const created = await h.fetch("/api/admin/push-templates", json(input));
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { data: Row }).data;
    expect(row.tenantId).not.toBeNull();
    expect(row.overridesDefault).toBe(true);

    const dupe = await h.fetch("/api/admin/push-templates", json(input));
    expect(dupe.status).toBe(409);
    expect((await list(h)).filter((r) => r.key === "shipped").map((r) => r.id)).toEqual([row.id]);
  });

  test("an unknown id is a 404 on every verb that takes one", async () => {
    h = await harnessWithDefault();
    const missing = crypto.randomUUID();
    const patch = await h.fetch(`/api/admin/push-templates/${missing}`, json({ title: "x" }, "PATCH"));
    expect(patch.status).toBe(404);
    const del = await h.fetch(`/api/admin/push-templates/${missing}`, { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});

describe("push templates are backed up", () => {
  test("the table is in both dialect maps, as `email_templates` always was", async () => {
    // It was in neither, so rows an operator created through the admin API
    // were silently outside every backup.
    const src = await Bun.file(
      new URL("../../src/server/services/backup.ts", import.meta.url),
    ).text();
    expect([...src.matchAll(/push_templates:/g)]).toHaveLength(2);
  });
});
