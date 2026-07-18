import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Public form builder — F1 core: admin CRUD (token minted once, never listed),
 * eligibility fence, the public definition + submit endpoints (no session),
 * spam guards (honeypot, per-form/IP rate limit, Turnstile fail-closed) and
 * the versioned→draft moderation default.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("public forms", () => {
  let h: TestHarness;
  const slug = `contact_${Date.now()}`;
  let formId = "";
  let token = "";

  /** Public request — no admin cookies attached. */
  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const adminRows = async (): Promise<Record<string, unknown>[]> => {
    const res = await h.fetch(`/api/items/${slug}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown>[] }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const createCollection = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "full_name", type: "text", required: true, label: "Full name" },
          { name: "email", type: "text", validation: { format: "email" } },
          {
            name: "priority",
            type: "text",
            options: { choices: [{ value: "low" }, { value: "high" }] },
          },
          { name: "subscribed", type: "boolean" },
          { name: "internal_note", type: "text", private: true },
          { name: "pin", type: "hash" },
        ],
      }),
    );
    expect(createCollection.status).toBe(201);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("eligible-fields excludes private and hash fields", async () => {
    const res = await h.fetch(`/api/admin/forms/eligible-fields/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    const names = body.data.map((f) => f.name);
    expect(names).toContain("full_name");
    expect(names).toContain("priority");
    expect(names).not.toContain("internal_note");
    expect(names).not.toContain("pin");
  });

  test("a form cannot expose an ineligible field", async () => {
    const res = await h.fetch(
      "/api/admin/forms",
      json({
        name: "bad",
        collection: slug,
        fields: [{ name: "internal_note" }],
      }),
    );
    expect(res.status).toBe(422);
  });

  test("create mints a one-time frm_ token with public URLs", async () => {
    const res = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Contact us",
        collection: slug,
        fields: [
          { name: "full_name", label: "Your name" },
          { name: "email" },
          { name: "priority" },
        ],
        settings: { submitLabel: "Send", successMessage: "Thanks!" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { form: { id: string }; token: string; url: string; embedUrl: string };
    };
    expect(body.data.token.startsWith("frm_")).toBe(true);
    expect(body.data.url).toBe(`/f/${body.data.token}`);
    expect(body.data.embedUrl).toBe(`/embed/f/${body.data.token}`);
    formId = body.data.form.id;
    token = body.data.token;
  });

  test("list/detail never expose the token or its hash", async () => {
    const list = await h.fetch("/api/admin/forms");
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: Record<string, unknown>[] }).data;
    const row = rows.find((r) => r.id === formId)!;
    expect(row).toBeDefined();
    expect("token" in row).toBe(false);
    expect("tokenHash" in row).toBe(false);

    const detail = await h.fetch(`/api/admin/forms/${formId}`);
    const one = ((await detail.json()) as { data: Record<string, unknown> }).data;
    expect("tokenHash" in one).toBe(false);
  });

  test("public definition renders exposed blocks only, without a session", async () => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        name: string;
        collection: string;
        submitLabel: string | null;
        turnstileSiteKey: string | null;
        theme: string;
        locale: string;
        blocks: {
          name?: string;
          label: string;
          required: boolean;
          choices: { value: string }[] | null;
        }[];
      };
    };
    expect(body.data.name).toBe("Contact us");
    expect(body.data.collection).toBe(slug);
    expect(body.data.submitLabel).toBe("Send");
    expect(body.data.turnstileSiteKey).toBeNull();
    expect(body.data.theme).toBe("dark");
    expect(body.data.locale).toBe("en");
    const names = body.data.blocks.map((f) => f.name);
    expect(names).toEqual(["full_name", "email", "priority"]);
    const nameField = body.data.blocks[0]!;
    expect(nameField.label).toBe("Your name");
    expect(nameField.required).toBe(true);
    const priority = body.data.blocks.find((f) => f.name === "priority")!;
    expect(priority.choices?.map((ch) => ch.value)).toEqual(["low", "high"]);
  });

  test("anonymous submit creates the row; extra/unexposed keys are dropped", async () => {
    const res = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({
        data: {
          full_name: "Ada Lovelace",
          email: "ada@example.com",
          priority: "high",
          subscribed: true, // eligible but NOT exposed on this form → dropped
          junk_key: "bot padding", // unknown → dropped
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string | null; successMessage: string | null };
    };
    expect(body.data.id).toBeNull();
    expect(body.data.successMessage).toBe("Thanks!");

    const rows = await adminRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.full_name).toBe("Ada Lovelace");
    expect(row.priority).toBe("high");
    expect(row.subscribed).toBeNull();
  });

  test("required + per-field validation still apply", async () => {
    const missing = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { email: "a@b.co" } }),
    );
    expect(missing.status).toBe(422);

    const badEmail = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { full_name: "x", email: "not-an-email" } }),
    );
    expect(badEmail.status).toBe(422);

    expect((await adminRows()).length).toBe(1);
  });

  test("honeypot submissions fake success and write nothing", async () => {
    const res = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({
        data: { full_name: "Bot", email: "bot@spam.io" },
        website: "https://spam.example",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string | null } };
    expect(body.data.id).toBeNull();
    expect((await adminRows()).length).toBe(1);
  });

  test("turnstile-enabled form fails closed without a server secret", async () => {
    const patch = await h.fetch(`/api/admin/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { successMessage: "Thanks!", turnstile: true } }),
    });
    expect(patch.status).toBe(200);

    const res = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { full_name: "x" }, turnstileToken: "tok" }),
    );
    expect(res.status).toBe(422);

    // Definition exposes no site key either (server has none configured).
    const def = await publicFetch(`/api/public/forms/${token}`);
    const body = (await def.json()) as { data: { turnstileSiteKey: string | null } };
    expect(body.data.turnstileSiteKey).toBeNull();

    const off = await h.fetch(`/api/admin/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { successMessage: "Thanks!" } }),
    });
    expect(off.status).toBe(200);
  });

  test("rotate-token invalidates the old token immediately", async () => {
    const res = await h.fetch(`/api/admin/forms/${formId}/rotate-token`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string } };
    expect(body.data.token.startsWith("frm_")).toBe(true);
    expect(body.data.token).not.toBe(token);

    const old = await publicFetch(`/api/public/forms/${token}`);
    expect(old.status).toBe(404);
    token = body.data.token;
    const fresh = await publicFetch(`/api/public/forms/${token}`);
    expect(fresh.status).toBe(200);
  });

  test("paused form answers 410 on both public endpoints", async () => {
    const patch = await h.fetch(`/api/admin/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(200);

    expect((await publicFetch(`/api/public/forms/${token}`)).status).toBe(410);
    expect(
      (
        await publicFetch(
          `/api/public/forms/${token}/submit`,
          json({ data: { full_name: "x" } }),
        )
      ).status,
    ).toBe(410);

    const on = await h.fetch(`/api/admin/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    expect(on.status).toBe(200);
  });

  test("per-form/IP rate limit kicks in after 10 submits per minute", async () => {
    // 1 successful submit already counted in this window? No — the limiter
    // window is per (form, ip) and earlier submits in this spec used the same
    // key, so budget may be partially spent. Rotate to a fresh form for a
    // deterministic count.
    const created = await h.fetch(
      "/api/admin/forms",
      json({
        name: "rl",
        collection: slug,
        fields: [{ name: "full_name" }],
      }),
    );
    const rlToken = ((await created.json()) as { data: { token: string } }).data.token;

    let blocked = 0;
    for (let i = 0; i < 11; i++) {
      const res = await publicFetch(
        `/api/public/forms/${rlToken}/submit`,
        json({ data: { full_name: `rl-${i}` } }),
      );
      if (res.status === 429) blocked++;
      else expect(res.status).toBe(201);
    }
    expect(blocked).toBe(1);
  });

  test("delete removes the form and kills its token", async () => {
    const del = await h.fetch(`/api/admin/forms/${formId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await publicFetch(`/api/public/forms/${token}`)).status).toBe(404);
  });
});

describe("public forms — blocks, i18n, steps, counters", () => {
  let h: TestHarness;
  const slug = `blocks_${Date.now()}`;
  let token = "";
  let formId = "";

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const col = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "full_name", type: "text", required: true },
          {
            name: "role",
            type: "text",
            options: { choices: [{ value: "designer" }, { value: "engineer" }] },
          },
          { name: "portfolio", type: "text" },
          { name: "score", type: "integer" },
        ],
      }),
    );
    expect(col.status).toBe(201);

    const created = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Apply",
        collection: slug,
        fields: [
          {
            kind: "field",
            name: "full_name",
            label: "Full name",
            placeholder: "Ada",
            i18n: { tr: { label: "Ad soyad" } },
          },
          { kind: "field", name: "role" },
          {
            kind: "field",
            name: "portfolio",
            cond: { field: "role", op: "is", value: "designer" },
          },
          { kind: "step", label: "About you", i18n: { tr: { label: "Senin hakkında" } } },
          { kind: "field", name: "score", rating: true },
        ],
        settings: {
          description: "Takes 3 minutes.",
          theme: "light",
          accent: "#8B6CFF",
          font: "lexend",
          languages: ["en", "tr"],
          successMessage: "Thanks!",
          i18n: { tr: { title: "Başvuru", successMessage: "Teşekkürler!" } },
        },
      }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: { form: { id: string }; token: string };
    };
    token = body.data.token;
    formId = body.data.form.id;
  });
  afterAll(() => h.cleanup());

  test("definition carries steps, conditions, rating, theme and languages", async () => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data.theme).toBe("light");
    expect(data.font).toBe("lexend");
    expect(data.accent).toBe("#8B6CFF");
    expect(data.languages).toEqual(["en", "tr"]);
    expect(data.locale).toBe("en");
    expect(data.description).toBe("Takes 3 minutes.");
    const kinds = data.blocks.map((b: any) => b.kind);
    expect(kinds).toEqual(["field", "field", "field", "step", "field"]);
    const portfolio = data.blocks.find((b: any) => b.name === "portfolio");
    expect(portfolio.cond).toEqual({ field: "role", op: "is", value: "designer" });
    const step = data.blocks.find((b: any) => b.kind === "step");
    expect(step.label).toBe("About you");
    const score = data.blocks.find((b: any) => b.name === "score");
    expect(score.rating).toBe(true);
    expect(data.blocks[0].placeholder).toBe("Ada");
  });

  test("?lang=tr resolves per-block and form-level strings; unknown lang falls back", async () => {
    const tr = await publicFetch(`/api/public/forms/${token}?lang=tr`);
    const { data } = (await tr.json()) as { data: Record<string, any> };
    expect(data.locale).toBe("tr");
    expect(data.name).toBe("Başvuru");
    expect(data.blocks[0].label).toBe("Ad soyad");
    // Missing tr strings fall back to the base language.
    expect(data.blocks.find((b: any) => b.name === "role").label).toBe("role");
    expect(data.blocks.find((b: any) => b.kind === "step").label).toBe("Senin hakkında");

    const de = await publicFetch(`/api/public/forms/${token}?lang=de`);
    expect(((await de.json()) as { data: { locale: string } }).data.locale).toBe("en");
  });

  test("submit with ?lang=tr returns the localized success message; counters advance", async () => {
    const ok = await publicFetch(
      `/api/public/forms/${token}/submit?lang=tr`,
      json({ data: { full_name: "Ada", score: 4 } }),
    );
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { data: { successMessage: string | null } };
    expect(body.data.successMessage).toBe("Teşekkürler!");

    // Honeypot bumps the blocked counter instead.
    const bot = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { full_name: "Bot" }, website: "spam" }),
    );
    expect(bot.status).toBe(201);

    const detail = await h.fetch(`/api/admin/forms/${formId}`);
    const row = ((await detail.json()) as { data: Record<string, unknown> }).data;
    expect(row.submissionCount).toBe(1);
    expect(row.blockedCount).toBe(1);
    expect(row.lastSubmissionAt).toBeTruthy();
  });
});

describe("public forms — consent blocks", () => {
  let h: TestHarness;
  const slug = `consent_${Date.now()}`;
  let token = "";

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const col = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "email", type: "text", required: true },
          { name: "privacy_ok", type: "boolean" },
        ],
      }),
    );
    expect(col.status).toBe(201);
    const created = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Consent",
        collection: slug,
        fields: [
          { kind: "field", name: "email" },
          {
            kind: "field",
            name: "privacy_ok",
            label: "I accept the privacy policy",
            consent: true,
            policyUrl: "https://example.com/privacy",
          },
        ],
      }),
    );
    expect(created.status).toBe(201);
    token = ((await created.json()) as { data: { token: string } }).data.token;
  });
  afterAll(() => h.cleanup());

  test("definition marks the consent block required with its policy URL", async () => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    const { data } = (await res.json()) as { data: { blocks: Record<string, unknown>[] } };
    const consent = data.blocks.find((b) => b.name === "privacy_ok")!;
    expect(consent.consent).toBe(true);
    expect(consent.required).toBe(true);
    expect(consent.policyUrl).toBe("https://example.com/privacy");
  });

  test("submit is rejected unless the consent value is exactly true", async () => {
    const missing = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { email: "a@b.co" } }),
    );
    expect(missing.status).toBe(422);

    const falsy = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { email: "a@b.co", privacy_ok: false } }),
    );
    expect(falsy.status).toBe(422);

    const ok = await publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { email: "a@b.co", privacy_ok: true } }),
    );
    expect(ok.status).toBe(201);
  });
});

describe("public forms — script embed loader", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
  });
  afterAll(() => h.cleanup());

  test("GET /embed/form.js serves the auto-height loader without auth", async () => {
    const res = await h.app.fetch(new Request(`${h.env.APP_URL}/embed/form.js`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("data-backlex-form");
    expect(body).toContain("backlex-form-height");
  });
});

describe("public forms — versioned collections", () => {
  let h: TestHarness;
  const slug = `applications_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/collections",
      json({
        slug,
        versioned: true,
        fields: [{ name: "answer", type: "text", required: true }],
      }),
    );
    expect(res.status).toBe(201);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("submissions land as drafts — a built-in moderation queue", async () => {
    const created = await h.fetch(
      "/api/admin/forms",
      json({ name: "apply", collection: slug, fields: [{ name: "answer" }] }),
    );
    expect(created.status).toBe(201);
    const token = ((await created.json()) as { data: { token: string } }).data.token;

    const submit = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/public/forms/${token}/submit`, {
        ...json({ data: { answer: "hire me" } }),
      }),
    );
    expect(submit.status).toBe(201);

    const list = await h.fetch(`/api/items/${slug}`);
    const rows = ((await list.json()) as { data: Record<string, unknown>[] }).data;
    expect(rows.length).toBe(1);
    expect(rows[0]!._status).toBe("draft");
  });
});
