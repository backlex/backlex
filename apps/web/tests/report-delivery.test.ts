/**
 * Report delivery — a dashboard printed to a PDF, and mailed.
 *
 * Two halves, and the seams between them are what this pins:
 *
 * - **The page builder is pure**, so its failure modes are testable without a
 *   renderer. The ones that matter are the quiet ones: a panel that errored
 *   must still appear (a revenue panel that vanishes reads as a month with no
 *   revenue), and a cell that happens to contain `{{ … }}` must survive — this
 *   codebase stores templates IN collections, so that is ordinary content.
 * - **The delivery path** puts the artefact under the SAME prefix a
 *   `document.render` op writes to, because `email.attach` refuses everything
 *   outside it. If those two ever drift, a report becomes un-attachable — or,
 *   worse, the guard gets widened.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildReportHtml } from "../../../packages/core/src/report";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");
const AT = new Date("2026-08-02T09:30:00Z");

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// ── The page builder ─────────────────────────────────────────────────────────

describe("buildReportHtml", () => {
  const base = { title: "Ops", generatedAt: AT, locale: "en-GB", timeZone: "UTC" };

  test("prints a failed panel's error instead of dropping it", () => {
    const html = buildReportHtml({
      ...base,
      panels: [{ name: "Revenue", viz: "bars", data: [], error: "no such table: orders" }],
    });
    expect(html).toContain("Revenue");
    expect(html).toContain("no such table: orders");
  });

  test("a cell containing a template placeholder survives verbatim", () => {
    // The renderer is told not to interpolate for exactly this reason; if that
    // ever regresses the cell silently empties rather than erroring.
    const html = buildReportHtml({
      ...base,
      panels: [{ name: "Templates", viz: "table", data: [{ body: "Hello {{ name }}" }] }],
    });
    expect(html).toContain("Hello {{ name }}");
  });

  test("escapes row data rather than letting it close a tag", () => {
    const html = buildReportHtml({
      ...base,
      panels: [{ name: "X", viz: "table", data: [{ note: "<script>alert(1)</script>" }] }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("truncates a long table and says how much it dropped", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ n: i }));
    const html = buildReportHtml({ ...base, panels: [{ name: "Rows", viz: "table", data: rows }] });
    expect(html).toContain("Showing 20 of 40 rows");
  });

  test("a seventh slice folds into Other rather than reusing the first colour", () => {
    // Cycling the palette would paint slice 7 the same blue as the biggest one,
    // which reads as the same category.
    const data = Array.from({ length: 9 }, (_, i) => ({ source: `s${i}`, hits: 100 - i }));
    const html = buildReportHtml({ ...base, panels: [{ name: "Sources", viz: "donut", data }] });
    expect(html).toContain("Other (3)");
    // Each slice paints exactly two things — its arc and its legend swatch — so
    // slot 1's blue appearing more than twice would mean a later slice reused it.
    expect(html.split("#2a78d6").length - 1).toBe(2);
    // …and the fold-over bucket is the reserved grey, not a seventh hue.
    expect(html).toContain("#8a8a85");
  });

  test("a chart panel with nothing numeric prints the rows instead of an empty frame", () => {
    const html = buildReportHtml({
      ...base,
      panels: [{ name: "Names", viz: "bars", data: [{ a: "x", b: "y" }] }],
    });
    expect(html).toContain("<table>");
  });

  test("is self-contained — no script and nothing to fetch", () => {
    const html = buildReportHtml({
      ...base,
      panels: [{ name: "Sessions", viz: "line", data: [{ d: "Mon", n: 4 }, { d: "Tue", n: 9 }] }],
    });
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  test("an unknown time zone degrades the stamp rather than failing the report", () => {
    const html = buildReportHtml({ ...base, timeZone: "Mars/Olympus", panels: [] });
    expect(html).toContain("2026-08-02");
  });
});

// ── Delivery ─────────────────────────────────────────────────────────────────

describe("dashboard reports", () => {
  let h: TestHarness;
  let ctx: any;
  let mails: string[];
  let restore: typeof console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    mails = [];
    restore = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[email]")) mails.push(line);
    };
    const { buildContext } = await import("../src/server/context");
    ctx = (await buildContext(h.env)) as any;
    ctx.pdf = { name: "stub", render: async () => FAKE_PDF };
  });
  afterEach(() => {
    console.log = restore;
    h.cleanup();
  });

  const makeDashboard = async (name = "ops") => {
    const res = await h.fetch("/api/admin/dashboards", json({ name }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  const makePanel = async (dashboardId: string, name = "p1") => {
    const res = await h.fetch(
      "/api/admin/panels",
      json({ name, kind: "static", viz: "counter", dashboardId }),
    );
    expect(res.status).toBe(201);
  };

  const report = (id: string, body: unknown = {}) =>
    h.fetch(`/api/admin/dashboards/${id}/report`, json(body));

  test("renders, stores under the generated-documents prefix, and reports the panel count", async () => {
    const id = await makeDashboard();
    await makePanel(id);
    const res = await report(id);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      key: string;
      filename: string;
      size: number;
      panels: number;
      failedPanels: number;
      sentTo: string[];
    };
    // The prefix is load-bearing: `email.attach` refuses anything outside it.
    expect(out.key.startsWith("documents/")).toBe(true);
    expect(out.key.endsWith(".pdf")).toBe(true);
    expect(out.filename.endsWith(".pdf")).toBe(true);
    expect(out.size).toBe(FAKE_PDF.byteLength);
    expect(out.panels).toBe(1);
    expect(out.failedPanels).toBe(0);
    expect(out.sentTo).toEqual([]);
  });

  test("the storage key is random, so two reports of one dashboard cannot collide", async () => {
    const id = await makeDashboard();
    const a = (await (await report(id)).json()) as { key: string };
    const b = (await (await report(id)).json()) as { key: string };
    expect(a.key).not.toBe(b.key);
  });

  test("404s an unknown dashboard", async () => {
    const res = await report("no-such-dashboard");
    expect(res.status).toBe(404);
  });

  test("mails one message per recipient and lists them back", async () => {
    const id = await makeDashboard();
    const res = await report(id, { email: { to: "a@example.com, b@example.com" } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sentTo: string[] };
    expect(out.sentTo).toEqual(["a@example.com", "b@example.com"]);
    expect(mails.length).toBe(2);
  });

  test("refuses a bad recipient before rendering anything", async () => {
    const id = await makeDashboard();
    const res = await report(id, { email: { to: "not-an-address" } });
    expect(res.status).toBe(422);
    expect(mails.length).toBe(0);
  });

  test("caps how many people one report goes to", async () => {
    const id = await makeDashboard();
    const to = Array.from({ length: 26 }, (_, i) => `p${i}@example.com`).join(",");
    expect((await report(id, { email: { to } })).status).toBe(422);
  });

  test("refuses a request that asks to both download and mail", async () => {
    const id = await makeDashboard();
    const res = await report(id, { download: true, email: { to: "a@example.com" } });
    expect(res.status).toBe(422);
  });

  test("the download shape answers PDF bytes", async () => {
    const id = await makeDashboard();
    const res = await report(id, { download: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_PDF);
  });

  test("refuses with 422 when the deployment has no renderer", async () => {
    // No fallback renderer exists on purpose — see docs/documents.md. The
    // refusal has to be legible, not a 500.
    ctx.pdf = null;
    const id = await makeDashboard();
    const res = await report(id);
    expect(res.status).toBe(422);
    expect((await res.text()).toLowerCase()).toContain("renderer");
  });

  test("GraphQL and REST return the same shape", async () => {
    const id = await makeDashboard();
    const res = await h.fetch(
      "/api/graphql",
      json({
        query: `mutation($id:ID!){ deliverDashboardReport(id:$id){ key filename panels sentTo } }`,
        variables: { id },
      }),
    );
    const body = (await res.json()) as { data?: any; errors?: unknown[] };
    expect(body.errors).toBeUndefined();
    expect(body.data.deliverDashboardReport.key.startsWith("documents/")).toBe(true);
    expect(body.data.deliverDashboardReport.sentTo).toEqual([]);
  });
});

// ── The flow op ──────────────────────────────────────────────────────────────

describe("report.deliver flow op", () => {
  let h: TestHarness;
  let logs: string[];
  let restore: typeof console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    logs = [];
    restore = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = { name: "stub", render: async () => FAKE_PDF };
  });
  afterEach(() => {
    console.log = restore;
    h.cleanup();
  });

  const runOps = async (ops: Record<string, unknown>[], data: Record<string, unknown> = {}) => {
    const created = await h.fetch(
      "/api/flows",
      json({ name: `rep-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: ops }),
    );
    expect(created.status).toBe(201);
    const { data: flow } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${flow.id}/run`, json(data));
    return (await res.json()) as { ok: boolean; error?: string };
  };

  const makeDashboard = async (name = "flow-dash") => {
    const res = await h.fetch("/api/admin/dashboards", json({ name }));
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  test("renders and puts a key on $last that a following email op can attach", async () => {
    // This composition is the whole reason `to` is optional: the op stores the
    // file, and the next step says whatever it wants around it.
    const id = await makeDashboard();
    const out = await runOps([
      { type: "report.deliver", dashboardId: id },
      { type: "email", to: "ops@example.com", subject: "s", text: "t", attach: ["{{ $last.key }}"] },
    ]);
    expect(out).toEqual({ ok: true });
  });

  test("mails it directly when `to` is set", async () => {
    const id = await makeDashboard();
    const out = await runOps([
      { type: "report.deliver", dashboardId: id, to: "{{ data.email }}", subject: "Monthly" },
      { type: "log", message: "sent to {{ $last.sentTo }}" },
    ], { email: "boss@example.com" });
    expect(out).toEqual({ ok: true, log: ["sent to boss@example.com"] });
    expect(logs.some((l) => l.includes("boss@example.com"))).toBe(true);
  });

  test("fails loudly when a templated recipient renders empty", async () => {
    // Downgrading to render-only would produce a scheduled report that quietly
    // stops arriving.
    const id = await makeDashboard();
    const out = await runOps([{ type: "report.deliver", dashboardId: id, to: "{{ data.missing }}" }]);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("rendered empty");
  });

  test("fails when the dashboard id does not resolve", async () => {
    const out = await runOps([{ type: "report.deliver", dashboardId: "nope" }]);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("report.deliver failed");
  });

  test("saving refuses an op with no dashboard", async () => {
    const res = await h.fetch(
      "/api/flows",
      json({ name: "bad", trigger: "manual:", operations: [{ type: "report.deliver" }] }),
    );
    expect(res.status).toBe(422);
  });
});
