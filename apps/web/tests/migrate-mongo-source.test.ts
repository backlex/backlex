/**
 * MongoDB source — schema-inference unit tests + an end-to-end copy through
 * an in-memory DocumentSource fake (no Mongo server in CI; the real driver
 * wiring in the CLI is a thin normalize/cursor layer over the same
 * interface). Verifies: sample-based type voting, sparse-field nullability,
 * _id keying, sampling warning in the plan, nested-document round-trip, and
 * the --since delta pass on a document store.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  buildPlan,
  createMongoSource,
  inferColumns,
  looksLikeObjectIdHex,
  type DocumentSource,
} from "../../../packages/migrate/src";
import { runImportDb } from "../../../packages/cli/src/import-db";

describe("inferColumns (sample-based schema inference)", () => {
  test("votes types and widens disagreements to json", () => {
    const { columns } = inferColumns([
      { _id: "a", title: "hi", views: 3, score: 1.5, ok: true, at: new Date(), meta: { x: 1 } },
      { _id: "b", title: "x".repeat(300), views: 9, score: 2, ok: false, at: new Date(), meta: [1, 2] },
      { _id: "c", title: "yo", views: "not-a-number" },
    ]);
    const by = new Map(columns.map((c) => [c.name, c]));
    expect(by.get("title")!.dbType).toBe("text"); // one long sample → longtext
    expect(by.get("views")!.dbType).toBe("jsonb"); // number vs string → json
    expect(by.get("score")!.dbType).toBe("double precision"); // int widened by float
    expect(by.get("ok")!.dbType).toBe("boolean");
    expect(by.get("at")!.dbType).toBe("timestamptz");
    expect(by.get("meta")!.dbType).toBe("jsonb");
    // Sparse fields (missing in doc c) are nullable; `views` is in all three.
    expect(by.get("ok")!.nullable).toBe(true);
    expect(by.get("views")!.nullable).toBe(false);
  });

  test("_id typing: hex/string → text pk, numeric → integer pk", () => {
    expect(inferColumns([{ _id: "665f0c2a9b3e4d5a6f7a8b9c" }]).idDbType).toBe("varchar(64)");
    expect(inferColumns([{ _id: 42 }]).idDbType).toBe("bigint");
    expect(inferColumns([]).idDbType).toBe("varchar(64)"); // empty collection default
    expect(looksLikeObjectIdHex("665f0c2a9b3e4d5a6f7a8b9c")).toBe(true);
    expect(looksLikeObjectIdHex("not-hex")).toBe(false);
  });
});

// ── End-to-end over an in-memory document store ────────────────────────────

const oid = (n: number) => n.toString(16).padStart(24, "0");

const store: Record<string, Record<string, unknown>[]> = {
  posts: [
    {
      _id: oid(1),
      title: "Hello Mongo",
      tags: ["intro", "news"],
      author: { name: "Ada", email: "ada@example.test" },
      views: 12,
      published: true,
      createdAt: new Date("2022-01-01T00:00:00Z"),
      updatedAt: new Date("2022-01-01T00:00:00Z"),
    },
    {
      _id: oid(2),
      title: "Second post",
      tags: [],
      author: { name: "Grace" },
      views: 7,
      published: false,
      createdAt: new Date("2022-02-02T00:00:00Z"),
      updatedAt: new Date("2022-02-02T00:00:00Z"),
    },
    {
      _id: oid(3),
      title: "Sparse doc — no tags/author",
      views: 0,
      published: true,
      createdAt: new Date("2022-03-03T00:00:00Z"),
      updatedAt: new Date("2022-03-03T00:00:00Z"),
    },
  ],
};

const ms = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Date.parse(String(v));

const fakeClient: DocumentSource = {
  listCollections: async () => Object.keys(store),
  count: async (c) => store[c]!.length,
  sample: async (c, n) => store[c]!.slice(0, n),
  findBatch: async (c, o) => {
    let rows = [...store[c]!].sort((a, b) =>
      String(a._id) < String(b._id) ? -1 : 1,
    );
    if (o.after !== undefined) rows = rows.filter((r) => String(r._id) > String(o.after));
    if (o.since) {
      const wm = typeof o.since.value === "number" ? o.since.value : Date.parse(String(o.since.value));
      rows = rows.filter((r) => ms(r[o.since!.column]) >= wm);
    }
    return rows.slice(0, o.limit);
  },
};

describe("import-db end-to-end (mongodb source via DocumentSource fake)", () => {
  let h: TestHarness;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let pak: string;
  const planPath = resolve(tmpdir(), `backlex-mongo-plan-${randomUUID()}.json`);

  const deps = {
    openSource: (_url: string, opts?: { sampleSize?: number }) => ({
      connector: createMongoSource(fakeClient, opts),
      close: async () => {},
    }),
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const keyRes = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mongo-e2e" }),
    });
    pak = ((await keyRes.json()) as { data: { secret: string } }).data.secret;
    server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
    url = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    for (const p of [planPath, `${planPath}.state.json`, `${planPath}.since.state.json`]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    h?.cleanup();
  });

  test("plan: infers the model, keys by _id, and carries the sampling caveat", async () => {
    await runImportDb(
      ["plan", "--source", "mongodb://fake/db", "--out", planPath, "--sample-size", "100"],
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.source.kind).toBe("mongodb");
    const posts = plan.tables.find((t: any) => t.table === "posts");
    expect(posts.include).toBe(true);
    expect(posts.pkColumn).toBe("_id");
    expect(posts.pkType).toBe("text");
    expect(posts.createdAtColumn).toBe("createdAt");
    expect(posts.updatedAtColumn).toBe("updatedAt");
    const by = new Map(posts.fields.map((f: any) => [f.column, f]));
    expect((by.get("tags") as any).type).toBe("json");
    expect((by.get("author") as any).type).toBe("json");
    expect((by.get("views") as any).type).toBe("integer");
    expect((by.get("published") as any).type).toBe("boolean");
    expect(
      posts.warnings.some((w: string) => w.includes("sample of up to 100 documents")),
    ).toBe(true);
  });

  test("run: documents land with preserved _ids and intact nesting", async () => {
    const exitBefore = process.exitCode;
    await runImportDb(
      ["run", planPath, "--source", "mongodb://fake/db", "--url", url, "--key", pak, "--batch", "2"],
      deps,
    );
    expect(process.exitCode).toBe(exitBefore);

    const auth = { authorization: `Bearer ${pak}` };
    const count = (await (
      await fetch(`${url}/api/items/posts?limit=1&meta=filter_count`, { headers: auth })
    ).json()) as { meta: { filter_count: number } };
    expect(count.meta.filter_count).toBe(3);

    const first = (await (
      await fetch(`${url}/api/items/posts/${oid(1)}`, { headers: auth })
    ).json()) as { data: any };
    expect(first.data.title).toBe("Hello Mongo");
    expect(first.data.tags).toEqual(["intro", "news"]);
    expect(first.data.author).toEqual({ name: "Ada", email: "ada@example.test" });
    expect(first.data.published).toBe(true);
    expect(new Date(first.data.createdAt).toISOString()).toBe("2022-01-01T00:00:00.000Z");
  });

  test("--since delta pass upserts changed documents", async () => {
    store.posts[0] = {
      ...store.posts[0]!,
      title: "Hello Mongo (edited)",
      updatedAt: new Date("2031-05-05T00:00:00Z"),
    };
    store.posts.push({
      _id: oid(4),
      title: "Brand new",
      views: 1,
      published: true,
      createdAt: new Date("2031-06-06T00:00:00Z"),
      updatedAt: new Date("2031-06-06T00:00:00Z"),
    });

    const exitBefore = process.exitCode;
    await runImportDb(
      [
        "run", planPath,
        "--source", "mongodb://fake/db",
        "--url", url,
        "--key", pak,
        "--since", "2030-01-01T00:00:00Z",
      ],
      deps,
    );
    expect(process.exitCode).toBe(exitBefore);

    const auth = { authorization: `Bearer ${pak}` };
    const count = (await (
      await fetch(`${url}/api/items/posts?limit=1&meta=filter_count`, { headers: auth })
    ).json()) as { meta: { filter_count: number } };
    expect(count.meta.filter_count).toBe(4); // one new, no dupes

    const edited = (await (
      await fetch(`${url}/api/items/posts/${oid(1)}`, { headers: auth })
    ).json()) as { data: any };
    expect(edited.data.title).toBe("Hello Mongo (edited)");
    expect(new Date(edited.data.createdAt).toISOString()).toBe("2022-01-01T00:00:00.000Z");
  });

  test("buildPlan excludes float-keyed collections with a readable reason", () => {
    const { idDbType } = inferColumns([{ _id: 1.5 }]);
    const plan = buildPlan(
      [{ table: "weird", columns: [], pk: { column: "_id", dbType: idDbType }, foreignKeys: [] }],
      new Map(),
      "mongodb",
    );
    expect(plan.tables[0]!.include).toBe(false);
    expect(plan.tables[0]!.reason).toContain("unsupported type");
  });
});
