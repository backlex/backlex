import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * i18n catalog surface — admin CRUD at `/api/admin/i18n` (routes/i18n.ts)
 * plus the public, unauthenticated read side at `/api/i18n` (routes/
 * i18n-public.ts). Pins the row/matrix shapes, the 201-vs-200 upsert split,
 * bulk upsert, delete, the admin gate (401 anon / 403 non-admin), and that
 * the public bundle serves what the admin published — without auth.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

const json = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("i18n — admin catalog + public bundle", () => {
  let h: TestHarness;
  let admin: { email: string; password: string };

  /** Cookie-free request straight into the app — proves the public side needs
   *  no session. (h.fetch would attach the admin cookie jar.) */
  const anon = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Origin")) headers.set("Origin", "http://localhost:5173");
    return h.app.fetch(
      new Request(`http://localhost:5173${path}`, { ...init, headers }),
    );
  };

  beforeAll(async () => {
    h = makeHarness();
    admin = await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("anonymous request to the admin surface is 401", async () => {
    const res = await anon("/api/admin/i18n");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  let greetingId: string;

  test("PUT / creates (201) then updates (200) the same (key, locale) row", async () => {
    const created = await h.fetch(
      "/api/admin/i18n",
      json({ key: "greeting", locale: "en", value: "Hello" }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: { id: string; key: string; locale: string; value: string };
    };
    expect(createdBody.data.id).toBeTruthy();
    expect(createdBody.data.key).toBe("greeting");
    expect(createdBody.data.locale).toBe("en");
    expect(createdBody.data.value).toBe("Hello");
    greetingId = createdBody.data.id;

    // Same (key, locale) again — must update in place, not insert a twin.
    const updated = await h.fetch(
      "/api/admin/i18n",
      json({ key: "greeting", locale: "en", value: "Hello!" }),
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { data: { id: string; value: string } };
    expect(updatedBody.data.id).toBe(greetingId);
    expect(updatedBody.data.value).toBe("Hello!");
  });

  test("GET / lists the upserted row (row form)", async () => {
    const res = await h.fetch("/api/admin/i18n");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; key: string; locale: string; value: string }>;
    };
    const row = body.data.find((r) => r.id === greetingId);
    expect(row).toBeDefined();
    expect(row?.key).toBe("greeting");
    expect(row?.locale).toBe("en");
    expect(row?.value).toBe("Hello!");
    // The duplicate PUT above must not have produced a second row for the pair.
    expect(
      body.data.filter((r) => r.key === "greeting" && r.locale === "en"),
    ).toHaveLength(1);
  });

  test("GET /_matrix pivots into key×locale with locale metadata", async () => {
    const res = await h.fetch("/api/admin/i18n/_matrix");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, Record<string, string>>;
      locales: string[];
      configuredLocales: string[];
      defaultLocale: string;
    };
    expect(body.data.greeting?.en).toBe("Hello!");
    expect(Array.isArray(body.locales)).toBe(true);
    expect(body.locales).toContain("en");
    expect(Array.isArray(body.configuredLocales)).toBe(true);
    expect(typeof body.defaultLocale).toBe("string");
    expect(body.defaultLocale.length).toBeGreaterThan(0);
  });

  test("PUT /_bulk upserts many rows in one call", async () => {
    const res = await h.fetch(
      "/api/admin/i18n/_bulk",
      json([
        { key: "farewell", locale: "en", value: "Goodbye" },
        { key: "farewell", locale: "tr", value: "Hoşça kal" },
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; upserts: number };
    expect(body.ok).toBe(true);
    expect(body.upserts).toBe(2);

    const matrix = (await (await h.fetch("/api/admin/i18n/_matrix")).json()) as {
      data: Record<string, Record<string, string>>;
    };
    expect(matrix.data.farewell?.en).toBe("Goodbye");
    expect(matrix.data.farewell?.tr).toBe("Hoşça kal");
  });

  test("POST /_auto-translate without any AI config is 503 UNAVAILABLE with a setup hint", async () => {
    // No provider credential in the harness env and no workspace AI override —
    // missing AI config is a deployment precondition, not a server fault, so
    // the route throws AppError("UNAVAILABLE", …) → 503 (same convention as
    // the AI gateway / MCP AI tools), keeping the helpful message.
    // Auto-translate is no longer Anthropic-only, so the hint names the whole
    // provider surface rather than a single vendor.
    const res = await h.fetch("/api/admin/i18n/_auto-translate", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ targetLocale: "de" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAVAILABLE");
    expect(body.error.message).toContain("Settings → AI");
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
  });

  test("public GET /api/i18n returns locale metadata without auth", async () => {
    const res = await anon("/api/i18n");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const body = (await res.json()) as {
      data: { locales: string[]; defaultLocale: string };
    };
    expect(Array.isArray(body.data.locales)).toBe(true);
    expect(typeof body.data.defaultLocale).toBe("string");
  });

  test("public GET /api/i18n/:locale serves the published strings without auth", async () => {
    const res = await anon("/api/i18n/en");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        locale: string;
        defaultLocale: string;
        available: string[];
        strings: Record<string, string>;
      };
    };
    expect(body.data.locale).toBe("en");
    expect(body.data.strings.greeting).toBe("Hello!");
    expect(body.data.strings.farewell).toBe("Goodbye");

    // A locale with only partial coverage falls back per key: `farewell` has a
    // tr row, `greeting` doesn't — it falls back to the default locale's value
    // (or the literal key), never disappears from the bundle.
    const tr = await anon("/api/i18n/tr");
    expect(tr.status).toBe(200);
    const trBody = (await tr.json()) as { data: { strings: Record<string, string> } };
    expect(trBody.data.strings.farewell).toBe("Hoşça kal");
    expect(trBody.data.strings.greeting).toBeTruthy();
  });

  test("DELETE /{id} removes the row", async () => {
    const doomed = await h.fetch(
      "/api/admin/i18n",
      json({ key: "doomed", locale: "en", value: "bye" }),
    );
    expect(doomed.status).toBe(201);
    const doomedId = ((await doomed.json()) as { data: { id: string } }).data.id;

    const del = await h.fetch(`/api/admin/i18n/${doomedId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);

    const list = (await (await h.fetch("/api/admin/i18n")).json()) as {
      data: Array<{ id: string }>;
    };
    expect(list.data.some((r) => r.id === doomedId)).toBe(false);
  });

  test("non-admin user cannot read or write the admin catalog (403)", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `i18n-viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(su.status).toBe(200);

    const write = await h.fetch(
      "/api/admin/i18n",
      json({ key: "sneaky", locale: "en", value: "nope" }),
    );
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );

    const read = await h.fetch("/api/admin/i18n");
    expect(read.status).toBe(403);

    // …but the public bundle still works for that same non-admin session.
    const pub = await h.fetch("/api/i18n/en");
    expect(pub.status).toBe(200);

    // Restore the admin session for any later suites sharing this harness.
    const back = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    expect(back.status).toBe(200);
  });
});
