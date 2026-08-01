/**
 * The `document.render` flow op, and the `attach` that carries its output.
 *
 * The pair is the point: "an invoice row landed" → render it → email the PDF.
 * Two things are pinned harder than the happy path, both because they are
 * places where ROW DATA reaches something structural:
 *
 * - the storage key is random, not derived from the filename, so two invoices
 *   called `invoice.pdf` cannot overwrite each other and a row cannot choose
 *   where its object lands;
 * - `attach` takes storage KEYS and only ones under the generated-documents
 *   prefix, so a flow cannot be talked into mailing out an arbitrary uploaded
 *   object — or into fetching a URL and posting the bytes onward.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("document.render flow op", () => {
  let h: TestHarness;
  let sent: string[];
  let restore: typeof console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    sent = [];
    restore = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[email]")) sent.push(line);
    };
    // The dev context has no renderer, which is the correct default — the ops
    // under test need one, so it is patched onto the shared Ctx here.
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = { name: "stub", render: async () => FAKE_PDF };
  });
  afterEach(() => {
    console.log = restore;
    h.cleanup();
  });

  const run = async (ops: Record<string, unknown>[], data: Record<string, unknown> = {}) => {
    const created = await h.fetch(
      "/api/flows",
      json({ name: `doc-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: ops }),
    );
    expect(created.status).toBe(201);
    const { data: flow } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${flow.id}/run`, json(data));
    return (await res.json()) as { ok: boolean; error?: string };
  };

  describe("saving", () => {
    const save = (op: Record<string, unknown>) =>
      h.fetch(
        "/api/flows",
        json({ name: `s-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: [op] }),
      );

    test("refuses an op with neither a template nor html", async () => {
      // A render with no source renders nothing, which is a flow that looks
      // like it works.
      expect((await save({ type: "document.render" })).status).toBe(422);
    });

    test("refuses an op with both", async () => {
      // Otherwise the stored template silently loses to the inline body.
      const res = await save({ type: "document.render", templateKey: "inv", html: "<html>x</html>" });
      expect(res.status).toBe(422);
    });

    test("accepts either one on its own", async () => {
      expect((await save({ type: "document.render", templateKey: "inv" })).status).toBe(201);
      expect((await save({ type: "document.render", html: "<html>x</html>" })).status).toBe(201);
    });

    test("caps how many files one email may attach", async () => {
      const res = await save({
        type: "email",
        to: "a@b.co",
        subject: "s",
        text: "t",
        attach: Array(6).fill("documents/x/y/z.pdf"),
      });
      expect(res.status).toBe(422);
    });
  });

  test("renders inline html and returns the stored object on $last", async () => {
    const out = await run([
      { type: "document.render", html: "<html><body>{{ data.no }}</body></html>", filename: "inv-{{ data.no }}" },
      { type: "log", message: "stored {{ $last.key }} as {{ $last.filename }}" },
    ], { no: "114" });
    expect(out).toEqual({ ok: true });
  });

  test("the storage key is random, not derived from the filename", async () => {
    // Two rows that produce the same filename must not collide, and a filename
    // comes from row data — deriving the path from it lets a row pick where the
    // object lands.
    const keys: string[] = [];
    const capture = (line: string) => {
      const m = /stored (\S+)/.exec(line);
      if (m) keys.push(m[1]!);
    };
    const prev = console.log;
    console.log = (...a: unknown[]) => capture(a.map(String).join(" "));
    await run([
      { type: "document.render", html: "<html>a</html>", filename: "invoice" },
      { type: "log", message: "stored {{ $last.key }}" },
    ]);
    await run([
      { type: "document.render", html: "<html>b</html>", filename: "invoice" },
      { type: "log", message: "stored {{ $last.key }}" },
    ]);
    console.log = prev;

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    for (const k of keys) {
      expect(k.startsWith("documents/")).toBe(true);
      expect(k.endsWith("/invoice.pdf")).toBe(true);
    }
  });

  test("an email attaches what the previous op rendered", async () => {
    const out = await run(
      [
        { type: "document.render", html: "<html>{{ data.no }}</html>", filename: "invoice-{{ data.no }}" },
        {
          type: "email",
          to: "{{ data.email }}",
          subject: "Invoice {{ data.no }}",
          text: "Attached.",
          attach: ["{{ $last.key }}"],
        },
      ],
      { no: "114", email: "customer@example.com" },
    );
    expect(out).toEqual({ ok: true });
    expect(sent[0]).toContain("attachments=[invoice-114.pdf]");
  });

  test("an attachment key outside the generated-documents prefix is refused", async () => {
    // Otherwise a flow could mail out any uploaded object by guessing its path.
    const out = await run([
      { type: "email", to: "a@b.co", subject: "s", text: "t", attach: ["uploads/private/passport.pdf"] },
    ]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not a generated document/);
  });

  test("a URL as an attachment is refused, not fetched", async () => {
    // A URL would make the mail path fetch whatever it was pointed at and post
    // the bytes to an address the same flow chose.
    const out = await run([
      {
        type: "email",
        to: "a@b.co",
        subject: "s",
        text: "t",
        attach: ["https://attacker.example/secrets.pdf"],
      },
    ]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not a generated document/);
  });

  test("another workspace's document is refused, even with the right prefix", async () => {
    // Storage is ONE namespace across every tenant, so the prefix alone is not
    // enough — and a key can travel in through the row a flow reads.
    const out = await run([
      {
        type: "email",
        to: "a@b.co",
        subject: "s",
        text: "t",
        attach: ["documents/some-other-tenant/0000/contract.pdf"],
      },
    ]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not a generated document/);
  });

  test("a key in this workspace that is not in storage fails the run", async () => {
    // Renders one first so the test uses the workspace's real prefix, then
    // asks for a sibling that was never written.
    const keys: string[] = [];
    const prev = console.log;
    console.log = (...a: unknown[]) => {
      const m = /stored (\S+)/.exec(a.map(String).join(" "));
      if (m) keys.push(m[1]!);
    };
    await run([
      { type: "document.render", html: "<html>a</html>", filename: "real" },
      { type: "log", message: "stored {{ $last.key }}" },
    ]);
    console.log = prev;
    const prefix = keys[0]!.split("/").slice(0, 2).join("/");

    const out = await run([
      {
        type: "email",
        to: "a@b.co",
        subject: "s",
        text: "t",
        attach: [`${prefix}/never-written/x.pdf`],
      },
    ]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not in storage/);
  });

  test("an attachment template that renders empty fails loudly", async () => {
    const out = await run([
      { type: "email", to: "a@b.co", subject: "s", text: "t", attach: ["{{ data.key }}"] },
    ]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/rendered empty/);
  });

  test("a render failure fails the run rather than sending an empty email", async () => {
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = {
      name: "stub",
      render: async () => {
        throw new Error("renderer exploded");
      },
    };
    const out = await run([{ type: "document.render", html: "<html>x</html>" }]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/document\.render failed/);
  });
});
