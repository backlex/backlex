/**
 * Multi-surface parity for sequence fields.
 *
 * Reading a sequence column proves nothing — it is an ordinary text column on
 * the read path. What has to hold on every surface is the pair of guarantees
 * the server owns:
 *
 *   1. **Every surface that creates a row ISSUES a number.** REST, the batch
 *      endpoint, CSV import and the SDK funnel through `performCreate`; GraphQL
 *      does NOT — its create resolver hand-builds its own INSERT, which is
 *      exactly how the rollup refresh shipped on four surfaces out of five the
 *      first time. That resolver is the reason this file exists.
 *   2. **No surface can write one.** On create OR update: a document number
 *      that can be edited afterwards is not a document number, and an edited
 *      value collides with one the counter is still going to issue.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a
 * thin argv parser over the SDK, and what rots is a subcommand quietly
 * disappearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { schemaAdminTools } from "../src/server/mcp/tools/schema-admin";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcp = (name: string, args: Record<string, unknown>) => {
  const tool = schemaAdminTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const docs = "sur_docs";

/** Every number issued so far, so uniqueness can be asserted across surfaces. */
const allNumbers = async (): Promise<string[]> => {
  const r = (await (await h.fetch(`/api/items/${docs}?limit=200`)).json()) as any;
  return (r.data as any[]).map((x) => x.number as string);
};

const isNumbered = (v: unknown) => typeof v === "string" && /^SUR-\d{4}$/.test(v);

describe("sequence fields — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: docs,
        fields: [
          { name: "title", type: "text" },
          {
            name: "number",
            type: "text",
            required: true,
            unique: true,
            sequence: { pattern: "SUR-{####}" },
          },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("REST issues a number and refuses a write to it", async () => {
    const made = (await (await h.fetch(`/api/items/${docs}`, json({ title: "rest" }))).json()) as any;
    expect(isNumbered(made.data.number)).toBe(true);

    const onCreate = await h.fetch(`/api/items/${docs}`, json({ title: "x", number: "SUR-9001" }));
    expect(onCreate.status).toBe(422);
    const onUpdate = await h.fetch(
      `/api/items/${docs}/${made.data.id}`,
      json({ number: "SUR-9002" }, "PATCH"),
    );
    expect(onUpdate.status).toBe(422);
  });

  test("GraphQL issues a number — its resolver builds its own INSERT", async () => {
    const created = await gql(
      `mutation ($data: SurDocsInput!) { createSurDocs(data: $data) { id number } }`,
      { data: { title: "graphql" } },
    );
    expect(created.errors ?? []).toEqual([]);
    // The whole point of this test: a create that never went through
    // `performCreate` still comes out numbered.
    expect(isNumbered(created.data?.createSurDocs?.number)).toBe(true);

    const id = created.data?.createSurDocs?.id as string;
    const badCreate = await gql(
      `mutation ($data: SurDocsInput!) { createSurDocs(data: $data) { id } }`,
      { data: { title: "y", number: "SUR-9003" } },
    );
    expect((badCreate.errors ?? []).length).toBeGreaterThan(0);
    const badUpdate = await gql(
      `mutation ($id: ID!, $data: SurDocsInput!) { updateSurDocs(id: $id, data: $data) { id } }`,
      { id, data: { number: "SUR-9004" } },
    );
    expect((badUpdate.errors ?? []).length).toBeGreaterThan(0);
  });

  test("SDK issues a number and rejects a write to it", async () => {
    const c = sdk();
    const made = (await c.from(docs).create({ title: "sdk" } as never)) as any;
    expect(isNumbered(made.data.number)).toBe(true);
    await expect(
      c.from(docs).update(made.data.id, { number: "SUR-9005" } as never),
    ).rejects.toThrow(/sequence/i);
  });

  test("batch and CSV import both number every row", async () => {
    const batch = await h.fetch(
      `/api/items/${docs}/batch`,
      json({
        operations: [
          { op: "create", data: { title: "b1" } },
          { op: "create", data: { title: "b2" } },
        ],
      }),
    );
    expect(batch.status).toBeLessThan(300);
    const bBody = (await batch.json()) as any;
    for (const r of bBody.data.results) expect(isNumbered(r.data.number)).toBe(true);

    const csv = await h.fetch(`/api/items/${docs}/import?format=csv`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: "title\ncsv-one\ncsv-two\n",
    });
    expect(csv.status).toBeLessThan(300);
    expect(((await csv.json()) as any).data.inserted).toBe(2);
  });

  test("every number issued across every surface is distinct", async () => {
    const nums = await allNumbers();
    expect(nums.length).toBeGreaterThan(6);
    expect(nums.every(isNumbered)).toBe(true);
    expect(new Set(nums).size).toBe(nums.length);
  });

  test("the peek endpoint reports the next number without consuming it", async () => {
    const before = (await (await h.fetch(`/api/items/${docs}/sequences/next`)).json()) as any;
    const peeked = before.data.number as string;
    expect(isNumbered(peeked)).toBe(true);
    // Peeking twice must give the same answer — a peek that allocated would
    // silently burn a number every time the form was opened.
    const again = (await (await h.fetch(`/api/items/${docs}/sequences/next`)).json()) as any;
    expect(again.data.number).toBe(peeked);
    // And it is genuinely the next one.
    const made = (await (await h.fetch(`/api/items/${docs}`, json({ title: "peeked" }))).json()) as any;
    expect(made.data.number).toBe(peeked);
  });

  test("SDK exposes nextSequences and syncSequences", async () => {
    const c = sdk();
    const next = await c.from(docs).nextSequences();
    expect(isNumbered(next.number)).toBe(true);
    const synced = await c.from(docs).syncSequences();
    expect(synced.ok).toBe(true);
    expect(synced.synced.map((s) => s.field)).toContain("number");
  });

  test("MCP exposes the sync tool and it runs", async () => {
    expect(schemaAdminTools.find((x) => x.name === "schema.sequences_sync")).toBeTruthy();
    const res = (await mcp("schema.sequences_sync", { slug: docs })) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toContain("number");
  });

  test("adding a sequence to a column that already holds numbers catches the counter up", async () => {
    // The adopted-table shape, reproduced entirely through the API: the column
    // exists and already carries `LEG-0499` before anything says it is a
    // sequence. Without the sync on field-add the counter would start at zero
    // and the next create would reissue `LEG-0001`.
    const legacy = "sur_legacy";
    await h.fetch(
      "/api/collections",
      json({
        slug: legacy,
        fields: [
          { name: "title", type: "text" },
          { name: "number", type: "text" },
        ],
      }),
    );
    for (const n of ["LEG-0498", "LEG-0499"]) {
      const r = await h.fetch(`/api/items/${legacy}`, json({ title: n, number: n }));
      expect(r.status).toBe(201);
    }

    const patched = await h.fetch(
      `/api/collections/${legacy}`,
      json(
        {
          fields: [
            { name: "title", type: "text" },
            { name: "number", type: "text", sequence: { pattern: "LEG-{####}" } },
          ],
        },
        "PATCH",
      ),
    );
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as any;
    expect(body.sequenceSync?.[0]?.advanced?.[0]?.to).toBe(499);

    const next = (await (await h.fetch(`/api/items/${legacy}`, json({ title: "new" }))).json()) as any;
    expect(next.data.number).toBe("LEG-0500");

    // And the explicit repair endpoint is idempotent on top of that.
    const again = (await (
      await h.fetch(`/api/items/${legacy}/sequences/sync`, { method: "POST" })
    ).json()) as any;
    expect(again.ok).toBe(true);
    const after = (await (await h.fetch(`/api/items/${legacy}`, json({ title: "after" }))).json()) as any;
    expect(after.data.number).toBe("LEG-0501");
  });

  test("the CLI still carries the sync subcommand", () => {
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/collections.ts"),
      "utf8",
    );
    expect(src).toContain("sync-sequences");
    expect(src).toContain("/sequences/sync");
  });

  test("the OpenAPI spec documents both sequence endpoints", async () => {
    const spec = (await (await h.fetch("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    const keys = Object.keys(spec.paths);
    expect(keys.some((p) => p.endsWith("/sequences/sync"))).toBe(true);
    expect(keys.some((p) => p.endsWith("/sequences/next"))).toBe(true);
  });
});
