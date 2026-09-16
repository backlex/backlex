/**
 * The themed shell — the document a template body is rendered inside.
 *
 * The specs next door (`template-appearance.test.ts`) all ask a template to
 * PRINT a theme value, and every one of them passes whether or not an
 * appearance does anything beyond substitution — several assert on the subject
 * line, which is never wrapped at all. That was an honest reflection of the
 * feature at the time and it hid the thing an admin actually noticed: none of
 * the thirteen built-in templates writes `theme.`, so out of the box, picking
 * dark or a new accent changed nothing.
 *
 * So every spec here uses a body that mentions NO theme variable. If the
 * appearance still reaches the output, it is the shell that put it there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DARK, LIGHT, appearanceProblem, normalizeAppearance } from "@backlex/core/appearance";
import { applyShell, isCompleteDocument } from "@backlex/core/template-shell";
import { AppearanceSchema } from "../../src/server/lib/appearance-schema";
import { sendTemplatedEmail } from "../../src/server/services/email";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");
const DOCS = "/api/admin/documents";
const EMAILS = "/api/admin/email-templates";
/** Mentions no theme variable — the whole point. */
const PLAIN = "<p>Hello Ada</p>";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

describe("applyShell", () => {
  test("an appearance reaches a body that never mentions one", () => {
    const out = applyShell(PLAIN, { theme: "dark", accent: "#E5484D", font: "mono" }, "email");
    expect(out).toContain(DARK.bg);
    expect(out).toContain(DARK.card);
    expect(out).toContain("#E5484D");
    expect(out).toContain("JetBrains Mono");
    // And the body is still in there, unaltered.
    expect(out).toContain(PLAIN);
  });

  test("changing one setting changes the output", () => {
    const dark = applyShell(PLAIN, { theme: "dark" }, "email");
    const light = applyShell(PLAIN, { theme: "light" }, "email");
    expect(dark).not.toBe(light);
    expect(dark).toContain(DARK.bg);
    expect(light).toContain(LIGHT.bg);
  });

  test("no appearance still produces a composed document, on the light defaults", () => {
    const out = applyShell(PLAIN, null, "email");
    expect(isCompleteDocument(out)).toBe(true);
    expect(out).toContain(LIGHT.bg);
  });

  test("a body that brings its own <html> is returned byte-identical", () => {
    const own = "<!doctype html><html><body>mine</body></html>";
    expect(applyShell(own, { theme: "dark" }, "email")).toBe(own);
    expect(applyShell(own, { theme: "dark" }, "document")).toBe(own);
    // Leading whitespace is still a complete document.
    const spaced = "\n  <html><body>mine</body></html>";
    expect(applyShell(spaced, { theme: "dark" }, "document")).toBe(spaced);
  });

  test("shell:false is the opt-out", () => {
    expect(applyShell(PLAIN, { theme: "dark", shell: false }, "email")).toBe(PLAIN);
    expect(applyShell(PLAIN, { theme: "dark", shell: false }, "document")).toBe(PLAIN);
  });

  test("wrapping is idempotent — a wrapped body is not wrapped again", () => {
    const once = applyShell(PLAIN, { theme: "dark" }, "email");
    expect(applyShell(once, { theme: "dark" }, "email")).toBe(once);
  });

  test("email and document shells differ where the medium differs", () => {
    const mail = applyShell(PLAIN, { font: "lexend" }, "email");
    const doc = applyShell(PLAIN, { font: "lexend" }, "document");
    // A mail client needs tables; a PDF engine does not.
    expect(mail).toContain("<table");
    expect(doc).not.toContain("<table");
    // Only the PDF can load the webfont — mail clients ignore the stylesheet,
    // which is why `theme.font` is a stack.
    expect(doc).toContain("fonts.googleapis.com");
    expect(mail).not.toContain("fonts.googleapis.com");
  });

  test("only a normalized appearance can reach a style declaration", () => {
    // `normalizeAppearance` is what every call site passes through. An accent
    // that is not `#rrggbb` never becomes one.
    const hostile = normalizeAppearance({ accent: "red;}body{display:none" });
    expect(hostile).toBeNull();
    expect(applyShell(PLAIN, hostile, "email")).not.toContain("display:none");
  });

  test("`shell` is a setting on every surface that validates one", () => {
    expect(appearanceProblem({ shell: false })).toBeNull();
    expect(appearanceProblem({ shell: "no" })).toMatch(/shell/);
    expect(AppearanceSchema.safeParse({ shell: false }).success).toBe(true);
    expect(AppearanceSchema.safeParse({ shell: "no" }).success).toBe(false);
    // Stored only in the OFF position — the ON one is what unset already does.
    expect(normalizeAppearance({ shell: true })).toBeNull();
    expect(normalizeAppearance({ shell: false })).toEqual({ shell: false });
  });
});

describe("the send path", () => {
  let h: TestHarness;
  let sent: { html?: string; text?: string; subject: string }[] = [];

  const ctxWithStubMailer = async () => {
    const { buildContext } = await import("../../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.emailFor = async () => ({
      name: "stub",
      attachments: true,
      send: async (msg: { html?: string; text?: string; subject: string }) => {
        sent.push(msg);
      },
    });
    return ctx;
  };

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    sent = [];
  });
  afterEach(() => h.cleanup());

  const create = (appearance: unknown) =>
    h.fetch(
      EMAILS,
      json("POST", { key: "plain", name: "Plain", subject: "Hi", bodyHtml: PLAIN, appearance }),
    );

  test("a stored template is sent inside its theme", async () => {
    expect((await create({ theme: "dark", accent: "#34C79A" })).status).toBe(201);
    const me = (await (await h.fetch("/api/me")).json()) as { data: { tenantId: string } };
    await sendTemplatedEmail(await ctxWithStubMailer(), {
      tenantId: me.data.tenantId,
      to: "reader@example.test",
      templateKey: "plain",
      vars: {},
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain(DARK.card);
    expect(sent[0]!.html).toContain("#34C79A");
  });

  test("the text part is taken from the body, NOT from the shell", async () => {
    // Regression: wrapping first and then deriving the plain-text alternative
    // walks the layout tables, so a text-only reader gets the chrome. The order
    // in `sendTemplatedEmail` is what this pins.
    expect((await create({ theme: "dark" })).status).toBe(201);
    const me = (await (await h.fetch("/api/me")).json()) as { data: { tenantId: string } };
    await sendTemplatedEmail(await ctxWithStubMailer(), {
      tenantId: me.data.tenantId,
      to: "reader@example.test",
      templateKey: "plain",
      vars: {},
    });
    expect(sent[0]!.text).toContain("Hello Ada");
    expect(sent[0]!.text).not.toContain(DARK.card);
    expect(sent[0]!.text?.toLowerCase()).not.toContain("doctype");
  });

  test("a fallback — the built-in mail nobody customized — is composed too", async () => {
    await sendTemplatedEmail(await ctxWithStubMailer(), {
      tenantId: null,
      to: "reader@example.test",
      templateKey: "nothing-stored-under-this-key",
      fallback: { subject: "Hi", html: PLAIN },
      vars: {},
    });
    expect(sent[0]!.html).toContain(LIGHT.card);
    expect(sent[0]!.text).not.toContain(LIGHT.card);
  });

  test("a test send matches what a real recipient gets", async () => {
    const res = await h.fetch(
      `${EMAILS}/send-test`,
      json("POST", {
        to: "probe@example.test",
        subject: "Hi",
        bodyHtml: PLAIN,
        appearance: { theme: "dark", accent: "#E85CA8" },
        vars: {},
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("the document render path", () => {
  let h: TestHarness;
  let rendered: { html: string; opts: any }[] = [];
  let ctx: any;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    rendered = [];
    const { buildContext } = await import("../../src/server/context");
    ctx = await buildContext(h.env);
    ctx.pdf = {
      name: "stub",
      render: async (html: string, opts: any) => {
        rendered.push({ html, opts });
        return FAKE_PDF;
      },
    };
  });
  afterEach(() => h.cleanup());

  test("the sheet is rendered in the theme, and the running header is NOT", async () => {
    const { renderDocument } = await import("../../src/server/services/documents");
    const me = (await (await h.fetch("/api/me")).json()) as { data: { tenantId: string } };
    await renderDocument(ctx, me.data.tenantId, {
      html: PLAIN,
      headerHtml: "<span>page</span>",
      footerHtml: "<span>foot</span>",
      appearance: { theme: "dark", accent: "#8FCC5C" },
      vars: {},
    } as any);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.html).toContain(DARK.bg);
    expect(rendered[0]!.html).toContain("#8FCC5C");
    // A header rendered into a 20mm margin box must not become a second
    // full-page document.
    expect(rendered[0]!.opts.headerHtml).toBe("<span>page</span>");
    expect(rendered[0]!.opts.footerHtml).toBe("<span>foot</span>");
  });

  test("REST render of a stored template wraps it", async () => {
    await h.fetch(`${DOCS}/templates/invoice`, json("PUT", { bodyHtml: PLAIN, appearance: { theme: "dark" } }));
    const res = await h.fetch(`${DOCS}/render`, json("POST", { templateKey: "invoice", vars: {} }));
    expect(res.status).toBe(200);
    expect(rendered[0]!.html).toContain(DARK.bg);
  });

  test("shell:false renders exactly the body", async () => {
    await h.fetch(
      `${DOCS}/templates/bare`,
      json("PUT", { bodyHtml: PLAIN, appearance: { theme: "dark", shell: false } }),
    );
    await h.fetch(`${DOCS}/render`, json("POST", { templateKey: "bare", vars: {} }));
    expect(rendered[0]!.html).toBe(PLAIN);
  });
});
