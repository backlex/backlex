import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, type TestHarness } from "./setup";

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

  test("db.list op dispatches too (fails on tenant scoping, not on auth)", async () => {
    // The RPC body's `auth` schema carries no tenantId (the executor's wire
    // format only sends userId/email/roles), so the bridge's collection
    // lookup resolves with a null tenant and every db.* op comes back
    // "Collection … not found" — even for collections that exist. Pinning
    // that: a fully-green db.list is not reachable through this bridge
    // in-harness; if the wire format ever grows a tenantId this should be
    // upgraded to a real happy path.
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
