/**
 * Advisor v2 — runtime query insights (#20).
 *
 * Pins the half of the advisor that reasons about recorded traffic rather than
 * the schema: the span aggregation, the rules it feeds, and the one-click
 * `apply` path.
 *
 * Traffic is seeded by writing `spans` rows directly (the same rows the request
 * middleware writes), so the assertions are deterministic instead of depending
 * on how many requests the harness happened to make.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  collectionFromPath,
  normalizeRoutePath,
} from "../src/server/services/advisor-insights";
import { advisorIndexName } from "../src/server/services/advisor";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface AdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  sql: string;
}

interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  rule: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  action?: AdvisorAction;
  evidence?: {
    requests: number;
    windowDays: number;
    p95?: number;
    errorRate?: number;
    share?: number;
  };
}

interface AdvisorResult {
  data: AdvisorCheck[];
  score: number;
  generatedAt: string;
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

interface Insights {
  endpoints: {
    route: string;
    method: string;
    path: string;
    requests: number;
    p50: number;
    p95: number;
    p99: number;
    maxMs: number;
    avgMs: number;
    serverErrors: number;
    clientErrors: number;
    errorRate: number;
  }[];
  collections: {
    collection: string;
    listRequests: number;
    p50: number;
    p95: number;
    filters: { column: string; requests: number; share: number }[];
    sorts: { column: string; requests: number; share: number }[];
  }[];
  window: {
    from: number;
    to: number;
    days: number;
    spanCount: number;
    oldestSpanAt: number | null;
    sampleRate: number;
    truncated: boolean;
  };
}

describe("advisor insights: path normalization", () => {
  test("id-shaped segments fold to :id, collection slugs survive", () => {
    expect(
      normalizeRoutePath("/api/items/posts/8f14e45f-ea0f-4b1e-9f2c-0d1e2f3a4b5c"),
    ).toBe("/api/items/posts/:id");
    // A collection slug that is itself id-shaped still survives — it sits in
    // the collection slot, not an id slot.
    expect(normalizeRoutePath("/api/items/posts")).toBe("/api/items/posts");
    expect(normalizeRoutePath("/api/items/1234567890/42")).toBe(
      "/api/items/1234567890/:id",
    );
    // Numeric and long-token ids both fold.
    expect(normalizeRoutePath("/api/storage/files/1024")).toBe(
      "/api/storage/files/:id",
    );
    expect(
      normalizeRoutePath("/api/admin/traces/0af7651916cd43dd8448eb211c80319c"),
    ).toBe("/api/admin/traces/:id");
    // Ordinary literal segments are untouched.
    expect(normalizeRoutePath("/api/admin/advisor/insights")).toBe(
      "/api/admin/advisor/insights",
    );
    expect(normalizeRoutePath("/")).toBe("/");
  });

  test("collectionFromPath reads the slug back out", () => {
    expect(collectionFromPath("/api/items/posts/:id")).toBe("posts");
    expect(collectionFromPath("/api/items/posts")).toBe("posts");
    expect(collectionFromPath("/api/admin/advisor")).toBeNull();
    expect(collectionFromPath("/health")).toBeNull();
  });
});

describe("advisor: index name stays inside PG's identifier limit", () => {
  test("short names pass through, long ones are truncated but stay unique", () => {
    expect(advisorIndexName("c_abc_posts", ["status"])).toBe(
      "bx_idx_c_abc_posts_status",
    );
    const long = advisorIndexName("c_abcdefghijkl_a_very_long_collection_name", [
      "an_equally_long_column_name_here",
    ]);
    expect(long.length).toBeLessThanOrEqual(63);
    const other = advisorIndexName("c_abcdefghijkl_a_very_long_collection_name", [
      "an_equally_long_column_name_there",
    ]);
    expect(other.length).toBeLessThanOrEqual(63);
    expect(long).not.toBe(other);
  });
});

/** Insert one span row. `attrs` mirrors what the list handler records. */
const spanSql = (
  slug: string,
  opts: {
    path: string;
    method?: string;
    status?: number;
    durationMs: number;
    ageMs?: number;
    attrs?: Record<string, unknown> | null;
  },
): string => {
  const started = Date.now() - (opts.ageMs ?? 60_000);
  const attrs = opts.attrs === undefined ? null : opts.attrs;
  const attrsSql =
    attrs === null ? "NULL" : `'${JSON.stringify(attrs).replace(/'/g, "''")}'`;
  return `INSERT INTO spans (id, tenant_id, trace_id, span_id, parent_span_id, name, kind, method, path, status, user_id, duration_ms, attributes, started_at, created_at)
    SELECT '${crypto.randomUUID()}', tenant_id, '${crypto.randomUUID().replace(/-/g, "")}', '${crypto.randomUUID().slice(0, 16)}', NULL,
           '${opts.method ?? "GET"} ${opts.path}', 'server', '${opts.method ?? "GET"}', '${opts.path}',
           ${opts.status ?? 200}, NULL, ${opts.durationMs}, ${attrsSql}, ${started}, ${started}
      FROM collections WHERE slug = '${slug}' LIMIT 1`;
};

describe("advisor v2: traffic-derived findings + insights + apply", () => {
  let h: TestHarness;
  const slug = `insights_${Date.now()}`;
  let physicalTable = "";

  const runSql = async (statement: string) => {
    const res = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
      body: JSON.stringify({ sql: statement }),
    });
    if (res.status !== 200) {
      throw new Error(`sql failed: ${res.status} ${await res.text()}`);
    }
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        ownerScoped: false,
        fields: [
          { name: "title", type: "text" },
          { name: "status", type: "text" },
        ],
      }),
    });
    expect(create.status).toBe(201);
    physicalTable = ((await create.json()) as { data: { physicalTable: string } })
      .data.physicalTable;
    expect(physicalTable.length).toBeGreaterThan(0);

    // 40 list requests, all filtering by `status`, all slow. Above every
    // threshold (20 requests, p95 ≥ 500ms) so the rules must fire.
    for (let i = 0; i < 40; i++) {
      await runSql(
        spanSql(slug, {
          path: `/api/items/${slug}`,
          durationMs: 600 + i,
          attrs: { collection: slug, filters: ["status"], sorts: ["created_at"] },
        }),
      );
    }
    // A separate endpoint that fails: 12 requests, 4 of them 5xx (33%).
    for (let i = 0; i < 12; i++) {
      await runSql(
        spanSql(slug, {
          path: "/api/admin/flaky",
          method: "POST",
          status: i < 4 ? 500 : 200,
          durationMs: 20,
          attrs: null,
        }),
      );
    }
    // Traffic that is quiet enough to stay below the thresholds — it must NOT
    // produce a finding, only show up in the raw insights.
    for (let i = 0; i < 3; i++) {
      await runSql(
        spanSql(slug, {
          path: "/api/admin/rarely-used",
          durationMs: 5000,
          attrs: null,
        }),
      );
    }
  });

  afterAll(() => h.cleanup());

  test("insights aggregates endpoints and per-collection column use", async () => {
    const res = await h.fetch("/api/admin/advisor/insights?days=7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Insights;

    expect(body.window.days).toBe(7);
    expect(body.window.spanCount).toBeGreaterThanOrEqual(55);
    expect(body.window.sampleRate).toBe(1);
    expect(body.window.truncated).toBe(false);
    expect(body.window.oldestSpanAt).not.toBeNull();

    const list = body.endpoints.find((e) => e.route === `GET /api/items/${slug}`);
    expect(list).toBeDefined();
    expect(list!.requests).toBe(40);
    expect(list!.p50).toBeGreaterThanOrEqual(600);
    expect(list!.p95).toBeGreaterThanOrEqual(600);
    expect(list!.p99).toBeGreaterThanOrEqual(list!.p95);
    expect(list!.maxMs).toBe(639);
    expect(list!.errorRate).toBe(0);

    const flaky = body.endpoints.find((e) => e.route === "POST /api/admin/flaky");
    expect(flaky).toBeDefined();
    expect(flaky!.requests).toBe(12);
    expect(flaky!.serverErrors).toBe(4);
    expect(flaky!.errorRate).toBeCloseTo(4 / 12, 5);

    const coll = body.collections.find((c) => c.collection === slug);
    expect(coll).toBeDefined();
    expect(coll!.listRequests).toBe(40);
    expect(coll!.filters).toEqual([{ column: "status", requests: 40, share: 1 }]);
    expect(coll!.sorts).toEqual([
      { column: "created_at", requests: 40, share: 1 },
    ]);
  });

  test("a hot filter column with no index produces a fixable finding", async () => {
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdvisorResult;

    expect(body.runtime.windowDays).toBe(7);
    expect(body.runtime.spanCount).toBeGreaterThan(0);

    const finding = body.data.find(
      (c) => c.rule === "hot-filter-index" && c.resource.includes("status"),
    );
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("performance");
    expect(finding!.level).toBe("warn");
    expect(finding!.evidence?.requests).toBe(40);
    expect(finding!.evidence?.share).toBe(1);
    expect(finding!.evidence?.windowDays).toBe(7);
    // The body quotes the observed numbers rather than a generic claim.
    expect(finding!.body).toContain("40 of 40");
    expect(finding!.action?.type).toBe("create-index");
    expect(finding!.action?.table).toBe(physicalTable);
    expect(finding!.action?.columns).toEqual(["status"]);
    expect(finding!.action?.sql).toContain("CREATE INDEX IF NOT EXISTS");
  });

  test("the pagination index counts as covering created_at — no sort finding", async () => {
    const res = await h.fetch("/api/admin/advisor");
    const body = (await res.json()) as AdvisorResult;
    // A managed collection's `(tenant_id, created_at, id)` index really does
    // serve a `-created_at` sort, because every read pins tenant_id. Neither
    // the runtime nor the static rule may claim otherwise.
    const sortFinding = body.data.find(
      (c) => c.rule === "hot-sort-index" && c.resource.includes(physicalTable),
    );
    expect(sortFinding).toBeUndefined();
    const staticFinding = body.data.find(
      (c) => c.rule === "created-index" && c.resource.includes(physicalTable),
    );
    expect(staticFinding).toBeUndefined();
  });

  test("slow and failing endpoints are flagged; quiet ones are not", async () => {
    const res = await h.fetch("/api/admin/advisor");
    const body = (await res.json()) as AdvisorResult;

    const slow = body.data.find(
      (c) => c.rule === "slow-endpoint" && c.resource.includes(`/api/items/${slug}`),
    );
    expect(slow).toBeDefined();
    expect(slow!.level).toBe("warn"); // 600ms → over slow, under very-slow
    expect(slow!.evidence?.requests).toBe(40);
    expect(slow!.evidence?.p95).toBeGreaterThanOrEqual(600);

    const errors = body.data.find(
      (c) => c.rule === "endpoint-errors" && c.resource.includes("/api/admin/flaky"),
    );
    expect(errors).toBeDefined();
    expect(errors!.level).toBe("error");
    expect(errors!.evidence?.errorRate).toBeCloseTo(4 / 12, 5);

    // 3 requests at 5s is well over the latency bar but well under the traffic
    // bar — advice on three requests would be noise.
    const quiet = body.data.find((c) => c.resource.includes("/api/admin/rarely-used"));
    expect(quiet).toBeUndefined();
  });

  test("apply creates the index and the finding stops reappearing", async () => {
    const before = (await (await h.fetch("/api/admin/advisor")).json()) as AdvisorResult;
    const finding = before.data.find((c) => c.rule === "hot-filter-index")!;
    expect(finding).toBeDefined();

    const applied = await h.fetch("/api/admin/advisor/apply", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: finding.id }),
    });
    expect(applied.status).toBe(200);
    const payload = (await applied.json()) as { ok: true; applied: AdvisorAction };
    expect(payload.ok).toBe(true);
    expect(payload.applied.columns).toEqual(["status"]);

    // Re-running the advisor no longer reports it — the index now exists.
    const after = (await (await h.fetch("/api/admin/advisor")).json()) as AdvisorResult;
    expect(after.data.find((c) => c.id === finding.id)).toBeUndefined();

    // Applying twice is harmless in itself, but the finding is gone, so the
    // id no longer resolves — a stale fix can't be replayed.
    const replay = await h.fetch("/api/admin/advisor/apply", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: finding.id }),
    });
    expect(replay.status).toBe(404);
  });

  test("apply refuses a finding with no automatic fix", async () => {
    const body = (await (await h.fetch("/api/admin/advisor")).json()) as AdvisorResult;
    const noAction = body.data.find((c) => !c.action);
    expect(noAction).toBeDefined();
    const res = await h.fetch("/api/admin/advisor/apply", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: noAction!.id }),
    });
    expect(res.status).toBe(422);
  });

  test("apply rejects an unknown finding id rather than running anything", async () => {
    const res = await h.fetch("/api/admin/advisor/apply", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "perf-hot-filter-index-nope-nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("advisor v2: a workspace with no recorded traffic", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("runtime rules stay silent and the run says why", async () => {
    const res = await h.fetch("/api/admin/advisor?days=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdvisorResult;
    expect(body.runtime.windowDays).toBe(1);
    // The harness itself issues a handful of requests, but none of them are
    // item lists and none clear the 20-request bar.
    for (const rule of ["hot-filter-index", "hot-sort-index", "slow-endpoint"]) {
      expect(body.data.find((c) => c.rule === rule)).toBeUndefined();
    }
  });

  test("insights returns an empty-but-well-formed window", async () => {
    const res = await h.fetch("/api/admin/advisor/insights?days=1&limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Insights;
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.collections).toEqual([]);
    expect(body.window.days).toBe(1);
    expect(body.window.sampleRate).toBe(1);
    expect(body.endpoints.length).toBeLessThanOrEqual(5);
  });
});
