import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("GET /health", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });

  afterAll(() => {
    h.cleanup();
  });

  test("returns ok + sqlite dialect", async () => {
    const res = await h.fetch("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      dialect: string;
      ts: number;
    };
    expect(body.ok).toBe(true);
    expect(body.dialect).toBe("sqlite");
    expect(typeof body.ts).toBe("number");
    // Baked in by vite `define` at template-build time; "dev" under bun test
    // (no define pass). Either way it must be a non-empty string.
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    // Server-Timing is secret-gated → NOT emitted without the debug header.
    expect(res.headers.get("Server-Timing")).toBeNull();
  });

  test("Server-Timing is emitted only with the matching debug secret header", async () => {
    const dbg = makeHarness({ DEBUG_TIMING_SECRET: "s3cr3t" });
    try {
      // No header → absent.
      expect((await dbg.fetch("/health")).headers.get("Server-Timing")).toBeNull();
      // Wrong header → absent.
      const wrong = await dbg.fetch("/health", { headers: { "x-backlex-timing": "nope" } });
      expect(wrong.headers.get("Server-Timing")).toBeNull();
      // Correct secret → emitted with the total phase.
      const ok = await dbg.fetch("/health", { headers: { "x-backlex-timing": "s3cr3t" } });
      expect(ok.headers.get("Server-Timing")).toContain("total;dur=");
    } finally {
      dbg.cleanup();
    }
  });
});

describe("GET /health/ready (readiness probe)", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });

  afterAll(() => {
    h.cleanup();
  });

  test("returns 200 + db:up when the database is reachable", async () => {
    const res = await h.fetch("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      db: string;
      dbMs: number;
      dialect: string;
      version: string;
      ts: number;
    };
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
    expect(body.dialect).toBe("sqlite");
    expect(typeof body.dbMs).toBe("number");
    expect(body.dbMs).toBeGreaterThanOrEqual(0);
  });
});

describe("request correlation id", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });

  afterAll(() => {
    h.cleanup();
  });

  test("every response carries an x-request-id header", async () => {
    const res = await h.fetch("/health");
    const id = res.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect((id ?? "").length).toBeGreaterThan(0);
  });

  test("an inbound x-request-id is echoed back unchanged", async () => {
    const res = await h.fetch("/health", {
      headers: { "x-request-id": "trace-abc-123" },
    });
    expect(res.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  test("error responses include the requestId in the body, matching the header", async () => {
    // An unauthenticated call to an admin-only route throws AppError (requireUser
    // → UNAUTHORIZED) → handled by the global error handler, which stamps the
    // requestId into the envelope.
    const res = await h.fetch("/api/admin/metrics/overview", {
      headers: { "x-request-id": "trace-err-9" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: unknown; requestId?: string };
    expect(body.error).toBeTruthy();
    expect(body.requestId).toBe("trace-err-9");
    expect(res.headers.get("x-request-id")).toBe("trace-err-9");
  });
});

describe("structured access log", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ LOG_LEVEL: "info" });
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  // Regression guard: a thrown error must emit EXACTLY ONE access line (the
  // global error handler stashes the code instead of logging its own line —
  // otherwise every thrown error was double-logged as `request.failed` + `request`).
  test("a thrown error logs one `request` line carrying the error code, no `request.failed`", async () => {
    const lines: { msg?: string; code?: string; status?: number }[] = [];
    const cap = (m: unknown) => {
      if (typeof m === "string" && m.includes('"alog-trace-1"')) {
        try {
          lines.push(JSON.parse(m));
        } catch {
          /* not our line */
        }
      }
    };
    const ow = console.warn;
    const oe = console.error;
    const ol = console.log;
    console.warn = cap;
    console.error = cap;
    console.log = cap;
    try {
      // Authenticated → unknown collection throws NOT_FOUND (a real throw,
      // routed through onError), unlike an unauthenticated requireUser return.
      await h.fetch("/api/items/no_such_collection_alog", {
        headers: { "x-request-id": "alog-trace-1" },
      });
    } finally {
      console.warn = ow;
      console.error = oe;
      console.log = ol;
    }
    const requestLines = lines.filter((l) => l.msg === "request");
    expect(requestLines.length).toBe(1);
    expect(requestLines[0]?.code).toBe("NOT_FOUND");
    expect(requestLines[0]?.status).toBe(404);
    // The legacy duplicate line must be gone.
    expect(lines.filter((l) => l.msg === "request.failed").length).toBe(0);
  });

  test("a successful request logs one `request` line with no error code", async () => {
    const lines: { msg?: string; code?: string }[] = [];
    const cap = (m: unknown) => {
      if (typeof m === "string" && m.includes('"alog-trace-2"')) {
        try {
          lines.push(JSON.parse(m));
        } catch {
          /* not our line */
        }
      }
    };
    const ol = console.log;
    console.log = cap;
    try {
      await h.fetch("/api/me", { headers: { "x-request-id": "alog-trace-2" } });
    } finally {
      console.log = ol;
    }
    const requestLines = lines.filter((l) => l.msg === "request");
    expect(requestLines.length).toBe(1);
    expect(requestLines[0]?.code).toBeUndefined();
  });
});
