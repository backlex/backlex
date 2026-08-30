/**
 * Workspace email config REST surface — `/api/admin/email-config`.
 *
 * The PUT path is exercised elsewhere; this suite pins the GET default +
 * round-trip behavior (including secret redaction), the POST /test endpoint
 * through both the default console transport and a broken SMTP transport,
 * and admin-only enforcement.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

interface EmailConfigData {
  tenantId: string;
  provider: string;
  fromAddress: string | null;
  config: Record<string, unknown>;
  secretsSet: { apiKey: boolean; secretAccessKey: boolean; pass: boolean };
  updatedAt: unknown;
  env: { provider: string | null; from: string | null };
  providerIds: string[];
}

const getConfig = async (h: TestHarness): Promise<{ raw: string; data: EmailConfigData }> => {
  const res = await h.fetch("/api/admin/email-config");
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, data: (JSON.parse(raw) as { data: EmailConfigData }).data };
};

describe("/api/admin/email-config", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("GET / returns env-backed defaults when nothing is stored", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const { data } = await getConfig(h);
    expect(typeof data.tenantId).toBe("string");
    expect(data.provider).toBe("inherit");
    expect(data.fromAddress).toBeNull();
    expect(data.config).toEqual({});
    expect(data.secretsSet).toEqual({
      apiKey: false,
      secretAccessKey: false,
      pass: false,
    });
    expect(data.updatedAt).toBeNull();
    // Test env sets no EMAIL_* vars, so the deployment fallback is empty.
    expect(data.env).toEqual({ provider: null, from: null });
    expect(data.providerIds).toEqual([
      "inherit",
      "console",
      "resend",
      "sendgrid",
      "mailgun",
      "ses",
      "smtp",
    ]);
  });

  test("PUT → GET round-trips config and never returns the secret", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const secret = "re_live_supersecret_apikey_12345";
    const saved = await h.fetch(
      "/api/admin/email-config",
      json("PUT", {
        provider: "resend",
        fromAddress: "noreply@acme.test",
        config: { note: "primary" },
        secrets: { apiKey: secret },
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });

    const { raw, data } = await getConfig(h);
    expect(data.provider).toBe("resend");
    expect(data.fromAddress).toBe("noreply@acme.test");
    expect(data.config).toEqual({ note: "primary" });
    // Secrets are redacted to a per-key boolean — the plaintext (and the
    // ciphertext) must never appear anywhere in the response.
    expect(data.secretsSet.apiKey).toBe(true);
    expect(data.secretsSet.pass).toBe(false);
    expect((data as unknown as Record<string, unknown>).secrets).toBeUndefined();
    expect(raw).not.toContain(secret);
    expect(data.updatedAt).not.toBeNull();
  });

  test("clearing a secret with '' flips its secretsSet flag back off", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/admin/email-config",
      json("PUT", {
        provider: "resend",
        fromAddress: "noreply@acme.test",
        secrets: { apiKey: "re_something" },
      }),
    );
    await h.fetch(
      "/api/admin/email-config",
      json("PUT", { provider: "resend", secrets: { apiKey: "" } }),
    );
    const { data } = await getConfig(h);
    expect(data.secretsSet.apiKey).toBe(false);
    // fromAddress was omitted in the second PUT — it must survive.
    expect(data.fromAddress).toBe("noreply@acme.test");
  });

  test("PUT rejects an unknown provider", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/email-config",
      json("PUT", { provider: "carrier-pigeon" }),
    );
    expect(res.status).toBe(422);
  });

  test("POST /test sends through the default console transport", async () => {
    // No SMTP / provider configured → the deployment falls back to the console
    // adapter, so the test send succeeds (prints to stdout) rather than erroring.
    h = makeHarness();
    const admin = await seedAdmin(h);
    const res = await h.fetch("/api/admin/email-config/test", { method: "POST" });
    expect(res.status).toBe(200);
    // Recipient defaults to the caller's email.
    expect(await res.json()).toEqual({ ok: true, to: admin.email });

    const explicit = await h.fetch(
      "/api/admin/email-config/test",
      json("POST", { to: "probe@example.test" }),
    );
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toEqual({ ok: true, to: "probe@example.test" });
  });

  test("POST /test through a broken SMTP transport fails as clean JSON, not a crash", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/admin/email-config",
      json("PUT", {
        provider: "smtp",
        fromAddress: "noreply@example.test",
        config: { host: "127.0.0.1", port: 59998, secure: false },
      }),
    );
    const res = await h.fetch("/api/admin/email-config/test", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("INTERNAL");
    // The raw connection error must not leak to the client.
    expect(body.error.message).toBe("Internal server error");
  });

  test("admin-only: 401 without a session, 403 for a non-admin user", async () => {
    h = makeHarness();
    const anon = await h.fetch("/api/admin/email-config");
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

    const read = await h.fetch("/api/admin/email-config");
    expect(read.status).toBe(403);
    const write = await h.fetch(
      "/api/admin/email-config",
      json("PUT", { provider: "console" }),
    );
    expect(write.status).toBe(403);
    const testSend = await h.fetch("/api/admin/email-config/test", {
      method: "POST",
    });
    expect(testSend.status).toBe(403);
    const body = (await testSend.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
