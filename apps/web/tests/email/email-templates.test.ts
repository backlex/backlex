/**
 * Admin email templates — `/api/admin/email-templates`.
 *
 * Covers the CRUD lifecycle, the send-test endpoint (through the default
 * console transport, and through a deliberately broken SMTP transport to
 * prove failures surface as clean AppError-style JSON, not a crash), and
 * admin-only enforcement.
 *
 * And the override rule, which is the part that was wrong: the instance-wide
 * defaults (`tenant_id IS NULL`, seeded at boot) used to be PATCHed and DELETEd
 * in place by id, so one workspace admin's edit rewrote the mail of every other
 * workspace. Editing a default now writes the workspace's own copy, and the
 * shared row is asserted untouched in the database itself rather than through
 * the API that used to be the problem.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildContext } from "../../src/server/context";
import { seedEmailTemplates } from "../../src/server/services/seed";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

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
  inherited: boolean;
  overridesDefault: boolean;
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
    // No shared default named `welcome`, so this is a plain workspace template.
    expect(created.inherited).toBe(false);
    expect(created.overridesDefault).toBe(false);

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
    const patchedBody = (await patched.json()) as { ok: boolean; data: TemplateRow };
    expect(patchedBody.ok).toBe(true);
    // The saved row comes back — an override of a default has a NEW id, and
    // the caller has no other way to learn it.
    expect(patchedBody.data.id).toBe(created.id);
    expect(patchedBody.data.subject).toBe("Hi again");
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
    // Nothing shared sits behind `welcome`, so the key now resolves to nothing.
    expect(await del.json()).toEqual({ ok: true, data: null });
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

const list = async (h: TestHarness, headers: Record<string, string> = {}) => {
  const res = await h.fetch("/api/admin/email-templates", { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: TemplateRow[] }).data;
};

/** A fresh admin plus the seeded instance-wide defaults. The app seeds them on
 *  the first request of a PROCESS, not of a database, so every harness after the
 *  first one in a run would otherwise start without them. */
const harnessWithDefaults = async (): Promise<TestHarness> => {
  const harness = makeHarness();
  await seedAdmin(harness);
  const ctx = await buildContext(harness.env);
  await seedEmailTemplates({ db: ctx.db, dialect: ctx.dialect });
  return harness;
};

/** The shared `verify` row exactly as the database holds it — read around the
 *  API on purpose, since the API is what used to rewrite it. */
const sharedVerify = (h: TestHarness) => {
  const db = new Database(h.env.SQLITE_PATH as string);
  try {
    return db
      .query("select id, subject, body_html as bodyHtml from email_templates where tenant_id is null and key = 'verify'")
      .get() as { id: string; subject: string; bodyHtml: string } | null;
  } finally {
    db.close();
  }
};

describe("shared defaults are copy-on-write", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("the list shows one row per key, and a seeded default reads as inherited", async () => {
    h = await harnessWithDefaults();
    const rows = await list(h);
    const verify = rows.filter((r) => r.key === "verify");
    expect(verify).toHaveLength(1);
    expect(verify[0]!.inherited).toBe(true);
    expect(verify[0]!.overridesDefault).toBe(false);
  });

  test("saving a default creates the workspace's copy and leaves the shared row alone", async () => {
    h = await harnessWithDefaults();
    const before = sharedVerify(h);
    expect(before).not.toBeNull();

    const res = await h.fetch(
      `/api/admin/email-templates/${before!.id}`,
      json("PATCH", { subject: "Workspace wording" }),
    );
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { data: TemplateRow }).data;
    expect(saved.id).not.toBe(before!.id);
    expect(saved.tenantId).not.toBeNull();
    expect(saved.key).toBe("verify");
    expect(saved.subject).toBe("Workspace wording");
    // Everything the patch did not name is copied from the default, not blanked.
    expect(saved.bodyHtml).toBe(before!.bodyHtml);
    expect(saved.overridesDefault).toBe(true);

    expect(sharedVerify(h)).toEqual(before);

    const rows = (await list(h)).filter((r) => r.key === "verify");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(saved.id);
    expect(rows[0]!.inherited).toBe(false);

    // A stale tab still holding the SHARED id saves into the same copy rather
    // than colliding with it on the (tenant_id, key) unique index.
    const again = await h.fetch(
      `/api/admin/email-templates/${before!.id}`,
      json("PATCH", { subject: "Second save" }),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: TemplateRow }).data.id).toBe(saved.id);
    expect(sharedVerify(h)).toEqual(before);
  });

  test("another workspace keeps rendering the default", async () => {
    h = await harnessWithDefaults();
    const suffix = `${Date.now()}`.slice(-6);
    const other = await h.fetch("/api/tenants", json("POST", { name: `Tenant ${suffix}` }));
    expect(other.ok).toBe(true);

    const shared = sharedVerify(h)!;
    const res = await h.fetch(
      `/api/admin/email-templates/${shared.id}`,
      json("PATCH", { subject: "Only in default" }),
    );
    expect(res.status).toBe(200);

    const theirs = (await list(h, { "X-Backlex-Tenant": `tenant-${suffix}` })).find(
      (r) => r.key === "verify",
    );
    expect(theirs?.subject).toBe(shared.subject);
    expect(theirs?.inherited).toBe(true);
  });

  test("a default cannot be re-keyed or deleted from a workspace", async () => {
    h = await harnessWithDefaults();
    const shared = sharedVerify(h)!;

    const rekey = await h.fetch(
      `/api/admin/email-templates/${shared.id}`,
      json("PATCH", { key: "verify_v2" }),
    );
    expect(rekey.status).toBe(422);

    const del = await h.fetch(`/api/admin/email-templates/${shared.id}`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(sharedVerify(h)).toEqual(shared);
  });

  test("deleting the copy restores the default, and says which row now applies", async () => {
    h = await harnessWithDefaults();
    const shared = sharedVerify(h)!;
    const saved = (
      (await (
        await h.fetch(`/api/admin/email-templates/${shared.id}`, json("PATCH", { subject: "Mine" }))
      ).json()) as { data: TemplateRow }
    ).data;

    const del = await h.fetch(`/api/admin/email-templates/${saved.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const restored = ((await del.json()) as { data: TemplateRow | null }).data;
    expect(restored?.id).toBe(shared.id);
    expect(restored?.inherited).toBe(true);

    const verify = (await list(h)).find((r) => r.key === "verify");
    expect(verify?.id).toBe(shared.id);
    expect(verify?.subject).toBe(shared.subject);
  });
});

describe("template keys", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("a built-in sender's dotted key is accepted, whitespace is not", async () => {
    // `booking.confirmed` is what the booking service resolves. The admin used
    // to refuse the dot, so the booking emails could not be customized at all.
    h = makeHarness();
    await seedAdmin(h);
    const dotted = await createTemplate(h, { key: "booking.confirmed" });
    expect(dotted.key).toBe("booking.confirmed");
    expect(dotted.overridesDefault).toBe(false);

    for (const key of ["has space", "x", "-leading", "a".repeat(41)]) {
      const res = await h.fetch("/api/admin/email-templates", json("POST", { ...TEMPLATE, key }));
      expect(`${key} → ${res.status}`).toBe(`${key} → 422`);
    }
  });

  test("a key the workspace already owns is a 409, not a 500", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await createTemplate(h);
    const dupe = await h.fetch("/api/admin/email-templates", json("POST", TEMPLATE));
    expect(dupe.status).toBe(409);
  });

  test("creating a template under a default's key is that workspace's override", async () => {
    h = await harnessWithDefaults();
    const created = await createTemplate(h, { key: "reset" });
    expect(created.overridesDefault).toBe(true);
    const reset = (await list(h)).filter((r) => r.key === "reset");
    expect(reset.map((r) => r.id)).toEqual([created.id]);
  });
});

describe("send-test of an unsaved draft", () => {
  let h: TestHarness;
  let emails: string[] = [];
  const restoreLog = console.log;
  afterEach(() => {
    console.log = restoreLog;
    h?.cleanup();
  });

  const capture = () => {
    emails = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[email]")) emails.push(line);
    };
  };

  test("renders exactly the draft and the vars it was given, and stores nothing", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const before = await list(h);
    capture();
    const res = await h.fetch(
      "/api/admin/email-templates/send-test",
      json("POST", {
        to: "probe@example.test",
        subject: "Signed: {{ title }}",
        bodyHtml: "<p>{{ title }} for {{ signer.name }}</p>",
        // No `site.name` default is merged in: the mail matches the preview.
        vars: { title: "MSA", signer: { name: "Ada" } },
      }),
    );
    expect(res.status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain('to=probe@example.test subject="Signed: MSA"');
    expect(emails[0]).toContain("MSA for Ada");
    expect((await list(h)).length).toBe(before.length);
  });

  test("an explicit plain-text part is sent instead of the derived one", async () => {
    h = makeHarness();
    await seedAdmin(h);
    capture();
    const res = await h.fetch(
      "/api/admin/email-templates/send-test",
      json("POST", {
        to: "probe@example.test",
        subject: "Hi",
        bodyHtml: "<p>html part</p>",
        bodyText: "text part for {{ who }}",
        vars: { who: "Grace" },
      }),
    );
    expect(res.status).toBe(200);
    expect(emails[0]).toContain("text part for Grace");
    expect(emails[0]).not.toContain("html part");
  });

  test("a draft with no subject or body is refused before anything is sent", async () => {
    h = makeHarness();
    await seedAdmin(h);
    capture();
    const res = await h.fetch(
      "/api/admin/email-templates/send-test",
      json("POST", { subject: "", bodyHtml: "" }),
    );
    expect(res.status).toBe(422);
    expect(emails).toEqual([]);
  });
});
