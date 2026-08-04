/**
 * Multi-surface parity for email fields.
 *
 * The gate is not "an email field can be read from five places". It is the one
 * claim the type makes, restated on every surface that writes:
 *
 *   **What lands in the column is canonical, whichever door the write came
 *   through.** A surface that hand-builds its own INSERT and skips the folding
 *   stores whatever the caller typed — and then `unique` enforces nothing, a
 *   lookup by address misses, and the portal auto-link never finds the person
 *   row it was supposed to stamp. This is not hypothetical: GraphQL's create
 *   resolver does hand-build its INSERT, and #38, #39, #40, #41 and #43 each
 *   found it that way.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a thin
 * argv parser over the SDK, and what rots is a type quietly missing from the
 * codegen map or a subcommand missing from the help.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { isEmail, parseEmail } from "../../../packages/db/src/email";
import { schemaAdminTools } from "../src/server/mcp/tools/schema-admin";
import { emailTools } from "../src/server/mcp/tools/email";
import { TEMPLATES } from "../src/server/templates/catalog";
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

const slug = "par_email";
let table = "";

/** The raw string in the column, which is the whole claim under test. */
const storedEmail = async (id: string): Promise<unknown> => {
  const r = await h.fetch(
    "/api/admin/db/sql/run",
    json({ sql: `SELECT email FROM ${table} WHERE id = '${id}'` }),
  );
  return ((await r.json()) as any).data?.[0]?.rows?.[0]?.email;
};

describe("email fields — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "email" },
        ],
      }),
    );
    table = ((await created.json()) as any).data.physicalTable;
    expect(table.length).toBeGreaterThan(0);
  });

  test("REST folds, in the body and in the column", async () => {
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "rest", email: " Ada@Example.COM " }));
    const body = (await r.json()) as any;
    expect(r.status).toBe(201);
    expect(body.data.email).toBe("ada@example.com");
    expect(await storedEmail(body.data.id)).toBe("ada@example.com");
  });

  test("the SDK agrees with REST, byte for byte", async () => {
    const created = (
      (await sdk()
        .from<Record<string, unknown>>(slug)
        .create({ name: "sdk", email: "Bob@Example.com" })) as any
    ).data;
    expect(created.email).toBe("bob@example.com");
    expect(await storedEmail(created.id as string)).toBe("bob@example.com");
  });

  test("GraphQL — which builds its own INSERT — folds the same way", async () => {
    const res = await gql(
      `mutation { createParEmail(data: { name: "gql", email: "  Carol@Example.COM " }) { id email } }`,
    );
    expect(res.errors).toBeUndefined();
    const row = res.data?.createParEmail;
    expect(row.email).toBe("carol@example.com");
    // The claim that actually breaks when a surface forgets: the column.
    expect(await storedEmail(row.id)).toBe("carol@example.com");
  });

  test("GraphQL update folds too, and its read matches REST's", async () => {
    const created = await gql(
      `mutation { createParEmail(data: { name: "gqlpatch", email: "old@example.com" }) { id } }`,
    );
    const id = created.data?.createParEmail.id as string;
    const updated = await gql(
      `mutation($id: ID!) { updateParEmail(id: $id, data: { email: "NEW@Example.COM" }) { id email } }`,
      { id },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateParEmail.email).toBe("new@example.com");
    expect(await storedEmail(id)).toBe("new@example.com");
    const rest = (await (await h.fetch(`/api/items/${slug}/${id}`)).json()) as any;
    expect(rest.data.email).toBe(updated.data?.updateParEmail.email);
  });

  test("GraphQL refuses an unreadable address, like REST does", async () => {
    const res = await gql(
      `mutation { createParEmail(data: { name: "bad", email: "drop me a line" }) { id } }`,
    );
    expect(res.errors?.[0]?.message).toContain("email");
  });

  test("GraphQL folds an internationalized domain, not just the case", async () => {
    // The half a `.toLowerCase()` in the resolver would appear to fix.
    const res = await gql(
      `mutation { createParEmail(data: { name: "idn", email: "ada@örnek.com" }) { id email } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.createParEmail.email).toBe("ada@xn--rnek-4qa.com");
  });

  test("GraphQL enforces the domain allow-list, which it gets for free", async () => {
    // Worth pinning because GraphQL never calls `validateValue` — it is the one
    // surface where a write-time RULE could go missing while the folding still
    // worked. It holds here because `canonicalizeEmailFields` parses through
    // `parseEmailForField`, which carries the allow-list, rather than through a
    // bare fold. A refactor that "simplified" that call would open a hole no
    // other surface has.
    await h.fetch(
      "/api/collections",
      json({
        slug: "par_email_dom",
        fields: [{ name: "email", type: "email", email: { allowedDomains: ["example.com"] } }],
      }),
    );
    const ok = await gql(
      `mutation { createParEmailDom(data: { email: "ada@mail.example.com" }) { id email } }`,
    );
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.createParEmailDom.email).toBe("ada@mail.example.com");
    const refused = await gql(
      `mutation { createParEmailDom(data: { email: "ada@elsewhere.com" }) { id } }`,
    );
    expect(refused.errors?.[0]?.message).toContain("example.com");
  });

  test("the batch endpoint folds every row it writes", async () => {
    const r = await h.fetch(
      `/api/items/${slug}/batch`,
      json({
        operations: [
          { op: "create", data: { name: "batch1", email: "Dave@Example.com" } },
          { op: "create", data: { name: "batch2", email: " DAVE@EXAMPLE.COM " } },
        ],
      }),
    );
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    for (const row of body.data.results) {
      expect(await storedEmail(row.id)).toBe("dave@example.com");
    }
  });

  test("MCP can create an email collection, and writes to it fold", async () => {
    const tool = schemaAdminTools.find((x) => x.name === "schema.create_collection")!;
    const res: any = await tool.handler(
      { slug: "par_email_mcp", fields: [{ name: "email", type: "email" }] },
      { fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) } as never,
    );
    expect(JSON.stringify(res)).not.toMatch(/"isError":\s*true/);
    const created = await h.fetch("/api/items/par_email_mcp", json({ email: "Eve@Example.COM" }));
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).data.email).toBe("eve@example.com");
  });

  test("the MCP normalize tool exists and points at the REST route", () => {
    const tool = emailTools.find((t) => t.name === "email.normalize");
    expect(tool).toBeTruthy();
    // The description has to tell an agent the loop shape, or it will call once
    // and report the collection as done.
    expect(tool!.description).toMatch(/cursor/i);
    // …and that a collision is a thing it will be handed back, or it will treat
    // a partially-normalized unique column as a failure and retry forever.
    expect(tool!.description).toMatch(/collide|duplicate/i);
    expect(tool!.inputSchema.properties).toHaveProperty("after");
    expect(tool!.inputSchema.properties).toHaveProperty("dryRun");
  });

  test("the MCP schema tool documents the type, so an agent can create one", () => {
    const create = schemaAdminTools.find((t) => t.name === "schema.create_collection");
    const desc = JSON.stringify(create?.inputSchema ?? {});
    expect(desc).toContain("email");
    expect(desc).toContain("allowedDomains");
  });

  test("the CLI knows the subcommand and the SDK method it calls", () => {
    const cli = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/collections.ts"),
      "utf8",
    );
    expect(cli).toContain("normalize-emails");
    expect(cli).toContain("/api/email/normalize/");
    // A `--dry-run` that the help mentions but the parser ignores is worse than
    // no flag at all.
    expect(cli).toContain("--dry-run");
  });

  test("the generated TS types map the new type rather than dropping it", () => {
    const gen = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/gen-types.ts"),
      "utf8",
    );
    expect(gen).toMatch(/email: "string"/);
  });
});

describe("the eight regexes that did not agree", () => {
  /**
   * The corpus that split them.
   *
   * `field-types.ts` admitted `,`, `;`, `<`, `>` and `"`; `reports`,
   * `signatures` and `booking` rejected exactly those. An address could
   * therefore be stored months earlier, pass validation, and be refused by the
   * thing that was supposed to mail it. There is one validator now, and this is
   * the corpus that proves the send paths use it.
   */
  const CORPUS = [
    "ada@example.com",
    "ada.lovelace+news@mail.example.co.uk",
    "a,b@example.com",
    "a;b@example.com",
    "a<b@example.com",
    'a"b@example.com',
    "ada@localhost",
    "ada@[192.0.2.1]",
    "ada bell@example.com",
    "",
    "@",
  ];

  test("the disagreement was real — this is not a vacuous corpus", () => {
    // Pinned as literals so the test still means something once the originals
    // are gone. LEFT: what `field-types.ts` used to accept at write time. RIGHT:
    // what `reports`/`signatures`/`booking` used to accept at send time. The
    // gap between them is the bug: a value could be stored months earlier, pass
    // validation, and then be refused by the thing that was supposed to mail it.
    const OLD_FIELD_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const OLD_SEND_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
    const disagreed = CORPUS.filter((v) => OLD_FIELD_RE.test(v) !== OLD_SEND_RE.test(v));
    expect(disagreed).toEqual([
      "a,b@example.com",
      "a;b@example.com",
      "a<b@example.com",
      'a"b@example.com',
    ]);
    // And the corpus also has to contain values the OLD field regex accepted
    // that the shared validator now refuses outright, or "one validator" would
    // just mean "the loosest one won".
    expect(CORPUS.some((v) => OLD_FIELD_RE.test(v) && !isEmail(v))).toBe(true);
  });

  test("the send paths judge exactly what the field type judges", async () => {
    const { normalizeEmail: bookingEmail } = await import("../src/server/services/booking");
    const { normalizeEmail: signerEmail } = await import("../src/server/services/signatures");
    for (const value of CORPUS) {
      const accepted = isEmail(value);
      let bookingOk = true;
      try {
        bookingEmail(value);
      } catch {
        bookingOk = false;
      }
      let signerOk = true;
      try {
        signerEmail(value);
      } catch {
        signerOk = false;
      }
      expect({ value, bookingOk }).toEqual({ value, bookingOk: accepted });
      expect({ value, signerOk }).toEqual({ value, signerOk: accepted });
    }
  });

  test("the send paths FOLD, so a booking twice is one customer", async () => {
    const { normalizeEmail } = await import("../src/server/services/booking");
    expect(normalizeEmail(" Ada@Example.COM ")).toBe("ada@example.com");
  });

  test("a report recipient list is folded, which also collapses a doubled name", async () => {
    const { parseRecipients } = await import("../src/server/services/reports");
    expect(parseRecipients("Ada@Example.com, ada@example.com")).toEqual([
      "ada@example.com",
      "ada@example.com",
    ]);
    expect(() => parseRecipients("ada@localhost")).toThrow();
  });

  test("the integrations copy agrees, since it cannot import the shared one", async () => {
    // `@backlex/integrations` may not depend on `@backlex/db`, so its
    // `EMAIL_LIKE` is a second hand-written pattern by necessity — the same
    // arrangement `E164_PATTERN` has. Rather than trusting two regexes to stay
    // in step, this asserts it on the corpus that matters: everything the shared
    // validator ACCEPTS must survive the provider's own check, or a contact the
    // workspace holds would be silently dropped from a marketing-list sync.
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/integrations/src/providers/mailchimp.ts"),
      "utf8",
    );
    const m = src.match(/const EMAIL_LIKE = (\/.+\/);/);
    expect(m).toBeTruthy();
    // biome-ignore lint/security/noGlobalEval: reading the provider's own literal
    const providerRe = eval(m![1]!) as RegExp;
    for (const value of CORPUS) {
      if (!isEmail(value)) continue;
      expect({ value, ok: providerRe.test(parseEmail(value).email) }).toEqual({ value, ok: true });
    }
  });
});

describe("the schema templates", () => {
  test("every email sample row is already canonical", () => {
    // Sample seeding inserts DIRECTLY into the physical table, so it never goes
    // through `canonicalizeEmailFields` — a sample written the way a human would
    // type it would seed a fresh workspace with exactly the rows this type
    // exists to prevent.
    const problems: string[] = [];
    let checked = 0;
    for (const t of TEMPLATES) {
      for (const c of t.collections) {
        const emailFields = c.fields.filter((f) => f.type === "email");
        for (const row of c.samples ?? []) {
          for (const f of emailFields) {
            const v = (row as Record<string, unknown>)[f.name];
            if (v === undefined || v === null || v === "") continue;
            checked++;
            const parsed = parseEmail(v as string, f.email);
            if (parsed.email !== v) problems.push(`${t.id}.${c.slug}.${f.name}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    // Guards against the assertion passing because nothing was found.
    expect(checked).toBeGreaterThan(50);
  });

  test("the catalog converted every address column, not just the obvious ones", () => {
    // `inbound_address` is the one whose NAME does not say "email" — the field a
    // name-based sweep misses.
    let count = 0;
    const templates = new Set<string>();
    for (const t of TEMPLATES) {
      for (const c of t.collections) {
        for (const f of c.fields) {
          if (f.type === "email") {
            count++;
            templates.add(t.id);
          }
          // Nothing may be left behind as `text` + the old interface hint.
          if (f.type === "text" && f.interface === "email") {
            throw new Error(`${t.id}.${c.slug}.${f.name} is still a text column`);
          }
        }
      }
    }
    expect(count).toBe(58);
    expect(templates.size).toBe(25);
  });

  test("the unique email columns are the reason this exists", () => {
    // Fourteen of them, and while the column was plain text every one was
    // enforcing nothing against the commonest way an address gets written twice.
    const unique = TEMPLATES.flatMap((t) =>
      t.collections.flatMap((c) => c.fields.filter((f) => f.type === "email" && f.unique)),
    );
    expect(unique.length).toBe(14);
  });
});

describe("normalizing what was already there", () => {
  let hh: TestHarness;
  const nslug = "em_legacy";
  let ntable = "";

  const rows = async (): Promise<Record<string, unknown>[]> => {
    const r = await hh.fetch(
      "/api/admin/db/sql/run",
      json({ sql: `SELECT id, email FROM ${ntable} ORDER BY id` }),
    );
    return ((await r.json()) as any).data?.[0]?.rows ?? [];
  };

  beforeAll(async () => {
    hh = makeHarness();
    await seedAdmin(hh);
    // Created as TEXT, filled the way people type, and only THEN made an email
    // field — which is the actual migration path, and the reason the route
    // exists at all.
    const created = await hh.fetch(
      "/api/collections",
      json({
        slug: nslug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "text" },
        ],
      }),
    );
    ntable = ((await created.json()) as any).data.physicalTable;
    for (const [name, email] of [
      ["a", "Ada@Example.com"],
      ["b", "  bob@EXAMPLE.com  "],
      ["c", "already@example.com"],
      ["d", "not an address"],
    ]) {
      await hh.fetch(`/api/items/${nslug}`, json({ name, email }));
    }
    await hh.fetch(
      `/api/collections/${nslug}`,
      json({ fields: [{ name: "email", type: "email" }] }, "PATCH"),
    );
  });

  test("a dry run reports what would change and writes nothing", async () => {
    const before = await rows();
    const r = await hh.fetch(
      `/api/email/normalize/${nslug}`,
      json({ field: "email", dryRun: true }),
    );
    const d = ((await r.json()) as any).data;
    expect(d.normalized).toBe(2);
    expect(d.alreadyCanonical).toBe(1);
    expect(d.unreadable).toBe(1);
    expect(d.unreadableIds).toHaveLength(1);
    expect(await rows()).toEqual(before);
  });

  test("the real pass rewrites only what it can read, and is idempotent", async () => {
    const first = ((await (
      await hh.fetch(`/api/email/normalize/${nslug}`, json({ field: "email" }))
    ).json()) as any).data;
    expect(first.normalized).toBe(2);
    const values = (await rows()).map((r) => r.email);
    expect(values).toContain("ada@example.com");
    expect(values).toContain("bob@example.com");
    // Left exactly as it is — overwriting it destroys the only copy.
    expect(values).toContain("not an address");

    const second = ((await (
      await hh.fetch(`/api/email/normalize/${nslug}`, json({ field: "email" }))
    ).json()) as any).data;
    expect(second.normalized).toBe(0);
    expect(second.alreadyCanonical).toBe(3);
  });

  test("the report never returns the addresses themselves", async () => {
    // It is a plausible thing to log, and each one identifies a real person.
    const r = await hh.fetch(`/api/email/normalize/${nslug}`, json({ field: "email" }));
    const text = await r.text();
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("not an address");
  });

  test("the cursor walks the whole table rather than re-reading page one", async () => {
    let after: string | undefined;
    let scanned = 0;
    let pages = 0;
    for (;;) {
      const d = ((await (
        await hh.fetch(
          `/api/email/normalize/${nslug}`,
          json({ field: "email", limit: 1, ...(after ? { after } : {}) }),
        )
      ).json()) as any).data;
      scanned += d.scanned;
      pages++;
      if (!d.cursor || pages > 10) break;
      after = d.cursor;
    }
    expect(scanned).toBe(4);
    expect(pages).toBeLessThanOrEqual(5);
  });

  test("normalizing refuses a field that is not an email field", async () => {
    const r = await hh.fetch(`/api/email/normalize/${nslug}`, json({ field: "name" }));
    expect(r.status).toBe(422);
  });
});

describe("folding can create a duplicate, and the pass refuses to resolve it", () => {
  let hh: TestHarness;
  const uslug = "em_dupes";
  let utable = "";

  beforeAll(async () => {
    hh = makeHarness();
    await seedAdmin(hh);
    const created = await hh.fetch(
      "/api/collections",
      json({
        slug: uslug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "text", unique: true },
        ],
      }),
    );
    utable = ((await created.json()) as any).data.physicalTable;
    // The exact pair the type exists to prevent, in a column that was `unique`
    // the whole time and could not see it.
    await hh.fetch(`/api/items/${uslug}`, json({ name: "one", email: "ada@example.com" }));
    await hh.fetch(`/api/items/${uslug}`, json({ name: "two", email: "Ada@Example.COM" }));
    await hh.fetch(
      `/api/collections/${uslug}`,
      json({ fields: [{ name: "email", type: "email", unique: true }] }, "PATCH"),
    );
  });

  test("the collision is reported, both rows are left alone, and nothing 500s", async () => {
    const r = await hh.fetch(`/api/email/normalize/${uslug}`, json({ field: "email" }));
    expect(r.status).toBe(200);
    const d = ((await r.json()) as any).data;
    expect(d.collided).toBe(1);
    expect(d.collidedIds).toHaveLength(1);
    expect(d.normalized).toBe(0);

    const after = ((await (
      await hh.fetch("/api/admin/db/sql/run", json({ sql: `SELECT email FROM ${utable}` }))
    ).json()) as any).data?.[0]?.rows?.map((x: any) => x.email);
    // Which of the two is the real customer is a question about the business.
    expect(after).toContain("ada@example.com");
    expect(after).toContain("Ada@Example.COM");
  });

  test("a dry run surfaces the duplicates before anything is written", async () => {
    const d = ((await (
      await hh.fetch(`/api/email/normalize/${uslug}`, json({ field: "email", dryRun: true }))
    ).json()) as any).data;
    expect(d.collided).toBe(1);
  });
});
