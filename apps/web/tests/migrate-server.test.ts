/**
 * Server-side external-DB migration (Phase 2) — sources CRUD (encryption +
 * masking + SSRF guard), plan building, and the scheduler-tick copy executor
 * (`processMigrationRuns`): bounded slices, cursor resume, cancel/resume,
 * verify. The connector factory is injected with a pglite-backed source
 * (pglite has no TCP listener); everything else is the production path.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeHarness, seedAdmin, PGLITE_BOOT_TIMEOUT_MS, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { createPgSource, type SourceQuery } from "../../../packages/migrate/src";
import {
  __setMigrateConnectorFactory,
  processMigrationRuns,
} from "../src/server/services/migrate";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("migrate server-side (sources + runs)", () => {
  let h: TestHarness;
  let pg: PGlite;
  let ctx: Awaited<ReturnType<typeof buildContext>>;
  let restoreFactory: () => void;
  let sourceId: string;
  let plan: any;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE authors (id bigint PRIMARY KEY, name varchar(80) NOT NULL);
      CREATE TABLE books (
        id bigint PRIMARY KEY,
        author_id bigint REFERENCES authors(id),
        title varchar(200) NOT NULL,
        published_at timestamptz
      );
      INSERT INTO authors (id, name) VALUES (1, 'Ursula K. Le Guin'), (2, 'Italo Calvino');
      INSERT INTO books (id, author_id, title, published_at) VALUES
        (100, 1, 'The Dispossessed', '1974-05-01T00:00:00Z'),
        (101, 1, 'The Left Hand of Darkness', '1969-03-01T00:00:00Z'),
        (102, 2, 'Invisible Cities', '1972-11-03T00:00:00Z'),
        (103, 2, 'If on a winter''s night a traveler', '1979-06-01T00:00:00Z'),
        (104, NULL, 'Anonymous Chapbook', NULL);
    `);
    const query: SourceQuery = async (text, params) =>
      (await pg.query(text, (params ?? []) as unknown[])).rows as Record<
        string,
        unknown
      >[];
    const prev = __setMigrateConnectorFactory(() => ({
      connector: createPgSource(query),
      close: async () => {},
    }));
    restoreFactory = () => __setMigrateConnectorFactory(prev);

    h = makeHarness();
    await seedAdmin(h);
    ctx = await buildContext(h.env);
    // PGlite boots a WASM Postgres, which does not fit bun's default 5s hook
    // budget on a machine that is also running typecheck and four platform
    // builds — which is exactly what the pre-push hook does. The timeout was
    // failing the gate on load rather than on anything this file asserts.
  }, PGLITE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    restoreFactory();
    await pg?.close();
    h?.cleanup();
  });

  test("SSRF guard: private hosts are rejected unless opted in", async () => {
    for (const url of [
      "postgres://u:p@localhost:5432/db",
      "postgres://u:p@10.0.0.5/db",
      "postgres://u:p@192.168.1.10/db",
      "postgres://u:p@172.20.3.4/db",
      "postgres://u:p@169.254.169.254/db", // cloud metadata endpoint
      "postgres://u:p@db.internal/db",
      // The bypasses the old eleven-regex list waved through. `postgres:` is a
      // non-special scheme, so the URL parser leaves the host OPAQUE — these
      // arrive as the literal strings below, match no dotted-decimal pattern,
      // and `getaddrinfo` then resolves every one of them to loopback or
      // RFC1918. Verified against `dns.lookup` while the finding was written.
      "postgres://u:p@2130706433:5432/db", // 127.0.0.1, bare integer
      "postgres://u:p@0x7f000001/db", // 127.0.0.1, hex
      "postgres://u:p@0177.0.0.1/db", // 127.0.0.1, octal octet
      "postgres://u:p@0xa000001/db", // 10.0.0.1, hex
      "postgres://u:p@127.1/db", // 127.0.0.1, short inet_aton form
      "postgres://u:p@[::ffff:127.0.0.1]/db", // IPv4-mapped IPv6
    ]) {
      const res = await h.fetch(
        "/api/admin/migrate/sources",
        json({ name: `bad-${Math.random()}`, url }),
      );
      expect(res.status).toBe(422);
    }
    // Non-postgres schemes are rejected too.
    const bad = await h.fetch(
      "/api/admin/migrate/sources",
      json({ name: "scheme", url: "mysql://u:p@db.example.com/db" }),
    );
    expect(bad.status).toBe(422);
  });

  test("create + list sources: URL encrypted at rest, masked on read", async () => {
    const res = await h.fetch(
      "/api/admin/migrate/sources",
      json({ name: "legacy", url: "postgres://admin:s3cret@db.example.com:5432/library" }),
    );
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: any }).data;
    sourceId = created.id;
    expect(created.urlMasked).toBe("postgres://db.example.com:5432/library");
    expect(JSON.stringify(created)).not.toContain("s3cret");

    const list = await h.fetch("/api/admin/migrate/sources");
    const rows = ((await list.json()) as { data: any[] }).data;
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("s3cret");

    // Duplicate name → 409
    const dup = await h.fetch(
      "/api/admin/migrate/sources",
      json({ name: "legacy", url: "postgres://x@db2.example.com/db" }),
    );
    expect(dup.status).toBe(409);
  });

  test("test-connection + table listing go through the saved source", async () => {
    const t = await h.fetch(`/api/admin/migrate/sources/${sourceId}/test`, json({}));
    expect(t.status).toBe(200);
    expect(((await t.json()) as { data: any }).data).toMatchObject({ ok: true, tables: 2 });

    const tables = await h.fetch(`/api/admin/migrate/sources/${sourceId}/tables`);
    const names = (((await tables.json()) as { data: any[] }).data).map((x) => x.name);
    expect(names.sort()).toEqual(["authors", "books"]);
  });

  test("plan endpoint builds the FK-ordered plan", async () => {
    const res = await h.fetch(`/api/admin/migrate/sources/${sourceId}/plan`, json({}));
    expect(res.status).toBe(200);
    plan = ((await res.json()) as { data: any }).data;
    expect(plan.order).toEqual(["authors", "books"]);
    const books = plan.tables.find((t: any) => t.table === "books");
    expect(books.fields.find((f: any) => f.column === "author_id").type).toBe("relation");
  });

  test("run executes on the tick: collections created, rows copied, verified", async () => {
    const start = await h.fetch("/api/admin/migrate/runs", json({ sourceId, plan }));
    expect(start.status).toBe(201);
    const runId = ((await start.json()) as { data: any }).data.id as string;

    // A second concurrent run is refused.
    const second = await h.fetch("/api/admin/migrate/runs", json({ sourceId, plan }));
    expect(second.status).toBe(409);
    // Deleting the source mid-run is refused.
    const del = await h.fetch(`/api/admin/migrate/sources/${sourceId}`, { method: "DELETE" });
    expect(del.status).toBe(409);

    // Drive the executor like the scheduler would — tiny batches force
    // several slices and exercise cursor persistence. `now` must advance past
    // the ~2min lease each slice writes: the due-run query only re-claims
    // `leaseUntil < now`, so on a slow runner a slice that exhausts its 50ms
    // budget leaves a live lease behind and a fixed `now` makes every later
    // sweep a no-op — stranding the run "running" (flaked exactly this way
    // in CI; fast machines finish in one slice and never hit the re-claim).
    for (let i = 0; i < 12; i++) {
      const now = new Date(Date.now() + (i + 1) * 121_000);
      const { advanced } = await processMigrationRuns(ctx, { batchSize: 2, budgetMs: 50, now });
      if (!advanced) break;
      const r = await h.fetch(`/api/admin/migrate/runs/${runId}`);
      const run = ((await r.json()) as { data: any }).data;
      if (["done", "failed"].includes(run.status)) break;
    }

    const res = await h.fetch(`/api/admin/migrate/runs/${runId}`);
    const run = ((await res.json()) as { data: any }).data;
    expect(run.status).toBe("done");
    expect(run.state.tables.authors).toMatchObject({
      copied: 2,
      failed: 0,
      done: true,
      sourceCount: 2,
      targetTotal: 2,
    });
    expect(run.state.tables.books.copied).toBe(5);

    // PKs preserved → relations resolve.
    const item = await h.fetch("/api/items/books/100?expand=author_id");
    expect(item.status).toBe(200);
    const row = ((await item.json()) as { data: any }).data;
    expect(row.author_id?.name).toBe("Ursula K. Le Guin");
  });

  test("re-running is idempotent; cancel/resume round-trips", async () => {
    const start = await h.fetch("/api/admin/migrate/runs", json({ sourceId, plan }));
    expect(start.status).toBe(201);
    const runId = ((await start.json()) as { data: any }).data.id as string;

    // Cancel while still pending.
    const cancel = await h.fetch(`/api/admin/migrate/runs/${runId}/cancel`, json({}));
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { data: any }).data.status).toBe("cancelled");

    // Resume re-queues it; the executor then re-copies — idempotently.
    const resume = await h.fetch(`/api/admin/migrate/runs/${runId}/resume`, json({}));
    expect(resume.status).toBe(200);
    for (let i = 0; i < 10; i++) {
      // Same lease-advancing `now` as above so a budget-exhausted slice can
      // always be re-claimed on the next iteration.
      const now = new Date(Date.now() + (i + 1) * 121_000);
      const { advanced } = await processMigrationRuns(ctx, { batchSize: 100, now });
      if (!advanced) break;
      const r = await h.fetch(`/api/admin/migrate/runs/${runId}`);
      if (["done", "failed"].includes((((await r.json()) as { data: any }).data.status))) break;
    }
    const res = await h.fetch(`/api/admin/migrate/runs/${runId}`);
    const run = ((await res.json()) as { data: any }).data;
    expect(run.status).toBe("done");
    // Everything already existed → nothing new inserted, still verified.
    expect(run.state.tables.authors.copied).toBe(0);
    expect(run.state.tables.authors.targetTotal).toBe(2);

    const count = await h.fetch("/api/items/authors?limit=1&meta=filter_count");
    expect((((await count.json()) as { meta: any }).meta).filter_count).toBe(2);
  });

  test("plan auto-renames slugs that collide with incompatible collections", async () => {
    // A pre-existing collection named like a source table, with a different
    // shape (uuid pk, unrelated fields) — the template-seeded-workspace case.
    const mk = await h.fetch(
      "/api/collections",
      json({ slug: "inventory", fields: [{ name: "title", type: "text" }] }),
    );
    expect(mk.status).toBe(201);
    await pg.exec(`
      CREATE TABLE inventory (id bigint PRIMARY KEY, qty int);
      INSERT INTO inventory VALUES (1, 5), (2, 9);
    `);
    const res = await h.fetch(`/api/admin/migrate/sources/${sourceId}/plan`, json({}));
    const p = ((await res.json()) as { data: any }).data;
    const inv = p.tables.find((t: any) => t.table === "inventory");
    expect(inv.slug).toBe("inventory_2");
    expect(inv.warnings.some((w: string) => w.includes('importing as "inventory_2"'))).toBe(true);
    // Compatible collisions (authors/books were created BY this migration)
    // keep their slug — that's the resume path.
    expect(p.tables.find((t: any) => t.table === "authors").slug).toBe("authors");

    // Hand-editing the collision back in is caught by the startRun guard.
    inv.slug = "inventory";
    for (const t of p.tables) {
      for (const f of t.fields) if (f.to === "inventory_2") f.to = "inventory";
    }
    const start = await h.fetch("/api/admin/migrate/runs", json({ sourceId, plan: p }));
    expect(start.status).toBe(409);
    expect(JSON.stringify(await start.json())).toContain("rename the plan slug");
  });

  test("private URL is allowed when MIGRATE_ALLOW_PRIVATE_SOURCES=true", async () => {
    const h2 = makeHarness({ MIGRATE_ALLOW_PRIVATE_SOURCES: "true" });
    try {
      await seedAdmin(h2);
      const res = await h2.fetch(
        "/api/admin/migrate/sources",
        json({ name: "vpc", url: "postgres://u:p@10.1.2.3/db" }),
      );
      expect(res.status).toBe(201);
    } finally {
      h2.cleanup();
    }
  });

  test("the whole surface is admin-gated", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/admin/migrate/sources");
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
