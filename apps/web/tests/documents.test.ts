/**
 * Document generation — a row plus a stored HTML template becomes a PDF.
 *
 * The renderer itself is somebody else's browser, so what is worth pinning here
 * is everything around it: that a workspace's template overrides the shared
 * default without changing it, that an unconfigured deployment refuses instead
 * of producing a broken document, and that the two values which reach a
 * filesystem path or a mail header from ROW DATA — the filename and the storage
 * key — cannot be steered by whoever filled in the row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { renderDocument, safeFilename } from "../src/server/services/documents";
import { buildContext } from "../src/server/context";
import { selectPdfAdapter } from "../src/server/context";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/documents";

let h: TestHarness;
let client: Database;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await h.fetch(path, json(method, body));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

/** A minimal valid PDF — the byte prefix is what the adapters check for. */
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterEach(() => h.cleanup());

describe("templates", () => {
  test("a workspace template is created and read back", async () => {
    const put = await ok("PUT", `${BASE}/templates/invoice`, {
      name: "Invoice",
      bodyHtml: "<html><body><h1>Invoice {{ data.no }}</h1></body></html>",
      pageOptions: { format: "A4", landscape: false },
      filename: "invoice-{{ data.no }}.pdf",
    });
    expect(put.data.key).toBe("invoice");
    expect(put.data.inherited).toBe(false);

    const list = await ok("GET", `${BASE}/templates`);
    expect(list.data.map((t: any) => t.key)).toContain("invoice");
  });

  test("a new template without a body is refused", async () => {
    const res = await h.fetch(`${BASE}/templates/empty`, json("PUT", { name: "Empty" }));
    expect(res.status).toBe(422);
  });

  test("an instance-wide default is hidden by the workspace's own row", async () => {
    // Seeded directly: there is no API for writing the shared row from inside a
    // workspace, which is the point of the rule.
    const now = Date.now();
    client
      .query(
        `insert into document_templates (id, tenant_id, key, name, body_html, created_at, updated_at)
         values (?, NULL, 'quote', 'Shared quote', '<html>shared</html>', ?, ?)`,
      )
      .run(crypto.randomUUID(), now, now);

    const before = await ok("GET", `${BASE}/templates`);
    expect(before.data.find((t: any) => t.key === "quote").inherited).toBe(true);

    await ok("PUT", `${BASE}/templates/quote`, { bodyHtml: "<html>mine</html>" });

    const after = await ok("GET", `${BASE}/templates`);
    const quote = after.data.filter((t: any) => t.key === "quote");
    // One row, not two — the operator should not have to work out which renders.
    expect(quote).toHaveLength(1);
    expect(quote[0].inherited).toBe(false);
    expect(quote[0].bodyHtml).toBe("<html>mine</html>");

    // And the shared row is untouched, so other workspaces still see it.
    const shared = client
      .query("select body_html as b from document_templates where tenant_id is null and key = 'quote'")
      .get() as { b: string };
    expect(shared.b).toBe("<html>shared</html>");
  });

  test("deleting an inherited default from a workspace is a 404, not a silent no-op", async () => {
    const now = Date.now();
    client
      .query(
        `insert into document_templates (id, tenant_id, key, name, body_html, created_at, updated_at)
         values (?, NULL, 'terms', 'Terms', '<html>t</html>', ?, ?)`,
      )
      .run(crypto.randomUUID(), now, now);
    const res = await h.fetch(`${BASE}/templates/terms`, json("DELETE"));
    expect(res.status).toBe(404);
  });
});

describe("rendering", () => {
  /** A Ctx with a stub renderer standing in for the browser. */
  const withRenderer = async (
    impl: (html: string, opts: any) => Promise<Uint8Array>,
  ): Promise<any> => {
    const ctx = await buildContext(h.env);
    return { ...ctx, pdf: { name: "stub", render: impl } };
  };

  const tenantId = () =>
    (client.query("select id from tenants limit 1").get() as { id: string }).id;

  test("interpolates the template against the row", async () => {
    let seen = "";
    const ctx = await withRenderer(async (html) => {
      seen = html;
      return FAKE_PDF;
    });
    await ok("PUT", `${BASE}/templates/inv`, {
      bodyHtml: "<html><body>Total {{ data.total }} for {{ data.customer }}</body></html>",
    });
    const out = await renderDocument(ctx, tenantId(), {
      templateKey: "inv",
      vars: { data: { total: "1.250,00 ₺", customer: "Ayşe Yılmaz" } },
    });
    expect(seen).toContain("Total 1.250,00 ₺ for Ayşe Yılmaz");
    expect(out.contentType).toBe("application/pdf");
    expect(out.renderer).toBe("stub");
  });

  test("the filename is templated from the row", async () => {
    const ctx = await withRenderer(async () => FAKE_PDF);
    await ok("PUT", `${BASE}/templates/inv2`, {
      bodyHtml: "<html>x</html>",
      filename: "invoice-{{ data.no }}",
    });
    const out = await renderDocument(ctx, tenantId(), { templateKey: "inv2", vars: { data: { no: "2026-114" } } });
    expect(out.filename).toBe("invoice-2026-114.pdf");
  });

  test("page options travel to the renderer, with the template's own as the base", async () => {
    let opts: any;
    const ctx = await withRenderer(async (_h, o) => {
      opts = o;
      return FAKE_PDF;
    });
    await ok("PUT", `${BASE}/templates/label`, {
      bodyHtml: "<html>x</html>",
      pageOptions: { format: "A5", landscape: true },
      headerHtml: "<span>{{ data.customer }}</span>",
    });
    await renderDocument(ctx, tenantId(), {
      templateKey: "label",
      vars: { data: { customer: "Acme" } },
      // A per-call override wins field by field rather than replacing the set.
      pageOptions: { landscape: false },
    });
    expect(opts.format).toBe("A5");
    expect(opts.landscape).toBe(false);
    // The running header is interpolated too — it is a template like the body.
    expect(opts.headerHtml).toBe("<span>Acme</span>");
  });

  test("an unknown template key is a 404, not an empty render", async () => {
    const ctx = await withRenderer(async () => FAKE_PDF);
    await expect(renderDocument(ctx, tenantId(), { templateKey: "nope" })).rejects.toThrow(/not found/i);
  });

  test("with no renderer configured it refuses and names the env vars", async () => {
    // There is deliberately no fallback: every pure-JS renderer available here
    // would drop `ş`/`ğ`/`ı` from a Turkish contract without failing.
    const ctx = await buildContext(h.env);
    expect((ctx as any).pdf).toBeUndefined();
    await expect(
      renderDocument(ctx, tenantId(), { html: "<html>x</html>" }),
    ).rejects.toThrow(/PDF_CF_ACCOUNT_ID|PDF_GOTENBERG_URL/);
  });

  test("a runaway render is refused rather than stored", async () => {
    const ctx = await withRenderer(async () => new Uint8Array(21 * 1024 * 1024));
    await expect(renderDocument(ctx, tenantId(), { html: "<html>x</html>" })).rejects.toThrow(/ceiling/);
  });
});

describe("safeFilename", () => {
  test("appends the extension", () => {
    expect(safeFilename("invoice-2026")).toBe("invoice-2026.pdf");
    expect(safeFilename("invoice.pdf")).toBe("invoice.pdf");
  });

  test("a path separator cannot escape into the object path", () => {
    // The name is templated from row data, so it is whoever filled in the row
    // that chooses it — not the template author.
    expect(safeFilename("../../etc/thing")).toBe("etc-thing.pdf");
    expect(safeFilename("a/b/c")).toBe("a-b-c.pdf");
  });

  test("a quote or newline cannot reach a header", () => {
    expect(safeFilename('in"voice\r\nX: 1')).toBe("invoiceX: 1.pdf");
  });

  test("an empty name still produces something", () => {
    expect(safeFilename("   ")).toBe("document.pdf");
  });
});

describe("selectPdfAdapter", () => {
  test("no credentials means no renderer", () => {
    expect(selectPdfAdapter({} as any)).toBeUndefined();
  });

  test("Cloudflare wins when both are configured", () => {
    const a = selectPdfAdapter({
      PDF_CF_ACCOUNT_ID: "acct",
      PDF_CF_API_TOKEN: "tok",
      PDF_GOTENBERG_URL: "http://gotenberg:3000",
    } as any);
    expect(a?.name).toBe("cf-browser");
  });

  test("an explicit provider is honoured", () => {
    expect(
      selectPdfAdapter({
        PDF_PROVIDER: "gotenberg",
        PDF_CF_ACCOUNT_ID: "acct",
        PDF_CF_API_TOKEN: "tok",
        PDF_GOTENBERG_URL: "http://gotenberg:3000",
      } as any)?.name,
    ).toBe("gotenberg");
  });

  test("a managed cloud tenant gets the gateway, without configuring anything", () => {
    // A provisioned tenant has no environment to put credentials in — its
    // Worker bindings are written by the provisioner — so "set
    // PDF_CF_ACCOUNT_ID…" was advice it could not act on. Both document
    // generation AND e-signature answered 422 with it, because freezing a
    // document for signing is a render.
    expect(selectPdfAdapter({ CLOUD_REPORT_SECRET: "s", CLOUD_PROJECT_ID: "p1", CLOUD_REPORT_URL: "https://c" } as any)?.name).toBe(
      "cloud-gateway",
    );
  });

  test("a tenant that brings its own renderer keeps it", () => {
    // The gateway is a floor, not an override: an operator who configured
    // Gotenberg gets Gotenberg even on managed cloud.
    expect(
      selectPdfAdapter({
        CLOUD_REPORT_SECRET: "s",
        CLOUD_PROJECT_ID: "p1",
        CLOUD_REPORT_URL: "https://c",
        PDF_GOTENBERG_URL: "http://gotenberg:3000",
      } as any)?.name,
    ).toBe("gotenberg");
    expect(
      selectPdfAdapter({
        CLOUD_REPORT_SECRET: "s",
        CLOUD_PROJECT_ID: "p1",
        CLOUD_REPORT_URL: "https://c",
        PDF_CF_ACCOUNT_ID: "acct",
        PDF_CF_API_TOKEN: "tok",
      } as any)?.name,
    ).toBe("cf-browser");
  });

  test("PDF_PROVIDER=cloud off-cloud yields none, like every other pin", () => {
    expect(selectPdfAdapter({ PDF_PROVIDER: "cloud" } as any)).toBeUndefined();
    expect(
      selectPdfAdapter({
        PDF_PROVIDER: "cloud",
        CLOUD_REPORT_SECRET: "s",
        CLOUD_PROJECT_ID: "p1",
        CLOUD_REPORT_URL: "https://c",
      } as any)?.name,
    ).toBe("cloud-gateway");
  });

  test("self-host with nothing configured still gets nothing", () => {
    // The fallback must not fire off-cloud: there is no gateway to reach, and a
    // renderer that always fails is worse than a refusal that says why.
    expect(selectPdfAdapter({} as any)).toBeUndefined();
    expect(selectPdfAdapter({ CLOUD_REPORT_SECRET: "" } as any)).toBeUndefined();
  });

  test("a pinned provider with no credentials yields none, rather than the other one", () => {
    // An operator who named a provider wants that provider; substituting
    // silently is how a contract renders somewhere they did not intend.
    expect(
      selectPdfAdapter({ PDF_PROVIDER: "gotenberg", PDF_CF_ACCOUNT_ID: "a", PDF_CF_API_TOKEN: "t" } as any),
    ).toBeUndefined();
  });
});
