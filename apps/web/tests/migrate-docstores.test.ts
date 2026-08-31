/**
 * Firestore / DynamoDB sources — the pieces that are OURS are tested here:
 * the duck-typed value normalizers (no driver installs needed), the
 * composite-key exclusion path, and an end-to-end copy through a
 * Dynamo-shaped DocumentSource fake (numeric partition keys → integer pk).
 * The CLI's real driver wiring is a thin pagination/marshalling layer over
 * the same DocumentSource interface exercised here.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  createDocumentSource,
  normalizeDynamoItem,
  normalizeFirestoreDoc,
  type DocumentSource,
} from "../../../packages/migrate/src";
import { runImportDb } from "../../../packages/cli/src/import-db";

describe("normalizeFirestoreDoc", () => {
  test("flattens Timestamp / DocumentReference / GeoPoint, recursively", () => {
    const ts = { toDate: () => new Date("2024-04-04T00:00:00Z") }; // Timestamp duck
    const ref = { path: "users/abc", id: "abc" }; // DocumentReference duck
    const geo = { latitude: 41.01, longitude: 28.97 }; // GeoPoint duck
    const row = normalizeFirestoreDoc("doc1", {
      title: "hi",
      at: ts,
      author: ref,
      where: geo,
      nested: { deep: { when: ts }, list: [ref, "x"] },
    });
    expect(row._id).toBe("doc1");
    expect(row.at).toEqual(new Date("2024-04-04T00:00:00Z"));
    expect(row.author).toBe("users/abc");
    expect(row.where).toEqual({ latitude: 41.01, longitude: 28.97 });
    expect((row.nested as any).deep.when).toEqual(new Date("2024-04-04T00:00:00Z"));
    expect((row.nested as any).list).toEqual(["users/abc", "x"]);
  });
});

describe("normalizeDynamoItem", () => {
  test("hoists the partition key to _id; Sets→arrays; binary dropped", () => {
    const row = normalizeDynamoItem(
      {
        pk: 42,
        name: "widget",
        tags: new Set(["a", "b"]),
        blob: new Uint8Array([1, 2, 3]),
        nested: { inner: new Set([1]), keep: "x", buf: new Uint8Array([9]) },
      },
      "pk",
    );
    expect(row._id).toBe(42);
    expect("pk" in row).toBe(false);
    expect(row.tags).toEqual(["a", "b"]);
    expect("blob" in row).toBe(false);
    expect(row.nested).toEqual({ inner: [1], keep: "x" });
  });
});

// ── Dynamo-shaped end-to-end (numeric partition keys, composite exclusion) ──

const tables: Record<
  string,
  { composite: boolean; items: Record<string, unknown>[] }
> = {
  devices: {
    composite: false,
    items: [
      { _id: 1, model: "sensor-a", firmware: "1.2.0", online: true, readings: { temp: 21.5 } },
      { _id: 2, model: "sensor-b", firmware: "1.3.1", online: false, readings: { temp: 19.0 } },
      { _id: 3, model: "sensor-c", firmware: "1.3.1", online: true, readings: { temp: 24.2 } },
    ],
  },
  events: { composite: true, items: [] }, // HASH+RANGE — must be excluded
};

const fakeDynamo: DocumentSource = {
  listCollections: async () => Object.keys(tables),
  hasCompositeKey: async (t) => tables[t]!.composite,
  count: async (t) => tables[t]!.items.length,
  sample: async (t, n) => tables[t]!.items.slice(0, n),
  findBatch: async (t, o) => {
    let rows = [...tables[t]!.items].sort((a, b) => Number(a._id) - Number(b._id));
    if (o.after !== undefined) rows = rows.filter((r) => Number(r._id) > Number(o.after));
    return rows.slice(0, o.limit);
  },
};

describe("import-db end-to-end (dynamodb-shaped source)", () => {
  let h: TestHarness;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let pak: string;
  const planPath = resolve(tmpdir(), `backlex-dynamo-plan-${randomUUID()}.json`);

  const deps = {
    openSource: (_url: string, opts?: { sampleSize?: number }) => ({
      connector: createDocumentSource("dynamodb", fakeDynamo, opts),
      close: async () => {},
    }),
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const keyRes = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dynamo-e2e" }),
    });
    pak = ((await keyRes.json()) as { data: { secret: string } }).data.secret;
    server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
    url = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    for (const p of [planPath, `${planPath}.state.json`]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    h?.cleanup();
  });

  test("plan: numeric keys → integer pk; composite-key tables excluded", async () => {
    await runImportDb(
      ["plan", "--source", "dynamodb://eu-central-1", "--out", planPath],
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.source.kind).toBe("dynamodb");

    const devices = plan.tables.find((t: any) => t.table === "devices");
    expect(devices.include).toBe(true);
    expect(devices.pkColumn).toBe("_id");
    expect(devices.pkType).toBe("integer");
    expect(devices.fields.find((f: any) => f.column === "readings").type).toBe("json");
    expect(devices.warnings.some((w: string) => w.includes("sample of up to"))).toBe(true);

    const events = plan.tables.find((t: any) => t.table === "events");
    expect(events.include).toBe(false);
    expect(events.reason).toContain("single-column primary key");
    expect(plan.order).toEqual(["devices"]);
  });

  test("run: items land keyed by the partition value", async () => {
    const exitBefore = process.exitCode;
    await runImportDb(
      ["run", planPath, "--source", "dynamodb://eu-central-1", "--url", url, "--key", pak, "--batch", "2"],
      deps,
    );
    expect(process.exitCode).toBe(exitBefore);

    const auth = { authorization: `Bearer ${pak}` };
    const count = (await (
      await fetch(`${url}/api/items/devices?limit=1&meta=filter_count`, { headers: auth })
    ).json()) as { meta: { filter_count: number } };
    expect(count.meta.filter_count).toBe(3);

    const one = (await (
      await fetch(`${url}/api/items/devices/2`, { headers: auth })
    ).json()) as { data: any };
    expect(one.data.model).toBe("sensor-b");
    expect(one.data.online).toBe(false);
    expect(one.data.readings).toEqual({ temp: 19.0 });
  });
});

/**
 * The shape check must refuse readably, not crash.
 *
 * `collectionShapeMismatch` declared `existing.fields` as required and read it
 * unguarded. The API's own type says it is always there, and twice under load
 * on the pre-push gate it was not — the import died with
 * `undefined is not an object (evaluating 'existing.fields.map')` and a stack
 * trace, in a place that had nothing to do with the operator's plan.
 *
 * A TypeError is not something a caller can act on. This is.
 */
describe("collectionShapeMismatch refuses rather than throws", () => {
  const TABLE = {
    slug: "widgets",
    pkType: "text",
    fields: [{ name: "id" }, { name: "title" }],
  } as never;

  test("a collection with no field list is a readable refusal", async () => {
    const { collectionShapeMismatch } = await import("../../../packages/migrate/src/plan");
    // Exactly what the API returned on the runs that crashed.
    const reason = collectionShapeMismatch(TABLE, { pkType: "text" } as never);
    expect(`refused: ${typeof reason === "string"}`).toBe("refused: true");
    // And it must name the collection, or the operator cannot act on it.
    expect(reason).toContain("widgets");
  });

  test("the normal paths still behave — the guard did not swallow them", async () => {
    const { collectionShapeMismatch } = await import("../../../packages/migrate/src/plan");
    // Liveness: the guard sits FIRST, so a bug there would make every call
    // return the same refusal and the assertions below would be the only
    // thing that noticed.
    expect(collectionShapeMismatch(TABLE, { pkType: "text", fields: [{ name: "id" }, { name: "title" }] })).toBeNull();
    expect(collectionShapeMismatch(TABLE, { pkType: "text", fields: [{ name: "id" }] })).toContain("missing");
    expect(collectionShapeMismatch(TABLE, { adopted: true, fields: [] })).toContain("adopted");
  });
});
