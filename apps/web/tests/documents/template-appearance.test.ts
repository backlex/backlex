/**
 * Template appearance — the theme, accent and font a form stores, on email and
 * document templates.
 *
 * A template is raw HTML, so an appearance only matters if it REACHES the HTML.
 * It does as `{{ theme.* }}` values, filled by the same function on every path
 * that renders a stored template: the mailer, the email test send, a document
 * render, and the frozen snapshot of a signature request. The specs below ask
 * each path for a value that only the appearance could have put there, because
 * a setting that is stored and never rendered looks exactly like one that works
 * until somebody opens the mail.
 *
 * And the surfaces: REST validates with its schema, GraphQL hands the service a
 * JSON scalar, so the service refuses a malformed appearance itself — asserted
 * on GraphQL, the surface with no schema of its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  APPEARANCE_FONTS,
  APPEARANCE_THEMES,
  DARK,
  DEFAULT_ACCENT,
  LIGHT,
  accentInk,
  appearanceProblem,
  normalizeAppearance,
  themeVars,
  withThemeVars,
} from "@backlex/core/appearance";
import { createClient } from "../../../../packages/client/src";
import { AppearanceSchema } from "../../src/server/lib/appearance-schema";
import { documentsTools } from "../../src/server/mcp/tools/documents";
import { sendTemplatedEmail } from "../../src/server/services/email";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");
const DOCS = "/api/admin/documents";
const EMAILS = "/api/admin/email-templates";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

describe("the theme values", () => {
  test("an unset appearance renders the light defaults, never an empty value", () => {
    const v = themeVars(null);
    expect(v.mode).toBe("light");
    expect(v.bg).toBe(LIGHT.bg);
    expect(v.accent).toBe(DEFAULT_ACCENT);
    expect(v.accentInk).toBe(accentInk(DEFAULT_ACCENT));
    expect(v.font).toContain("Manrope");
    for (const value of Object.values(v)) expect(value).not.toBe("");
  });

  test("a chosen appearance becomes its palette, accent and font", () => {
    const v = themeVars({ theme: "dark", accent: "#F2C14E", font: "mono" });
    expect(v.bg).toBe(DARK.bg);
    expect(v.text).toBe(DARK.text);
    expect(v.accent).toBe("#F2C14E");
    // A pale accent gets dark ink, so a button label stays readable.
    expect(v.accentInk).toBe("#17141F");
    expect(v.font).toContain("JetBrains Mono");
  });

  test("a stored value that is not a setting never reaches a style attribute", () => {
    expect(normalizeAppearance({ theme: "neon", accent: "red;background:url(x)", font: "comic" })).toBeNull();
    expect(themeVars({ accent: "red;x" } as never).accent).toBe(DEFAULT_ACCENT);
  });

  test("a caller's own `theme` wins over the template's", () => {
    const vars = withThemeVars({ theme: "legacy", data: { a: 1 } }, { theme: "dark" });
    expect(vars.theme).toBe("legacy");
  });

  test("appearanceProblem names the offending setting", () => {
    expect(appearanceProblem(null)).toBeNull();
    expect(appearanceProblem({ theme: "dark", accent: "#123456", font: "lexend" })).toBeNull();
    expect(appearanceProblem({ accent: "red" })).toMatch(/accent/);
    expect(appearanceProblem({ colour: "#123456" })).toMatch(/colour/);
    expect(appearanceProblem("dark")).toMatch(/object/);
  });

  test("the request schema offers exactly the settings the renderer understands", () => {
    // The schema spells its enums out as literals (the openapi generator needs
    // them), so this is what keeps the two lists from drifting apart.
    const shape = AppearanceSchema.shape as any;
    expect([...shape.theme.unwrap().options].sort()).toEqual([...APPEARANCE_THEMES].sort());
    expect([...shape.font.unwrap().options].sort()).toEqual([...APPEARANCE_FONTS].sort());
  });
});

describe("email templates", () => {
  let h: TestHarness;
  let emails: string[] = [];
  const restoreLog = console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    emails = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[email]")) emails.push(line);
    };
  });
  afterEach(() => {
    console.log = restoreLog;
    h.cleanup();
  });

  const create = async (appearance: unknown) => {
    const res = await h.fetch(
      EMAILS,
      json("POST", {
        key: "themed",
        name: "Themed",
        subject: "Mode {{ theme.mode }} accent {{ theme.accent }}",
        bodyHtml: '<p style="color:{{ theme.accent }}">Hello {{ name }}</p>',
        appearance,
      }),
    );
    return res;
  };

  test("the appearance is stored, read back, and cleared with null", async () => {
    const created = await create({ theme: "dark", accent: "#E5484D" });
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { data: { id: string; appearance: unknown } }).data;
    expect(row.appearance).toEqual({ theme: "dark", accent: "#E5484D" });

    const listed = ((await (await h.fetch(EMAILS)).json()) as { data: { key: string; appearance: unknown }[] }).data;
    expect(listed.find((r) => r.key === "themed")?.appearance).toEqual({ theme: "dark", accent: "#E5484D" });

    const cleared = await h.fetch(`${EMAILS}/${row.id}`, json("PATCH", { appearance: null }));
    expect(((await cleared.json()) as { data: { appearance: unknown } }).data.appearance).toBeNull();
  });

  test("a malformed appearance is refused", async () => {
    expect((await create({ accent: "red" })).status).toBe(422);
    expect((await create({ theme: "neon" })).status).toBe(422);
  });

  test("a stored template is SENT with its appearance", async () => {
    expect((await create({ theme: "dark", accent: "#E5484D" })).status).toBe(201);
    const me = (await (await h.fetch("/api/me")).json()) as { data: { tenantId: string } };
    const { buildContext } = await import("../../src/server/context");
    const ctx = await buildContext(h.env);
    const res = await sendTemplatedEmail(ctx, {
      tenantId: me.data.tenantId,
      to: "reader@example.test",
      templateKey: "themed",
      vars: { name: "Ada" },
    });
    expect(res.templateApplied).toBe(true);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain('subject="Mode dark accent #E5484D"');
  });

  test("a draft test send renders the draft's appearance, not the saved one", async () => {
    const res = await h.fetch(
      `${EMAILS}/send-test`,
      json("POST", {
        to: "probe@example.test",
        subject: "Mode {{ theme.mode }} on {{ theme.bg }}",
        bodyHtml: "<p>x</p>",
        appearance: { theme: "dark" },
        vars: {},
      }),
    );
    expect(res.status).toBe(200);
    expect(emails[0]).toContain(`subject="Mode dark on ${DARK.bg}"`);
  });

  test("a saved test send of a template without an appearance still fills theme values", async () => {
    const created = await create(undefined);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    expect((await h.fetch(`${EMAILS}/${id}/send-test`, json("POST", { to: "p@example.test" }))).status).toBe(200);
    expect(emails[0]).toContain(`subject="Mode light accent ${DEFAULT_ACCENT}"`);
  });
});

describe("document templates", () => {
  let h: TestHarness;
  let client: Database;
  let rendered: { html: string; opts: any }[] = [];

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH as string);
    rendered = [];
    const { buildContext } = await import("../../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = {
      name: "stub",
      render: async (html: string, opts: any) => {
        rendered.push({ html, opts });
        return FAKE_PDF;
      },
    };
  });
  afterEach(() => h.cleanup());

  const THEMED_BODY = "<html><body style=\"background:{{ theme.bg }}\">{{ theme.mode }} {{ theme.accent }} {{ data.no }}</body></html>";

  const put = async (key: string, body: Record<string, unknown>) => {
    const res = await h.fetch(`${DOCS}/templates/${key}`, json("PUT", body));
    return { status: res.status, body: (await res.json()) as any };
  };

  test("REST stores the appearance and a render reads it", async () => {
    const saved = await put("invoice", { bodyHtml: THEMED_BODY, appearance: { theme: "dark", accent: "#34C79A" } });
    expect(saved.status).toBe(200);
    expect(saved.body.data.appearance).toEqual({ theme: "dark", accent: "#34C79A" });
    expect(saved.body.data.overridesDefault).toBe(false);

    const res = await h.fetch(`${DOCS}/render`, json("POST", { templateKey: "invoice", vars: { data: { no: "7" } } }));
    expect(res.status).toBe(200);
    expect(rendered[0]!.html).toContain(`background:${DARK.bg}`);
    expect(rendered[0]!.html).toContain("dark #34C79A 7");
  });

  test("a render's own appearance overrides the template's — how an unsaved draft is tested", async () => {
    await put("quote", { bodyHtml: THEMED_BODY, appearance: { theme: "dark" } });
    await h.fetch(
      `${DOCS}/render`,
      json("POST", { templateKey: "quote", appearance: { theme: "light", accent: "#E85CA8" }, vars: { data: { no: 1 } } }),
    );
    expect(rendered[0]!.html).toContain("light #E85CA8 1");
  });

  test("inline html renders with its running header, footer and appearance", async () => {
    const res = await h.fetch(
      `${DOCS}/render`,
      json("POST", {
        html: THEMED_BODY,
        headerHtml: "<span>{{ data.no }}</span>",
        footerHtml: '<span style="color:{{ theme.accent }}" class="pageNumber"></span>',
        appearance: { accent: "#FF8A5C" },
        vars: { data: { no: "H-1" } },
      }),
    );
    expect(res.status).toBe(200);
    expect(rendered[0]!.opts.headerHtml).toBe("<span>H-1</span>");
    expect(rendered[0]!.opts.footerHtml).toContain("color:#FF8A5C");
  });

  test("a malformed appearance is refused on REST and on GraphQL alike", async () => {
    expect((await put("bad", { bodyHtml: "<html>x</html>", appearance: { accent: "red" } })).status).toBe(422);
    const res = await h.fetch(
      "/api/graphql",
      json("POST", {
        query: `mutation ($d: DocumentTemplateInput!) { saveDocumentTemplate(key: "bad", data: $d) { key } }`,
        variables: { d: { bodyHtml: "<html>x</html>", appearance: { accent: "red" } } },
      }),
    );
    const out = (await res.json()) as { errors?: { message: string; extensions?: { code?: string } }[] };
    expect(out.errors?.[0]?.extensions?.code).toBe("VALIDATION");
    expect(out.errors?.[0]?.message).toMatch(/accent/);
  });

  test("resetting a workspace copy returns the shared default it overrode", async () => {
    const now = Date.now();
    client
      .query(
        `insert into document_templates (id, tenant_id, key, name, body_html, appearance, created_at, updated_at)
         values (?, NULL, 'terms', 'Shared terms', '<html>shared</html>', '{"theme":"dark"}', ?, ?)`,
      )
      .run(crypto.randomUUID(), now, now);
    const mine = await put("terms", { bodyHtml: "<html>mine</html>", appearance: { accent: "#8FCC5C" } });
    expect(mine.body.data.overridesDefault).toBe(true);

    const res = await h.fetch(`${DOCS}/templates/terms`, json("DELETE"));
    const body = (await res.json()) as any;
    expect(body.data).toMatchObject({ key: "terms", inherited: true, bodyHtml: "<html>shared</html>" });
    expect(body.data.appearance).toEqual({ theme: "dark" });
  });

  test("deleting a template with no default behind it answers null", async () => {
    await put("solo", { bodyHtml: "<html>x</html>" });
    const body = (await (await h.fetch(`${DOCS}/templates/solo`, json("DELETE"))).json()) as any;
    expect(body).toEqual({ ok: true, data: null });
  });

  test("GraphQL, MCP and the SDK carry the appearance both ways", async () => {
    const gql = (await (
      await h.fetch(
        "/api/graphql",
        json("POST", {
          query: `mutation ($d: DocumentTemplateInput!) {
            saveDocumentTemplate(key: "g", data: $d) { key appearance overridesDefault }
          }`,
          variables: { d: { bodyHtml: THEMED_BODY, appearance: { font: "lexend" } } },
        }),
      )
    ).json()) as any;
    expect(gql.errors).toBeUndefined();
    expect(gql.data.saveDocumentTemplate).toEqual({ key: "g", appearance: { font: "lexend" }, overridesDefault: false });

    const tool = documentsTools.find((t) => t.name === "documents.save")!;
    const saved = (await tool.handler(
      { key: "m", bodyHtml: THEMED_BODY, appearance: { theme: "dark" } },
      { fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) } as any,
    )).structuredContent as any;
    expect(saved.data.appearance).toEqual({ theme: "dark" });

    const sdk = createClient({ url: "http://local.test", fetch: (input: any, init: any) => h.fetch(String(input), init) });
    await sdk.documents.save("s", { bodyHtml: THEMED_BODY, appearance: { accent: "#3AC9C4" } });
    const listed = await sdk.documents.list();
    expect(listed.data.find((t) => t.key === "s")?.appearance).toEqual({ accent: "#3AC9C4" });
    await sdk.documents.render({ templateKey: "s", vars: { data: { no: 2 } } });
    expect(rendered.at(-1)!.html).toContain("light #3AC9C4 2");
  });

  test("a signature request freezes the document WITH its appearance", async () => {
    await put("lease", { bodyHtml: THEMED_BODY, appearance: { theme: "dark", accent: "#C77DFF" } });
    const restoreLog = console.log;
    console.log = () => {};
    try {
      const res = await h.fetch(
        "/api/admin/signatures",
        json("POST", {
          title: "Lease",
          templateKey: "lease",
          vars: { data: { no: "L-9" } },
          signers: [{ email: "tenant@example.com", name: "Ayşe" }],
        }),
      );
      expect(res.status).toBeLessThan(300);
      const { data } = (await res.json()) as any;
      const full = (await (await h.fetch(`/api/admin/signatures/${data.request.id}`)).json()) as any;
      expect(full.data.bodyHtml).toContain("dark #C77DFF L-9");
      expect(full.data.bodyHtml).not.toContain("{{");
    } finally {
      console.log = restoreLog;
    }
  });

  test("a template bundle carries the appearance out through extract", async () => {
    await put("bundle_doc", { bodyHtml: THEMED_BODY, appearance: { theme: "dark", font: "system" } });
    // Extract refuses a workspace with no collections — the bundle rides along
    // with a schema, it is not exported on its own.
    const col = await h.fetch("/api/collections", json("POST", { slug: "tickets", fields: [{ name: "subject", type: "text" }] }));
    expect(col.status).toBe(201);
    const extracted = (await (await h.fetch("/api/admin/templates/extract")).json()) as any;
    const doc = (extracted.data?.documents ?? []).find((d: any) => d.key === "bundle_doc");
    expect(doc?.appearance).toEqual({ theme: "dark", font: "system" });
  });
});
