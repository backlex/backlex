import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Internal sandbox RPC bridge — `POST /api/_internal/sandbox-rpc`
 * (routes/sandbox-rpc.ts). Used only by the remote-http function executor to
 * proxy `ctx.fetch / ctx.db / ctx.email` back into the main app. Pins the
 * access control:
 *  - no `SANDBOX_RPC_TOKEN` configured → 403 (endpoint disabled entirely),
 *  - token configured but missing/wrong bearer → 401,
 *  - correct bearer + malformed body → 422 (Zod),
 *  - correct bearer + valid body → the dispatcher runs; op-level failures
 *    come back as HTTP 200 `{ ok:false, error }` (the executor's proxy turns
 *    that body into a thrown Error — the transport itself succeeded).
 */

const RPC_PATH = "/api/_internal/sandbox-rpc";
const TOKEN = "test-sandbox-rpc-token";

const VALID_BODY = {
  op: "fetch",
  args: { url: "https://example.com/" },
  auth: { userId: null, email: null, roles: [] },
};

const rpc = (
  h: TestHarness,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  h.fetch(RPC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("sandbox RPC — disabled without SANDBOX_RPC_TOKEN", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = makeHarness(); // no SANDBOX_RPC_TOKEN in env
  });
  afterAll(() => h.cleanup());

  test("any request is 403, even with a bearer token", async () => {
    const bare = await rpc(h, VALID_BODY);
    expect(bare.status).toBe(403);
    const body = (await bare.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("SANDBOX_RPC_TOKEN");

    const withToken = await rpc(h, VALID_BODY, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(withToken.status).toBe(403);
  });
});

describe("sandbox RPC — token gate + dispatch", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = makeHarness({ SANDBOX_RPC_TOKEN: TOKEN });
  });
  afterAll(() => h.cleanup());

  test("missing Authorization header → 401", async () => {
    const res = await rpc(h, VALID_BODY);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("wrong bearer token → 401", async () => {
    const res = await rpc(h, VALID_BODY, { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("token in a non-Bearer scheme → 401 (exact `Bearer <token>` match)", async () => {
    const res = await rpc(h, VALID_BODY, { authorization: TOKEN });
    expect(res.status).toBe(401);
  });

  test("correct bearer + unknown op → 422 validation error", async () => {
    const res = await rpc(
      h,
      { op: "db.dropEverything", auth: { userId: null, email: null, roles: [] } },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  test("correct bearer + valid body reaches the dispatcher (op error → 200 {ok:false})", async () => {
    // `fetch` with an empty FUNCTIONS_FETCH_ALLOW allow-list is rejected by
    // the dispatcher itself — proving the token gate passed and dispatchRpc
    // ran, without any real network egress. Per the wire contract, op-level
    // failures are HTTP 200 with { ok:false, error } (the executor re-throws).
    const res = await rpc(h, VALID_BODY, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("allow-list");
  });

  test("db.list without a tenantId fails closed (back-compat with old executors)", async () => {
    // Older executors don't send `auth.tenantId`. The schema keeps it
    // optional, and the bridge's collection lookup resolves against a null
    // tenant → "Collection … not found", exactly like before the field
    // existed. No tenantId must never mean "any tenant".
    const res = await rpc(
      h,
      {
        op: "db.list",
        args: { slug: "anything" },
        auth: { userId: null, email: null, roles: ["admin"] },
      },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Collection "anything" not found');
  });
});

describe("sandbox RPC — db.* ops are tenant-scoped end-to-end", () => {
  let h: TestHarness;
  let tenantId: string;
  let adminId: string;
  const slug = "rpc_notes";

  beforeAll(async () => {
    h = makeHarness({ SANDBOX_RPC_TOKEN: TOKEN });
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);

    const item = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "via-rpc-bridge" }),
    });
    expect(item.status).toBe(201);

    // The RPC subject needs the real workspace id + a user who actually holds
    // the admin role there (roles resolve from the DB, not the wire array).
    const client = new Database(h.env.SQLITE_PATH as string);
    try {
      tenantId = (
        client.query("SELECT id FROM tenants WHERE slug = 'default'").get() as {
          id: string;
        }
      ).id;
      adminId = (client.query("SELECT id FROM users LIMIT 1").get() as { id: string })
        .id;
    } finally {
      client.close();
    }
  });
  afterAll(() => h.cleanup());

  test("db.list with the wire tenantId returns the rows (green happy path)", async () => {
    const res = await rpc(
      h,
      {
        op: "db.list",
        args: { slug },
        auth: { userId: adminId, email: null, roles: ["admin"], tenantId },
      },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      value?: Array<{ title: string }>;
      error?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.value).toHaveLength(1);
    expect(body.value![0]!.title).toBe("via-rpc-bridge");
  });

  test("db.list for the same collection WITHOUT tenantId still fails closed", async () => {
    // The collection genuinely exists — omitting tenantId (an old executor)
    // must not fall back to it.
    const res = await rpc(
      h,
      {
        op: "db.list",
        args: { slug },
        auth: { userId: adminId, email: null, roles: ["admin"] },
      },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain(`Collection "${slug}" not found`);
  });
});
