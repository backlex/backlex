/**
 * Multi-surface parity for document generation.
 *
 * The point of this gate is not that five surfaces exist — it is that they
 * share ONE implementation. Every one funnels through `services/documents.ts`,
 * so the rule that decides the whole feature's behaviour (a workspace row
 * overrides an instance-wide default and never modifies it) and the refusal
 * when no renderer is configured hold identically everywhere. A guard restated
 * per surface is how one of them ends up missing.
 *
 * The renderer itself is somebody else's browser, so it is stubbed; what is
 * asserted is that each surface reaches the same service with the same scoping.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createClient } from "../../../packages/client/src/index";
import { documentsTools } from "../src/server/mcp/tools/documents";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

let h: TestHarness;
let client: Database;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

const gql = async (query: string, variables?: Record<string, unknown>) => {
  const res = await h.fetch("/api/graphql", json("POST", { query, variables }));
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: any }[] };
};

/** Installs a stub renderer on the shared Ctx the harness serves from. */
const stubRenderer = async (impl?: () => Promise<Uint8Array>) => {
  const { buildContext } = await import("../src/server/context");
  const ctx = (await buildContext(h.env)) as any;
  ctx.pdf = { name: "stub", render: impl ?? (async () => FAKE_PDF) };
};

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  await stubRenderer();
});
afterEach(() => h.cleanup());

/** Seed an instance-wide default nobody owns, to test the override rule. */
const seedShared = (key: string, body: string) => {
  const now = Date.now();
  client
    .query(
      `insert into document_templates (id, tenant_id, key, name, body_html, created_at, updated_at)
       values (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), key, key, body, now, now);
};

describe("REST", () => {
  test("saves, lists and renders", async () => {
    const put = await h.fetch(
      "/api/admin/documents/templates/inv",
      json("PUT", { name: "Invoice", bodyHtml: "<html>{{ data.no }}</html>", filename: "inv-{{ data.no }}" }),
    );
    expect(put.status).toBe(200);

    const list = (await (await h.fetch("/api/admin/documents/templates")).json()) as any;
    expect(list.data.map((t: any) => t.key)).toContain("inv");

    const render = await h.fetch(
      "/api/admin/documents/render",
      json("POST", { templateKey: "inv", vars: { data: { no: "114" } } }),
    );
    expect(render.status).toBe(200);
    expect(render.headers.get("content-type")).toBe("application/pdf");
    expect(render.headers.get("content-disposition")).toContain("inv-114.pdf");
    expect(new Uint8Array(await render.arrayBuffer())).toEqual(FAKE_PDF);
  });

  test("refuses both a template and inline html", async () => {
    const res = await h.fetch(
      "/api/admin/documents/render",
      json("POST", { templateKey: "inv", html: "<html>x</html>" }),
    );
    expect(res.status).toBe(422);
  });
});

describe("SDK", () => {
  const sdk = () =>
    createClient({ url: "http://local.test", fetch: (input: any, init: any) => h.fetch(String(input), init) });

  test("save / list / render / delete", async () => {
    const c = sdk();
    await c.documents.save("quote", { bodyHtml: "<html>{{ data.total }}</html>" });
    const list = await c.documents.list();
    expect(list.data.map((t) => t.key)).toContain("quote");

    const bytes = await c.documents.render({ templateKey: "quote", vars: { data: { total: "99" } } });
    // Bytes, not JSON — the endpoint answers application/pdf.
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(FAKE_PDF);

    await c.documents.delete("quote");
    expect((await c.documents.list()).data.map((t) => t.key)).not.toContain("quote");
  });

  test("surfaces the no-renderer refusal rather than returning empty bytes", async () => {
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = undefined;
    const c = sdk();
    await c.documents.save("x", { bodyHtml: "<html>x</html>" });
    await expect(c.documents.render({ templateKey: "x" })).rejects.toThrow();
  });
});

describe("GraphQL", () => {
  test("query, save and render through the same service", async () => {
    const saved = await gql(
      `mutation ($key: String!, $data: DocumentTemplateInput!) {
         saveDocumentTemplate(key: $key, data: $data) { key name inherited }
       }`,
      { key: "agreement", data: { name: "Agreement", bodyHtml: "<html>{{ data.party }}</html>" } },
    );
    expect(saved.errors).toBeUndefined();
    expect(saved.data.saveDocumentTemplate).toMatchObject({ key: "agreement", inherited: false });

    const listed = await gql(`{ documentTemplates { key inherited } }`);
    expect(listed.data.documentTemplates.map((t: any) => t.key)).toContain("agreement");

    const rendered = await gql(
      `mutation ($k: String!, $v: JSON) {
         renderDocument(templateKey: $k, vars: $v) { filename contentType renderer base64 }
       }`,
      { k: "agreement", v: { data: { party: "Acme" } } },
    );
    expect(rendered.errors).toBeUndefined();
    expect(rendered.data.renderDocument.contentType).toBe("application/pdf");
    expect(rendered.data.renderDocument.renderer).toBe("stub");
    // Base64, because GraphQL has no byte type — decoding it must give the
    // same document every other surface returned.
    const decoded = Uint8Array.from(atob(rendered.data.renderDocument.base64), (ch) => ch.charCodeAt(0));
    expect(decoded).toEqual(FAKE_PDF);
  });

  test("restates the exactly-one rule that args cannot express", async () => {
    const res = await gql(
      `mutation { renderDocument(templateKey: "a", html: "<html>x</html>") { filename } }`,
    );
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("deleting reaches the same guard as REST", async () => {
    seedShared("shared-only", "<html>s</html>");
    const res = await gql(`mutation { deleteDocumentTemplate(key: "shared-only") }`);
    // An inherited default is not deletable from inside a workspace.
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("MCP", () => {
  const tool = (name: string) => {
    const t = documentsTools.find((x) => x.name === name);
    if (!t) throw new Error(`missing MCP tool ${name}`);
    return t;
  };
  const ctx = () => ({ fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) }) as any;

  test("exposes the four tools", () => {
    expect(documentsTools.map((t) => t.name).sort()).toEqual([
      "documents.render",
      "documents.save",
      "documents.templates_delete",
      "documents.templates_list",
    ]);
  });

  test("save then list then render", async () => {
    await tool("documents.save").handler(
      { key: "contract", bodyHtml: "<html>{{ data.name }}</html>" },
      ctx(),
    );
    const listed = await tool("documents.templates_list").handler({}, ctx());
    expect(JSON.stringify(listed.structuredContent)).toContain("contract");

    const out = await tool("documents.render").handler(
      { templateKey: "contract", vars: { data: { name: "Acme" } } },
      ctx(),
    );
    const body = out.structuredContent as any;
    // Metadata, not the bytes — base64 in a tool result fills the context
    // window for no benefit.
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(FAKE_PDF.byteLength);
    expect(body.renderer).toBe("stub");
    expect(JSON.stringify(body)).not.toContain("base64");
  });

  test("a render failure reads the JSON error rather than reporting a bare status", async () => {
    const { buildContext } = await import("../src/server/context");
    ((await buildContext(h.env)) as any).pdf = undefined;
    await expect(
      tool("documents.render").handler({ html: "<html>x</html>" }, ctx()),
    ).rejects.toThrow(/PDF_CF_ACCOUNT_ID|PDF_GOTENBERG_URL/);
  });
});

describe("the override rule holds on every surface", () => {
  test("REST, SDK, GraphQL and MCP all create an override rather than editing the shared row", async () => {
    const surfaces: [string, (key: string, body: string) => Promise<unknown>][] = [
      [
        "rest",
        (key, body) => h.fetch(`/api/admin/documents/templates/${key}`, json("PUT", { bodyHtml: body })),
      ],
      [
        "sdk",
        (key, body) =>
          createClient({
            url: "http://local.test",
            fetch: (i: any, init: any) => h.fetch(String(i), init),
          }).documents.save(key, { bodyHtml: body }),
      ],
      [
        "graphql",
        (key, body) =>
          gql(
            `mutation ($k: String!, $d: DocumentTemplateInput!) { saveDocumentTemplate(key: $k, data: $d) { key } }`,
            { k: key, d: { bodyHtml: body } },
          ),
      ],
      [
        "mcp",
        (key, body) => {
          const t = documentsTools.find((x) => x.name === "documents.save")!;
          return t.handler({ key, bodyHtml: body }, { fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) } as any);
        },
      ],
    ];

    for (const [name, save] of surfaces) {
      const key = `shared-${name}`;
      seedShared(key, "<html>shared</html>");
      await save(key, `<html>${name}</html>`);

      // The shared row is untouched, so other workspaces still see it.
      const shared = client
        .query("select body_html as b from document_templates where tenant_id is null and key = ?")
        .get(key) as { b: string };
      expect(shared.b).toBe("<html>shared</html>");

      // And exactly one row surfaces for the key, the workspace's own.
      const list = (await (await h.fetch("/api/admin/documents/templates")).json()) as any;
      const rows = list.data.filter((t: any) => t.key === key);
      expect(rows).toHaveLength(1);
      expect(rows[0].inherited).toBe(false);
      expect(rows[0].bodyHtml).toBe(`<html>${name}</html>`);
    }
  });
});
