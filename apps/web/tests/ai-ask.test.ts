/**
 * Admin Ask AI routes — `/api/admin/ai/plan` (Claude → tool plan) and
 * `/api/admin/ai/run` (executes one MCP tool, logs to `activity`).
 *
 * The harness never has ANTHROPIC_API_KEY set, so /plan is exercised only
 * on the UNAVAILABLE branch. /run is exercised end-to-end (executes a
 * real tool against the in-process app) and the activity-row write is
 * asserted via a direct SELECT.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const APP_URL = "http://localhost:5173";

const post = async (
  h: TestHarness,
  path: string,
  body: unknown,
  opts: { withCookie?: boolean } = { withCookie: true },
): Promise<Response> => {
  if (opts.withCookie) {
    return h.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return h.app.fetch(
    new Request(`${APP_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_URL },
      body: JSON.stringify(body),
    }),
  );
};

describe("Ask AI — /api/admin/ai/plan", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("missing ANTHROPIC_API_KEY → 503 with code: UNAVAILABLE", async () => {
    const res = await post(h, "/api/admin/ai/plan", {
      prompt: "top 5 collections by row count",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAVAILABLE");
  });
});

describe("Ask AI — /api/admin/ai/run", () => {
  let h: TestHarness;
  const slug = `ask_ai_run_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Seed a collection so `collections.list` returns something deterministic.
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "integer" },
        ],
      }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("unknown tool → 404", async () => {
    const res = await post(h, "/api/admin/ai/run", {
      tool: "definitely.not.a.real.tool",
      args: {},
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  test("collections.list happy path → 200 and writes one activity row", async () => {
    const res = await post(h, "/api/admin/ai/run", {
      tool: "collections.list",
      args: { collection: slug, limit: 5 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tool: string;
      rowCount?: number | null;
      durationMs: number;
    };
    expect(body.ok).toBe(true);
    expect(body.tool).toBe("collections.list");
    expect(typeof body.durationMs).toBe("number");

    // Verify the activity row landed. Read the SQLite file directly so the
    // assertion is decoupled from the activity REST API (which may further
    // filter by tenant / user). One row, exact action.
    const sqlitePath = h.env.SQLITE_PATH;
    expect(typeof sqlitePath).toBe("string");
    const db = new Database(sqlitePath!, { readonly: true });
    try {
      const rows = db
        .query<{ action: string; collection: string; payload: string }, []>(
          "SELECT action, collection, payload FROM activity WHERE action = 'mcp.collections.list'",
        )
        .all();
      expect(rows.length).toBe(1);
      expect(rows[0]!.collection).toBe("mcp");
      const payload = JSON.parse(rows[0]!.payload) as {
        tool: string;
        args: Record<string, unknown>;
      };
      expect(payload.tool).toBe("collections.list");
      expect(payload.args.collection).toBe(slug);
    } finally {
      db.close();
    }
  });
});

describe("Ask AI — admin gate", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    // No admin sign-in — fresh DB, no session.
  });
  afterAll(() => h.cleanup());

  test("/plan is 401 for unauthenticated requests", async () => {
    const res = await post(
      h,
      "/api/admin/ai/plan",
      { prompt: "anything" },
      { withCookie: false },
    );
    expect(res.status).toBe(401);
  });

  test("/run is 401 for unauthenticated requests", async () => {
    const res = await post(
      h,
      "/api/admin/ai/run",
      { tool: "collections.list", args: {} },
      { withCookie: false },
    );
    expect(res.status).toBe(401);
  });
});

describe("Ask AI — non-admin signed-in user is 403", () => {
  let h: TestHarness;
  beforeAll(async () => {
    // First user is auto-promoted to admin; sign them up but then sign them
    // OUT and create a second, non-admin user.
    h = makeHarness();
    await seedAdmin(h, `first-${Date.now()}@example.test`);
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const email = `member-${Date.now()}@example.test`;
    const password = "correct-horse-battery";
    const signUp = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "Plain Member" }),
    });
    expect(signUp.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("/plan is 403 for a signed-in non-admin", async () => {
    const res = await post(h, "/api/admin/ai/plan", { prompt: "anything" });
    expect(res.status).toBe(403);
  });

  test("/run is 403 for a signed-in non-admin", async () => {
    const res = await post(h, "/api/admin/ai/run", {
      tool: "collections.list",
      args: {},
    });
    expect(res.status).toBe(403);
  });
});
