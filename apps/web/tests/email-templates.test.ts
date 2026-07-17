/**
 * Admin email templates — `/api/admin/email-templates`.
 *
 * Covers the CRUD lifecycle, the send-test endpoint (through the default
 * console transport, and through a deliberately broken SMTP transport to
 * prove failures surface as clean AppError-style JSON, not a crash), and
 * admin-only enforcement.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const TEMPLATE = {
  key: "welcome",
  name: "Welcome email",
  subject: "Welcome, {{user.email}}!",
  bodyHtml: "<p>Hello {{user.email}}, glad you joined {{site.name}}.</p>",
  bodyText: "Hello {{user.email}}",
  variables: ["user.email", "site.name"],
};

interface TemplateRow {
  id: string;
  tenantId: string | null;
  key: string;
  name: string;
  subject: string;
  fromAddress: string | null;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[] | null;
}

const createTemplate = async (
  h: TestHarness,
  overrides: Partial<typeof TEMPLATE> & { fromAddress?: string } = {},
): Promise<TemplateRow> => {
  const res = await h.fetch(
    "/api/admin/email-templates",
    json("POST", { ...TEMPLATE, ...overrides }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: TemplateRow }).data;
};

describe("/api/admin/email-templates", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("full CRUD lifecycle: create → list → get → patch → delete", async () => {
    h = makeHarness();
    await seedAdmin(h);

    // Create
    const created = await createTemplate(h);
    expect(created.id).toBeTruthy();
    expect(created.key).toBe("welcome");
    expect(created.subject).toBe(TEMPLATE.subject);
    expect(created.fromAddress).toBeNull(); // not sent → null
    expect(created.variables).toEqual(TEMPLATE.variables);

    // List includes it
    const list = await h.fetch("/api/admin/email-templates");
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: TemplateRow[] }).data;
    expect(rows.some((r) => r.id === created.id)).toBe(true);

    // Get by id
    const got = await h.fetch(`/api/admin/email-templates/${created.id}`);
    expect(got.status).toBe(200);
    const row = ((await got.json()) as { data: TemplateRow }).data;
    expect(row.id).toBe(created.id);
    expect(row.bodyHtml).toBe(TEMPLATE.bodyHtml);

    // Patch just the subject — other fields must survive
    const patched = await h.fetch(
      `/api/admin/email-templates/${created.id}`,
      json("PATCH", { subject: "Hi again" }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ ok: true });
    const after = (
      (await (await h.fetch(`/api/admin/email-templates/${created.id}`)).json()) as {
        data: TemplateRow;
      }
    ).data;
    expect(after.subject).toBe("Hi again");
    expect(after.bodyHtml).toBe(TEMPLATE.bodyHtml);
    expect(after.variables).toEqual(TEMPLATE.variables);

    // Delete
    const del = await h.fetch(`/api/admin/email-templates/${created.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    const gone = await h.fetch(`/api/admin/email-templates/${created.id}`);
    expect(gone.status).toBe(404);
    const body = (await gone.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("empty-string fromAddress is accepted and stored as null", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await createTemplate(h, { fromAddress: "" });
    expect(created.fromAddress).toBeNull();
  });

  test("create rejects an invalid body (bad fromAddress, missing subject)", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const badFrom = await h.fetch(
      "/api/admin/email-templates",
      json("POST", { ...TEMPLATE, fromAddress: "not-an-email" }),
    );
    expect(badFrom.status).toBe(422);
    const { subject: _omit, ...noSubject } = TEMPLATE;
    const missing = await h.fetch(
      "/api/admin/email-templates",
      json("POST", noSubject),
    );
    expect(missing.status).toBe(422);
  });

  test("send-test succeeds through the default (console) transport", async () => {
    // With no SMTP / provider configured the deployment falls back to the
    // console email adapter, so the send "succeeds" by printing to stdout —
    // this is the documented dev behavior, not an error.
    h = makeHarness();
    await seedAdmin(h);
    const created = await createTemplate(h);
    const res = await h.fetch(
      `/api/admin/email-templates/${created.id}/send-test`,
      json("POST", { to: "probe@example.test", vars: { site: { name: "T" } } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Bodyless POST also works (falls back to sample vars + caller email).
    const bare = await h.fetch(
      `/api/admin/email-templates/${created.id}/send-test`,
      { method: "POST" },
    );
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ ok: true });
  });

  test("send-test on a missing template is a clean 404 JSON error", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/email-templates/does-not-exist/send-test",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Template not found");
  });

  test("send-test through a broken SMTP transport fails as clean JSON, not a crash", async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Point the workspace transport at an SMTP server that isn't there.
    const cfg = await h.fetch(
      "/api/admin/email-config",
      json("PUT", {
        provider: "smtp",
        fromAddress: "noreply@example.test",
        config: { host: "127.0.0.1", port: 59999, secure: false },
      }),
    );
    expect(cfg.status).toBe(200);
    const created = await createTemplate(h);
    const res = await h.fetch(
      `/api/admin/email-templates/${created.id}/send-test`,
      json("POST", { to: "probe@example.test" }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
      requestId?: string;
    };
    expect(body.error.code).toBe("INTERNAL");
    // Internals (connection errors) must not leak to the client.
    expect(body.error.message).toBe("Internal server error");
  });

  test("admin-only: 401 without a session, 403 for a non-admin user", async () => {
    h = makeHarness();
    const anon = await h.fetch("/api/admin/email-templates");
    expect(anon.status).toBe(401);

    await seedAdmin(h);
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const signup = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(signup.ok).toBe(true);

    const list = await h.fetch("/api/admin/email-templates");
    expect(list.status).toBe(403);
    const create = await h.fetch("/api/admin/email-templates", json("POST", TEMPLATE));
    expect(create.status).toBe(403);
    const body = (await create.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
