/**
 * Sync hook admin API.
 *
 * The assertion that matters most here is negative: there must be NO way for an
 * API caller to create a `tenant_id = NULL` hook. Such a hook is instance-wide
 * and receives the pending row data of every workspace, so a workspace admin
 * who could reach it would have a read channel into everyone else's writes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;

const BASE = "/api/admin/sync-hooks";

const post = (path: string, body: unknown, method = "POST") =>
  h.fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VALID = {
  name: "tax",
  url: "https://app.example/tax",
  events: ["orders.beforeCreate"],
  onError: "deny" as const,
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterAll(() => h.cleanup());

describe("workspace scoping", () => {
  test("a created hook is bound to the caller's workspace, never instance-wide", async () => {
    const res = await post(BASE, VALID);
    expect(res.status).toBe(201);
    const id = ((await res.json()) as any).data.id as string;

    const row = client
      .query("select tenant_id as tenantId from sync_hooks where id = ?")
      .get(id) as { tenantId: string | null };
    expect(row.tenantId).not.toBeNull();
  });

  test("a caller-supplied tenantId is ignored, not honoured", async () => {
    // The service takes `tenantId: string` from the session, so this key has
    // nowhere to land — but assert it explicitly, because the day someone
    // widens the input schema this is the test that should fail.
    const res = await post(BASE, { ...VALID, name: "sneaky", tenantId: null });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as any).data.id as string;
    const row = client
      .query("select tenant_id as tenantId from sync_hooks where id = ?")
      .get(id) as { tenantId: string | null };
    expect(row.tenantId).not.toBeNull();
  });

  test("no route can produce a null-tenant hook", () => {
    const nulls = client
      .query("select count(*) as n from sync_hooks where tenant_id is null")
      .get() as { n: number };
    expect(nulls.n).toBe(0);
  });
});

describe("cross-workspace access", () => {
  test("another workspace's hook cannot be read, updated, deleted or tested", async () => {
    // Insert a hook owned by a different workspace directly, then try to reach
    // it as this workspace's admin. Every path must behave as "not found".
    const foreignId = crypto.randomUUID();
    client
      .query(
        `insert into sync_hooks (id, tenant_id, name, url, events, timeout_ms, on_error,
          can_mutate, priority, enabled, consecutive_failures, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        foreignId, "some-other-tenant", "foreign", "https://evil.example/x",
        JSON.stringify(["*"]), 2000, "deny", 0, 0, 1, 0, Date.now(), Date.now(),
      );

    const list = (await (await h.fetch(BASE)).json()) as any;
    expect(list.data.some((row: { id: string }) => row.id === foreignId)).toBe(false);

    expect((await post(`${BASE}/${foreignId}`, { name: "hijacked" }, "PATCH")).status).toBe(404);
    expect((await post(`${BASE}/${foreignId}/test`, {})).status).toBe(404);

    // DELETE is a no-op rather than an error, but it must not remove the row.
    await h.fetch(`${BASE}/${foreignId}`, { method: "DELETE" });
    const still = client
      .query("select name from sync_hooks where id = ?")
      .get(foreignId) as { name: string } | null;
    expect(still?.name).toBe("foreign");

    client.query("delete from sync_hooks where id = ?").run(foreignId);
  });
});

describe("validation", () => {
  test("onError is required — there is no safe default to fall back on", async () => {
    const { onError: _drop, ...withoutOnError } = VALID;
    const res = await post(BASE, withoutOnError);
    expect(res.status).toBe(422);
  });

  test("onError only accepts allow or deny", async () => {
    expect((await post(BASE, { ...VALID, onError: "maybe" })).status).toBe(422);
  });

  test("at least one event is required", async () => {
    expect((await post(BASE, { ...VALID, events: [] })).status).toBe(422);
  });

  test("a timeout beyond the ceiling is refused rather than silently clamped", async () => {
    // Clamping at the API layer would let a caller believe they got 60s.
    expect((await post(BASE, { ...VALID, timeoutMs: 999_999 })).status).toBe(422);
  });

  test("a non-URL target is refused", async () => {
    expect((await post(BASE, { ...VALID, url: "not a url" })).status).toBe(422);
  });
});

describe("secrets", () => {
  test("the signing secret is never returned, only its presence", async () => {
    const res = await post(BASE, { ...VALID, name: "signed", secret: "TOP-SECRET-HOOK-KEY" });
    const body = (await res.json()) as any;
    expect(body.data.hasSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("TOP-SECRET-HOOK-KEY");

    const list = (await (await h.fetch(BASE)).json()) as any;
    expect(JSON.stringify(list)).not.toContain("TOP-SECRET-HOOK-KEY");
  });

  test("an omitted secret on update keeps the stored one", async () => {
    const created = (await (await post(BASE, { ...VALID, name: "keep", secret: "orig" })).json()) as any;
    const id = created.data.id as string;
    await post(`${BASE}/${id}`, { name: "renamed" }, "PATCH");
    const row = client.query("select secret from sync_hooks where id = ?").get(id) as {
      secret: string | null;
    };
    // The UI cannot read it back, so a blank field must not blank the credential.
    expect(row.secret).toBe("orig");
  });
});

describe("lifecycle", () => {
  test("re-enabling clears the breaker so it does not trip again instantly", async () => {
    const created = (await (await post(BASE, { ...VALID, name: "breaker" })).json()) as any;
    const id = created.data.id as string;
    client
      .query(
        "update sync_hooks set enabled = 0, consecutive_failures = 15, disabled_reason = 'x' where id = ?",
      )
      .run(id);

    const res = await post(`${BASE}/${id}`, { enabled: true }, "PATCH");
    const body = (await res.json()) as any;
    expect(body.data.enabled).toBe(true);
    expect(body.data.consecutiveFailures).toBe(0);
    expect(body.data.disabledReason).toBeNull();
  });

  test("delete removes it and writes stop being gated", async () => {
    const created = (await (await post(BASE, { ...VALID, name: "gone" })).json()) as any;
    const id = created.data.id as string;
    expect((await h.fetch(`${BASE}/${id}`, { method: "DELETE" })).status).toBe(200);
    const row = client.query("select count(*) as n from sync_hooks where id = ?").get(id) as {
      n: number;
    };
    expect(row.n).toBe(0);
  });

  test("updating a hook that does not exist is NOT_FOUND", async () => {
    expect((await post(`${BASE}/nope`, { name: "x" }, "PATCH")).status).toBe(404);
  });
});

describe("auth", () => {
  test("every endpoint refuses an unauthenticated caller", async () => {
    const anon = makeHarness();
    try {
      for (const [method, path] of [
        ["GET", BASE],
        ["POST", BASE],
        ["PATCH", `${BASE}/x`],
        ["DELETE", `${BASE}/x`],
        ["POST", `${BASE}/x/test`],
      ] as const) {
        const res = await anon.fetch(path, {
          method,
          ...(method === "GET" || method === "DELETE"
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(VALID) }),
        });
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
    } finally {
      anon.cleanup();
    }
  });
});
