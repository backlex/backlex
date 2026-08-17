/**
 * Document ingest — a stored file becomes rows, one per section.
 *
 * The shape is the thing under test. One row per DOCUMENT was the obvious
 * design and it runs straight into the chunk cap: a row is bounded at about
 * 64 KB of indexed text, so a real handbook would stop being indexed part-way
 * through, silently. Sections keep every row short — and they are the
 * granularity retrieval wants anyway, since a search should answer with the
 * section rather than with a document to go read.
 *
 * Only text-native formats, and that is a decision rather than a gap: `.txt`,
 * `.md`, `.html`, `.csv` and `.json` decode with no dependency and behave the
 * same on all eight runtimes, while PDF and Office need a per-runtime
 * capability. A caller who sends one gets told so by name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "@backlex/core";
import { SECTION_CHARS, extractText, splitSections } from "../src/server/services/ingest";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("extractText", () => {
  test("plain text and markdown come through untouched", () => {
    expect(extractText(enc("# Title\n\nBody"), "text/markdown", "a.md")).toBe("# Title\n\nBody");
    expect(extractText(enc("hello"), "text/plain", "a.txt")).toBe("hello");
  });

  test("html is reduced to its text", () => {
    const html = "<h1>Refunds</h1><script>evil()</script><p>Within 30 days.</p>";
    const out = extractText(enc(html), "text/html", "a.html");
    expect(out).toContain("Refunds");
    expect(out).toContain("Within 30 days.");
    // `htmlToText` drops script/style bodies, so the page's code does not
    // become searchable text — or prompt content.
    expect(out).not.toContain("evil()");
  });

  test("the extension decides when the stored type is uninformative", () => {
    // A browser upload with no sniffing lands as octet-stream. Trusting the
    // declared type alone would refuse nearly every real object.
    expect(extractText(enc("hi"), "application/octet-stream", "notes/a.md")).toBe("hi");
  });

  test("a parameterised content type still matches", () => {
    expect(extractText(enc("hi"), "text/plain; charset=utf-8", "a")).toBe("hi");
  });

  test("a PDF is refused by name, not by a generic error", () => {
    // The caller has to know WHY, because the answer ("convert it first") is
    // not guessable from "unsupported".
    let err: AppError | null = null;
    try {
      extractText(enc("%PDF-1.7"), "application/pdf", "handbook.pdf");
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe("VALIDATION");
    expect(err?.message).toContain(".pdf files");
    expect(err?.message).toContain(".md");
  });

  test("an unknown type is refused too, naming what it saw", () => {
    expect(() => extractText(enc("x"), "application/x-thing", "a.thing")).toThrow(/thing/);
  });

  test("one bad byte does not fail the whole document", () => {
    // A caller ingesting a folder needs the other 99 files to land.
    const bytes = new Uint8Array([0x68, 0x69, 0xff, 0x21]);
    expect(extractText(bytes, "text/plain", "a.txt")).toContain("hi");
  });
});

describe("splitSections", () => {
  test("markdown headings are the boundary when the author gave us one", () => {
    const out = splitSections("Intro line\n\n# Refunds\nWithin 30 days.\n\n## Partial\nPro rata.");
    expect(out.map((s) => s.title)).toEqual([null, "Refunds", "Partial"]);
    expect(out[1]!.body).toBe("Within 30 days.");
    expect(out.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  test("a heading with no content before it does not produce an empty section", () => {
    const out = splitSections("# One\nA\n\n# Two\nB");
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe("One");
  });

  test("without headings it accumulates paragraphs up to the budget", () => {
    const para = `${"p".repeat(1500)}`;
    const out = splitSections([para, para, para, para].join("\n\n"));
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.body.length).toBeLessThanOrEqual(SECTION_CHARS + 1500);
    expect(out.every((s) => s.title === null)).toBe(true);
  });

  test("a single paragraph over the budget is kept whole rather than cut mid-sentence", () => {
    // The chunker splits it for the INDEX; the row is what a human opens, and
    // one that ends mid-clause reads badly.
    const out = splitSections("z".repeat(SECTION_CHARS * 2));
    expect(out).toHaveLength(1);
    expect(out[0]!.body.length).toBe(SECTION_CHARS * 2);
  });

  test("blank input is no sections", () => {
    expect(splitSections("  \n\n ")).toEqual([]);
  });
});

describe("POST /{slug}/ingest", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "docs",
        fields: [
          { name: "title", type: "text" },
          { name: "body", type: "longtext" },
          { name: "source", type: "text" },
          { name: "section", type: "number" },
        ],
      }),
    );
    expect(res.status).toBeLessThan(300);
  });
  afterEach(() => h.cleanup());

  const upload = (key: string, body: string, type = "text/markdown") =>
    h.fetch(`/api/storage/${key}`, { method: "PUT", headers: { "content-type": type }, body });

  const ingest = (body: unknown) => h.fetch("/api/items/docs/ingest", json(body));

  const rows = async () =>
    ((await (await h.fetch("/api/items/docs?sort=section")).json()) as {
      data: Record<string, unknown>[];
    }).data;

  test("a document becomes one row per section", async () => {
    expect((await upload("handbook.md", "# Refunds\nWithin 30 days.\n\n# Billing\nMonthly.")).status)
      .toBeLessThan(300);

    const res = await ingest({
      key: "handbook.md",
      bodyField: "body",
      titleField: "title",
      sourceField: "source",
      sectionField: "section",
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { sections: number; inserted: number; failed: number };
    };
    expect(data).toMatchObject({ sections: 2, inserted: 2, failed: 0 });

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.title)).toEqual(["Refunds", "Billing"]);
    expect(all.map((r) => r.section)).toEqual([0, 1]);
    expect(all.every((r) => r.source === "handbook.md")).toBe(true);
  });

  test("`data` constants land on every row", async () => {
    await upload("a.md", "# One\nx\n\n# Two\ny");
    await ingest({ key: "a.md", bodyField: "body", titleField: "title", data: { source: "manual" } });
    expect((await rows()).every((r) => r.source === "manual")).toBe(true);
  });

  test("a PDF is refused before anything is written", async () => {
    await upload("h.pdf", "%PDF-1.7", "application/pdf");
    const res = await ingest({ key: "h.pdf", bodyField: "body" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("pdf");
    expect(await rows()).toHaveLength(0);
  });

  test("a missing key is a 404, not an empty success", async () => {
    const res = await ingest({ key: "nope.md", bodyField: "body" });
    expect(res.status).toBe(404);
  });

  test("re-ingesting without `replace` duplicates — with it, it does not", async () => {
    await upload("a.md", "# One\nx\n\n# Two\ny");
    const body = { key: "a.md", bodyField: "body", titleField: "title", sourceField: "source" };

    await ingest(body);
    await ingest(body);
    expect(await rows()).toHaveLength(4);

    const res = await ingest({ ...body, replace: true });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { replaced: number; inserted: number } };
    expect(data.replaced).toBe(4);
    expect(data.inserted).toBe(2);
    expect(await rows()).toHaveLength(2);
  });

  test("`replace` without `sourceField` is refused rather than guessed at", async () => {
    await upload("a.md", "# One\nx");
    const res = await ingest({ key: "a.md", bodyField: "body", replace: true });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("sourceField");
  });

  test("a key cannot reach outside the caller's own storage prefix", async () => {
    // The physical key is built under the caller's tenant prefix, so the only
    // way out would be spelling one — which `guardLogicalKey` refuses.
    for (const key of ["../secrets.md", "tenants/other/x.md", "/etc/hosts"]) {
      const res = await ingest({ key, bodyField: "body" });
      expect(`${key}: ${res.status}`).toBe(`${key}: 422`);
    }
  });

  test("a field name that is not a field is refused, not passed to SQL", async () => {
    // `sourceField` reaches a `sql.identifier` in the replace path. Quoting
    // rules out injection, but an unknown column would still be a 500 that
    // reads as a server fault and doubles as a column-existence oracle — and
    // a name that IS a column but not the intended one would widen what
    // `replace` deletes.
    await upload("a.md", "# One\nx");
    for (const body of [
      { key: "a.md", bodyField: "nope" },
      { key: "a.md", bodyField: "body", sourceField: "id; drop" },
      { key: "a.md", bodyField: "body", sourceField: "created_at", replace: true },
    ]) {
      const res = await ingest(body);
      expect(`${JSON.stringify(body)}: ${res.status}`).toBe(`${JSON.stringify(body)}: 422`);
    }
    expect(await rows()).toHaveLength(0);
  });

  test("a document that decodes to nothing is refused rather than inserting blanks", async () => {
    await upload("empty.md", "   \n\n  ");
    const res = await ingest({ key: "empty.md", bodyField: "body" });
    expect(res.status).toBe(422);
    expect(await rows()).toHaveLength(0);
  });
});
