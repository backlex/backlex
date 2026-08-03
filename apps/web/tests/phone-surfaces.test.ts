/**
 * Multi-surface parity for phone fields.
 *
 * The gate is not "a phone field can be read from five places". It is the one
 * claim the type makes, restated on every surface that writes:
 *
 *   **What lands in the column is canonical E.164, whichever door the write came
 *   through.** A surface that hand-builds its own INSERT and skips the
 *   canonicalization stores whatever the caller typed — and then `unique`
 *   enforces nothing, a lookup by number misses, and the `sms` op refuses the
 *   row at run time. This is not hypothetical: GraphQL's create resolver does
 *   hand-build its INSERT, and #38, #39, #40 and #41 each found it that way.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a thin
 * argv parser over the SDK, and what rots is a type quietly missing from the
 * codegen map or a subcommand missing from the help.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { parsePhone } from "../../../packages/db/src/phone";
import { schemaAdminTools } from "../src/server/mcp/tools/schema-admin";
import { phoneTools } from "../src/server/mcp/tools/phone";
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

const slug = "par_phone";
let table = "";

/** The raw string in the column, which is the whole claim under test. */
const storedPhone = async (id: string): Promise<unknown> => {
  const r = await h.fetch(
    "/api/admin/db/sql/run",
    json({ sql: `SELECT phone FROM ${table} WHERE id = '${id}'` }),
  );
  return ((await r.json()) as any).data?.[0]?.rows?.[0]?.phone;
};

describe("phone fields — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "phone", type: "phone", phone: { region: "TR" } },
        ],
      }),
    );
    table = ((await created.json()) as any).data.physicalTable;
    expect(table.length).toBeGreaterThan(0);
  });

  test("REST canonicalizes, in the body and in the column", async () => {
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "rest", phone: "0532 111 22 33" }));
    const body = (await r.json()) as any;
    expect(r.status).toBe(201);
    expect(body.data.phone).toBe("+905321112233");
    expect(await storedPhone(body.data.id)).toBe("+905321112233");
  });

  test("the SDK agrees with REST, byte for byte", async () => {
    const created = (
      (await sdk()
        .from<Record<string, unknown>>(slug)
        .create({ name: "sdk", phone: "(532) 111-2233" })) as any
    ).data;
    expect(created.phone).toBe("+905321112233");
    expect(await storedPhone(created.id as string)).toBe("+905321112233");
  });

  test("GraphQL — which builds its own INSERT — canonicalizes the same way", async () => {
    const res = await gql(
      `mutation { createParPhone(data: { name: "gql", phone: "0532 111 22 33" }) { id phone } }`,
    );
    expect(res.errors).toBeUndefined();
    const row = res.data?.createParPhone;
    expect(row.phone).toBe("+905321112233");
    // The claim that actually breaks when a surface forgets: the column.
    expect(await storedPhone(row.id)).toBe("+905321112233");
  });

  test("GraphQL update canonicalizes too, and its read matches REST's", async () => {
    const created = await gql(
      `mutation { createParPhone(data: { name: "gqlpatch", phone: "+905320000000" }) { id } }`,
    );
    const id = created.data?.createParPhone.id as string;
    const updated = await gql(
      `mutation($id: ID!) { updateParPhone(id: $id, data: { phone: "0532 999 88 77" }) { id phone } }`,
      { id },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateParPhone.phone).toBe("+905329998877");
    expect(await storedPhone(id)).toBe("+905329998877");
    const rest = (await (await h.fetch(`/api/items/${slug}/${id}`)).json()) as any;
    expect(rest.data.phone).toBe(updated.data?.updateParPhone.phone);
  });

  test("GraphQL refuses an unreadable number, like REST does", async () => {
    const res = await gql(
      `mutation { createParPhone(data: { name: "bad", phone: "ring the bell" }) { id } }`,
    );
    expect(res.errors?.[0]?.message).toContain("phone");
  });

  test("the batch endpoint canonicalizes every row it writes", async () => {
    const r = await h.fetch(
      `/api/items/${slug}/batch`,
      json({
        operations: [
          { op: "create", data: { name: "batch1", phone: "0532 111 22 33" } },
          { op: "create", data: { name: "batch2", phone: "+90 (532) 111-22-33" } },
        ],
      }),
    );
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    for (const row of body.data.results) {
      expect(await storedPhone(row.id)).toBe("+905321112233");
    }
  });

  test("MCP can create a phone collection, and writes to it canonicalize", async () => {
    const tool = schemaAdminTools.find((x) => x.name === "schema.create_collection")!;
    const res: any = await tool.handler(
      {
        slug: "par_phone_mcp",
        fields: [{ name: "phone", type: "phone", phone: { region: "US" } }],
      },
      { fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) } as never,
    );
    expect(JSON.stringify(res)).not.toMatch(/"isError":\s*true/);
    const created = await h.fetch("/api/items/par_phone_mcp", json({ phone: "(415) 555-2671" }));
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).data.phone).toBe("+14155552671");
  });

  test("the MCP normalize tool exists and points at the REST route", () => {
    const tool = phoneTools.find((t) => t.name === "phone.normalize");
    expect(tool).toBeTruthy();
    // The description has to tell an agent the loop shape, or it will call once
    // and report the collection as done.
    expect(tool!.description).toMatch(/cursor/i);
    expect(tool!.inputSchema.properties).toHaveProperty("after");
    expect(tool!.inputSchema.properties).toHaveProperty("dryRun");
  });

  test("the MCP schema tool documents the type, so an agent can create one", () => {
    const create = schemaAdminTools.find((t) => t.name === "schema.create_collection");
    const desc = JSON.stringify(create?.inputSchema ?? {});
    expect(desc).toContain("phone");
    // Naming the type without naming `region` would have an agent produce a
    // field that silently refuses every national number in the workspace.
    expect(desc).toContain("region");
  });

  test("the CLI knows the subcommand and the SDK method it calls", () => {
    const cli = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/collections.ts"),
      "utf8",
    );
    expect(cli).toContain("normalize-phones");
    expect(cli).toContain("/api/phone/normalize/");
    // A `--dry-run` that the help mentions but the parser ignores is worse than
    // no flag at all.
    expect(cli).toContain("--dry-run");
  });

  test("the generated TS types map the new type rather than dropping it", () => {
    const gen = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/gen-types.ts"),
      "utf8",
    );
    expect(gen).toMatch(/phone: "string"/);
  });
});

describe("the schema templates", () => {
  test("every phone sample row is already canonical", async () => {
    // Sample seeding inserts DIRECTLY into the physical table, so it never goes
    // through `canonicalizePhoneFields` — a sample written the way a human would
    // write it lands in the column verbatim and every seeded workspace starts
    // with exactly the mess this type exists to end. Nothing else catches that:
    // the seed succeeds, the rows look fine, and the first symptom is an SMS
    // flow refusing a row months later.
    const { TEMPLATES } = await import("../src/server/templates/catalog");
    const phoneish = /(^|_)(phone|mobile|tel|whatsapp|fax|msisdn)($|_)/i;
    const offenders: string[] = [];
    let checked = 0;
    for (const tpl of TEMPLATES as any[]) {
      for (const col of tpl.collections ?? []) {
        const phoneFields = new Set(
          (col.fields ?? []).filter((f: any) => f.type === "phone").map((f: any) => f.name),
        );
        for (const sample of col.samples ?? []) {
          for (const [key, value] of Object.entries(sample)) {
            if (!phoneFields.has(key) || typeof value !== "string") continue;
            checked++;
            if (parsePhone(value).e164 !== value) {
              offenders.push(`${tpl.id}.${col.slug}.${key}`);
            }
          }
        }
        // …and a phone-shaped column that is still plain text is a conversion
        // that was missed, which is the other half of the same drift.
        for (const f of col.fields ?? []) {
          if (phoneish.test(f.name) && f.type === "text") {
            offenders.push(`${tpl.id}.${col.slug}.${f.name} is still text`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // Proven non-vacuous: an empty corpus would pass the assertion above.
    expect(checked).toBeGreaterThan(20);
  });
});

describe("normalizing what was already there", () => {
  const slug2 = "par_phone_legacy";
  let table2 = "";

  beforeAll(async () => {
    const created = await h.fetch(
      "/api/collections",
      json({
        slug: slug2,
        // Created as plain TEXT, which is what all thirty-six template columns
        // were — so this is exactly the migration an existing workspace faces.
        fields: [
          { name: "name", type: "text", required: true },
          { name: "phone", type: "text" },
        ],
      }),
    );
    table2 = ((await created.json()) as any).data.physicalTable;
    for (const [name, phone] of [
      ["a", "0532 111 22 33"],
      ["b", "+905329998877"],
      ["c", "ring the bell"],
    ]) {
      await h.fetch(`/api/items/${slug2}`, json({ name, phone }));
    }
    // Now make it a phone field — no migration, because the column type is
    // identical. Only the values need fixing.
    await h.fetch(
      `/api/collections/${slug2}`,
      json(
        {
          fields: [
            { name: "name", type: "text", required: true },
            { name: "phone", type: "phone", phone: { region: "TR" } },
          ],
        },
        "PATCH",
      ),
    );
  });

  test("a dry run reports what would change and writes nothing", async () => {
    const r = await h.fetch(`/api/phone/normalize/${slug2}`, json({ field: "phone", dryRun: true }));
    const d = ((await r.json()) as any).data;
    expect(d.normalized).toBe(1);
    expect(d.alreadyCanonical).toBe(1);
    expect(d.unreadable).toBe(1);
    // Reported by id so an operator can go and look — never by value.
    expect(d.unreadableIds).toHaveLength(1);
    expect(JSON.stringify(d)).not.toContain("ring the bell");
    const still = await h.fetch(
      "/api/admin/db/sql/run",
      json({ sql: `SELECT phone FROM ${table2} WHERE name = 'a'` }),
    );
    expect(((await still.json()) as any).data?.[0]?.rows?.[0]?.phone).toBe("0532 111 22 33");
  });

  test("the real pass rewrites only what it can read, and is idempotent", async () => {
    const first = ((await (
      await h.fetch(`/api/phone/normalize/${slug2}`, json({ field: "phone" }))
    ).json()) as any).data;
    expect(first.normalized).toBe(1);
    expect(first.cursor).toBeNull();

    const rows = await h.fetch(
      "/api/admin/db/sql/run",
      json({ sql: `SELECT name, phone FROM ${table2} ORDER BY name` }),
    );
    const got = ((await rows.json()) as any).data?.[0]?.rows as { name: string; phone: string }[];
    expect(got.find((r) => r.name === "a")?.phone).toBe("+905321112233");
    expect(got.find((r) => r.name === "b")?.phone).toBe("+905329998877");
    // Left exactly as it was: overwriting a value nobody can parse destroys the
    // only copy of whatever it was.
    expect(got.find((r) => r.name === "c")?.phone).toBe("ring the bell");

    const second = ((await (
      await h.fetch(`/api/phone/normalize/${slug2}`, json({ field: "phone" }))
    ).json()) as any).data;
    expect(second.normalized).toBe(0);
    expect(second.alreadyCanonical).toBe(2);
  });

  test("the cursor walks the whole table rather than re-reading page one", async () => {
    // The failure this shape exists to prevent: an already-canonical row never
    // leaves the candidate set, so a `remaining`-based loop would never finish.
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const d = ((await (
        await h.fetch(
          `/api/phone/normalize/${slug2}`,
          json({ field: "phone", limit: 1, ...(after ? { after } : {}) }),
        )
      ).json()) as any).data;
      seen.push(String(d.cursor));
      if (!d.cursor) break;
      after = d.cursor;
    }
    // Three rows at one per page, then a short page that ends it — and every
    // cursor distinct, which is what proves it moved.
    expect(new Set(seen.filter((s) => s !== "null")).size).toBe(seen.filter((s) => s !== "null").length);
    expect(seen[seen.length - 1]).toBe("null");
  });

  test("normalizing refuses a field that is not a phone field", async () => {
    const r = await h.fetch(`/api/phone/normalize/${slug2}`, json({ field: "name" }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("the SDK exposes the same loop", async () => {
    const report = await sdk().from(slug2).normalizePhones("phone", { dryRun: true });
    expect(report.alreadyCanonical).toBe(2);
    expect(report.cursor).toBeNull();
  });
});
