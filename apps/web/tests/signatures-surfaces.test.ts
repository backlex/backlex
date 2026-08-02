/**
 * Multi-surface parity for e-signature.
 *
 * The point of this gate is not that the surfaces exist — it is that they share
 * ONE implementation. Every one funnels through `services/signatures.ts`, so
 * the rules that decide the whole feature's behaviour hold identically
 * everywhere: the document is frozen at send time, only the token's hash is
 * stored, and voiding kills a link rather than merely marking a status.
 *
 * The one place the surfaces deliberately DIFFER is who gets told the signing
 * link, and that difference is asserted rather than assumed — REST, the SDK and
 * GraphQL hand it back to the caller who just created the request; MCP does
 * not, because a tool result is transcript.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createClient } from "../../../packages/client/src/index";
import { signaturesTools } from "../src/server/mcp/tools/signatures";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

let h: TestHarness;
let client: Database;
let restoreLog: typeof console.log;

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

const sdk = () =>
  createClient({ url: "http://local.test", fetch: (input: any, init: any) => h.fetch(String(input), init) });

const mcp = (name: string) => {
  const t = signaturesTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing MCP tool ${name}`);
  return t;
};
const mcpCtx = () => ({ fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) }) as any;

const BODY = { html: "<html><body>Agreement for {{ data.who }}</body></html>", vars: { data: { who: "Ayşe" } } };
const SIGNERS = [{ email: "signer@example.com", name: "Ayşe", role: "Tenant" }];

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  restoreLog = console.log;
  console.log = (...args: unknown[]) => {
    if (!args.map(String).join(" ").startsWith("[email]")) restoreLog(...args);
  };
  const { buildContext } = await import("../src/server/context");
  ((await buildContext(h.env)) as any).pdf = { name: "stub", render: async () => FAKE_PDF };
});
afterEach(() => {
  console.log = restoreLog;
  h.cleanup();
});

describe("REST", () => {
  test("creates, reads back and downloads", async () => {
    const created = await h.fetch("/api/admin/signatures", json("POST", { ...BODY, signers: SIGNERS }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as any;
    expect(data.links[0].url).toContain("/sign/sig_");

    const got = (await (await h.fetch(`/api/admin/signatures/${data.request.id}`)).json()) as any;
    expect(got.data.bodyHtml).toContain("Agreement for Ayşe");

    const pdf = await h.fetch(`/api/admin/signatures/${data.request.id}/document?which=original`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(FAKE_PDF);
  });

  test("refuses both a template and inline html", async () => {
    const res = await h.fetch(
      "/api/admin/signatures",
      json("POST", { templateKey: "a", html: "<html>x</html>", signers: SIGNERS }),
    );
    expect(res.status).toBe(422);
  });
});

describe("SDK", () => {
  test("create / list / get / void", async () => {
    const c = sdk();
    const { data } = await c.signatures.create({ ...BODY, signers: SIGNERS });
    expect(data.links).toHaveLength(1);
    expect(data.sent).toBe(true);

    const list = await c.signatures.list();
    expect(list.total).toBe(1);
    expect(list.data[0]!.status).toBe("pending");

    const got = await c.signatures.get(data.request.id);
    expect(got.data.signers[0]!.email).toBe("signer@example.com");

    const voided = await c.signatures.void(data.request.id, "Superseded");
    expect(voided.data.status).toBe("voided");
  });

  test("the document comes back as bytes", async () => {
    const c = sdk();
    const { data } = await c.signatures.create({ ...BODY, signers: SIGNERS });
    const bytes = await c.signatures.document(data.request.id, "original");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(FAKE_PDF);
  });

  test("surfaces the no-renderer refusal rather than filing a request nobody can sign", async () => {
    const { buildContext } = await import("../src/server/context");
    ((await buildContext(h.env)) as any).pdf = undefined;
    await expect(sdk().signatures.create({ ...BODY, signers: SIGNERS })).rejects.toThrow();
    expect(client.query("select count(*) as n from signature_requests").get()).toMatchObject({ n: 0 });
  });
});

describe("GraphQL", () => {
  test("creates and reads through the same service", async () => {
    const created = await gql(
      `mutation ($html: String!, $vars: JSON, $signers: [SignatureSignerInput!]!) {
         createSignatureRequest(html: $html, vars: $vars, signers: $signers, title: "Lease") {
           request { id title status ordered signers { email role status } }
           links { email url }
           sent
         }
       }`,
      { html: BODY.html, vars: BODY.vars, signers: SIGNERS },
    );
    expect(created.errors).toBeUndefined();
    const out = created.data.createSignatureRequest;
    expect(out.request).toMatchObject({ title: "Lease", status: "pending" });
    expect(out.request.signers[0]).toMatchObject({ email: "signer@example.com", role: "Tenant" });
    expect(out.links[0].url).toContain("/sign/sig_");

    const one = await gql(`query ($id: ID!) { signatureRequest(id: $id) { bodyHtml documentHash } }`, {
      id: out.request.id,
    });
    expect(one.data.signatureRequest.bodyHtml).toContain("Agreement for Ayşe");

    const listed = await gql(`{ signatureRequests(status: "pending") { id } }`);
    expect(listed.data.signatureRequests).toHaveLength(1);
  });

  test("restates the exactly-one rule that args cannot express", async () => {
    const res = await gql(
      `mutation ($s: [SignatureSignerInput!]!) {
         createSignatureRequest(templateKey: "a", html: "<html>x</html>", signers: $s) { sent }
       }`,
      { s: SIGNERS },
    );
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("voiding reaches the same guard as REST", async () => {
    const c = sdk();
    const { data } = await c.signatures.create({ ...BODY, signers: SIGNERS });
    const token = data.links[0]!.url.split("/sign/")[1]!;
    await gql(`mutation ($id: ID!) { voidSignatureRequest(id: $id, reason: "x") { status } }`, {
      id: data.request.id,
    });
    // Not merely a status change: the delivered link stops resolving.
    expect((await h.fetch(`/api/public/sign/${token}`)).status).toBe(404);
  });
});

describe("MCP", () => {
  test("exposes the five tools, and no signing tool", () => {
    // Signing is the SIGNER's act, authenticated by a link token. An agent
    // holding an admin key signing on somebody's behalf is what the design
    // refuses.
    expect(signaturesTools.map((t) => t.name).sort()).toEqual([
      "signatures.get",
      "signatures.list",
      "signatures.resend",
      "signatures.send",
      "signatures.void",
    ]);
  });

  test("send then get then void", async () => {
    const sent = await mcp("signatures.send").handler({ ...BODY, signers: SIGNERS }, mcpCtx());
    const body = sent.structuredContent as any;
    expect(body.sent).toBe(true);
    expect(body.request.status).toBe("pending");

    const got = await mcp("signatures.get").handler({ id: body.request.id }, mcpCtx());
    expect(JSON.stringify(got.structuredContent)).toContain("Agreement for Ayşe");

    const voided = await mcp("signatures.void").handler({ id: body.request.id }, mcpCtx());
    expect((voided.structuredContent as any).data.status).toBe("voided");
  });

  test("never hands an agent a signing link", async () => {
    // A tool result is transcript: summarised, forwarded, stored. A signing
    // link is a bearer credential for somebody else's signature.
    const sent = await mcp("signatures.send").handler({ ...BODY, signers: SIGNERS }, mcpCtx());
    const dump = JSON.stringify(sent);
    expect(dump).not.toContain("sig_");
    expect(dump).not.toContain("/sign/");
    expect(dump).not.toContain("links");

    const listed = await mcp("signatures.list").handler({}, mcpCtx());
    expect(JSON.stringify(listed)).not.toContain("sig_");
  });
});

describe("the rules hold on every surface", () => {
  const surfaces: Array<[string, () => Promise<string>]> = [
    [
      "rest",
      async () => {
        const res = await h.fetch("/api/admin/signatures", json("POST", { ...BODY, signers: SIGNERS }));
        return ((await res.json()) as any).data.request.id;
      },
    ],
    ["sdk", async () => (await sdk().signatures.create({ ...BODY, signers: SIGNERS })).data.request.id],
    [
      "graphql",
      async () => {
        const res = await gql(
          `mutation ($html: String!, $vars: JSON, $s: [SignatureSignerInput!]!) {
             createSignatureRequest(html: $html, vars: $vars, signers: $s) { request { id } }
           }`,
          { html: BODY.html, vars: BODY.vars, s: SIGNERS },
        );
        return res.data.createSignatureRequest.request.id;
      },
    ],
    [
      "mcp",
      async () => {
        const out = await mcp("signatures.send").handler({ ...BODY, signers: SIGNERS }, mcpCtx());
        return (out.structuredContent as any).request.id;
      },
    ],
  ];

  test("each one freezes the document and stores only the token's hash", async () => {
    for (const [name, create] of surfaces) {
      const id = await create();
      const row = client
        .query("select body_html as b, document_hash as h, tenant_id as t from signature_requests where id = ?")
        .get(id) as { b: string; h: string; t: string | null };
      // Interpolated, not the template's placeholders — what was sent is what
      // will be signed.
      expect(row.b, name).toContain("Agreement for Ayşe");
      expect(row.b, name).not.toContain("{{");
      expect(row.h, name).toMatch(/^[0-9a-f]{64}$/);
      // Scoped to the calling workspace on every surface, never null.
      expect(row.t, name).not.toBeNull();

      const signer = client
        .query("select token_hash as th from signature_signers where request_id = ?")
        .get(id) as { th: string };
      expect(signer.th, name).toMatch(/^[0-9a-f]{64}$/);
      expect(signer.th, name).not.toContain("sig_");
    }
  });

  test("each one refuses a duplicate signer with the same message", async () => {
    const dupes = [{ email: "a@example.com" }, { email: "A@example.com" }];
    const rest = await h.fetch("/api/admin/signatures", json("POST", { ...BODY, signers: dupes }));
    expect(rest.status).toBe(422);

    await expect(sdk().signatures.create({ ...BODY, signers: dupes })).rejects.toThrow(/twice/i);

    const g = await gql(
      `mutation ($html: String!, $s: [SignatureSignerInput!]!) {
         createSignatureRequest(html: $html, signers: $s) { sent }
       }`,
      { html: BODY.html, s: dupes },
    );
    expect(g.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    await expect(
      mcp("signatures.send").handler({ ...BODY, signers: dupes }, mcpCtx()),
    ).rejects.toThrow(/twice/i);
  });
});
