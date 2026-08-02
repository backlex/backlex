/**
 * The `document.sign` flow op — "an agreement row landed" → freeze it → send it
 * to the people who have to sign.
 *
 * Two things are pinned harder than the happy path:
 *
 * - the op's RESULT carries no signing links. Op results are persisted in the
 *   run log, and a link is a bearer credential for somebody else's signature;
 * - the signer list may be a single template resolving to an array, because a
 *   lease with two tenants cannot be written out statically in the flow.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("document.sign flow op", () => {
  let h: TestHarness;
  let client: Database;
  let restore: typeof console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH as string);
    restore = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (!line.startsWith("[email]")) restore(...args);
    };
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = { name: "stub", render: async () => FAKE_PDF };
  });
  afterEach(() => {
    console.log = restore;
    h.cleanup();
  });

  const save = (op: Record<string, unknown>) =>
    h.fetch(
      "/api/flows",
      json({ name: `sig-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: [op] }),
    );

  const run = async (ops: Record<string, unknown>[], data: Record<string, unknown> = {}) => {
    const created = await h.fetch(
      "/api/flows",
      json({ name: `sig-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: ops }),
    );
    expect(created.status).toBe(201);
    const { data: flow } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${flow.id}/run`, json(data));
    return (await res.json()) as { ok: boolean; error?: string; results?: unknown[] };
  };

  describe("saving", () => {
    test("refuses an op with neither a template nor html", async () => {
      const res = await save({ type: "document.sign", signers: [{ email: "a@example.com" }] });
      expect(res.status).toBe(422);
    });

    test("refuses an op with both", async () => {
      // Both would let the inline body silently beat the stored template.
      const res = await save({
        type: "document.sign",
        templateKey: "lease",
        html: "<html>x</html>",
        signers: [{ email: "a@example.com" }],
      });
      expect(res.status).toBe(422);
    });

    test("accepts a templated signer list, which only resolves at run time", async () => {
      const res = await save({
        type: "document.sign",
        html: "<html>x</html>",
        signers: "{{ data.parties }}",
      });
      expect(res.status).toBe(201);
    });
  });

  describe("running", () => {
    test("freezes the row into a request and mails the signer", async () => {
      const out = await run(
        [
          {
            type: "document.sign",
            html: "<html><body>Lease for {{ data.tenant }}</body></html>",
            title: "Lease {{ data.no }}",
            signers: [{ email: "{{ data.email }}", name: "{{ data.tenant }}", role: "Tenant" }],
          },
        ],
        { tenant: "Ayşe Yılmaz", email: "tenant@example.com", no: "2026-9" },
      );
      expect(out.ok).toBe(true);

      const row = client
        .query("select title as t, body_html as b, status as s from signature_requests")
        .get() as { t: string; b: string; s: string };
      expect(row.t).toBe("Lease 2026-9");
      expect(row.b).toContain("Lease for Ayşe Yılmaz");
      expect(row.s).toBe("pending");

      const signer = client
        .query("select email as e, name as n, role as r from signature_signers")
        .get() as { e: string; n: string; r: string };
      expect(signer).toMatchObject({ e: "tenant@example.com", n: "Ayşe Yılmaz", r: "Tenant" });
    });

    test("no signing link reaches $last, where the rest of the flow could read it", async () => {
      // Whatever an op returns is readable by every op after it — a `webhook`
      // posting `{{ $last }}` onward, a `log` writing it to the server log. A
      // signing link is a bearer credential for somebody else's signature, so
      // it stops here and the invitation is sent by the op itself.
      const lines: string[] = [];
      const prev = console.log;
      console.log = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        if (line.startsWith("[flow] LAST")) lines.push(line);
      };
      try {
        const out = await run([
          { type: "document.sign", html: "<html>x</html>", signers: [{ email: "a@example.com" }] },
          {
            type: "log",
            message: "LAST id={{ $last.id }} url={{ $last.url }} token={{ $last.token }}",
          },
        ]);
        expect(out.ok).toBe(true);
      } finally {
        console.log = prev;
      }

      const id = client.query("select id as i from signature_requests").get() as { i: string };
      // Enough to follow the request up…
      expect(lines[0]).toContain(`id=${id.i}`);
      // …and nothing to sign with.
      expect(lines[0]).toContain("url= ");
      expect(lines[0]).toMatch(/token=$/);
      expect(lines.join("")).not.toContain("sig_");
    });

    test("a signer list can arrive as one template resolving to an array", async () => {
      const out = await run(
        [{ type: "document.sign", html: "<html>x</html>", signers: "{{ data.parties }}", ordered: true }],
        {
          parties: [
            { email: "tenant@example.com", role: "Tenant" },
            { email: "landlord@example.com", role: "Landlord" },
          ],
        },
      );
      expect(out.ok).toBe(true);
      const rows = client
        .query("select email as e from signature_signers order by order_index")
        .all() as Array<{ e: string }>;
      expect(rows.map((r) => r.e)).toEqual(["tenant@example.com", "landlord@example.com"]);

      // Ordered: only the first person is written to, because the second's
      // link would answer "not your turn", which reads as a broken link.
      const sent = client
        .query("select count(*) as n from signature_signers where sent_at is not null")
        .get() as { n: number };
      expect(sent.n).toBe(1);
    });

    test("an empty signer list fails the run rather than filing a request nobody signs", async () => {
      const out = await run([{ type: "document.sign", html: "<html>x</html>", signers: "{{ data.parties }}" }], {
        parties: [],
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/no signers/i);
      expect(client.query("select count(*) as n from signature_requests").get()).toMatchObject({ n: 0 });
    });

    test("the write-back target is templated from the triggering row", async () => {
      await h.fetch(
        "/api/collections",
        json({
          slug: "agreements",
          name: "Agreements",
          fields: [
            { name: "tenant", type: "text" },
            { name: "signed_doc", type: "text" },
          ],
        }),
      );
      const created = await h.fetch("/api/items/agreements", json({ tenant: "Ayşe" }));
      const { data: row } = (await created.json()) as { data: { id: string } };

      const out = await run(
        [
          {
            type: "document.sign",
            html: "<html>x</html>",
            signers: [{ email: "a@example.com" }],
            writeBack: { collection: "agreements", id: "{{ data.id }}", field: "signed_doc" },
          },
        ],
        { id: row.id },
      );
      expect(out.ok).toBe(true);
      const stored = client
        .query("select write_back as w from signature_requests")
        .get() as { w: string };
      expect(JSON.parse(stored.w)).toMatchObject({ collection: "agreements", id: row.id, field: "signed_doc" });
    });
  });
});
