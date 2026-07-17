/**
 * Workspace integrations REST surface — `/api/admin/integrations`.
 *
 * The adapters + service helpers are covered in integrations.test.ts /
 * integrations-service.test.ts; this suite pins the HTTP route behavior:
 * catalog, connect/list/disconnect lifecycle, secret masking on read, the
 * one-row-per-(workspace, kind) upsert semantics, and admin-only enforcement.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { INTEGRATION_KINDS } from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

interface IntegrationView {
  id: string;
  kind: string;
  events: string[] | null;
  status: string;
  config: Record<string, unknown>;
  lastEventAt: number | null;
  createdAt: number | null;
}

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/supersecretpart";

const connectSlack = async (
  h: TestHarness,
  events: string[] | null = null,
): Promise<IntegrationView> => {
  const res = await h.fetch(
    "/api/admin/integrations",
    json("POST", { kind: "slack", config: { webhookUrl: WEBHOOK_URL }, events }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: IntegrationView }).data;
};

const listIntegrations = async (
  h: TestHarness,
): Promise<{ raw: string; rows: IntegrationView[] }> => {
  const res = await h.fetch("/api/admin/integrations");
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, rows: (JSON.parse(raw) as { data: IntegrationView[] }).data };
};

describe("/api/admin/integrations", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("GET /catalog returns all kinds + their field schemas", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/integrations/catalog");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { kinds: string[]; fields: Record<string, unknown[]> };
    };
    expect(data.kinds).toEqual([...INTEGRATION_KINDS]);
    expect(data.kinds).toContain("slack");
    for (const kind of data.kinds) {
      expect(Array.isArray(data.fields[kind])).toBe(true);
      expect((data.fields[kind] ?? []).length).toBeGreaterThan(0);
    }
    // Field entries carry the shape the connect UI renders from.
    const slackField = (data.fields.slack ?? [])[0] as {
      key: string;
      secret?: boolean;
    };
    expect(slackField.key).toBe("webhookUrl");
    expect(slackField.secret).toBe(true);
  });

  test("POST connects an integration and masks the secret in the response", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await connectSlack(h, ["posts.*"]);
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe("slack");
    expect(created.status).toBe("connected");
    expect(created.events).toEqual(["posts.*"]);
    // Secret field comes back masked, never in the clear.
    const masked = created.config.webhookUrl as string;
    expect(masked).not.toBe(WEBHOOK_URL);
    expect(masked).toContain("…");
    expect(masked).not.toContain("supersecret");
  });

  test("GET / lists the connection (still masked); DELETE removes it", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await connectSlack(h);

    const { raw, rows } = await listIntegrations(h);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(created.id);
    expect(row.kind).toBe("slack");
    expect(row.status).toBe("connected");
    expect(row.events).toBeNull();
    expect(row.lastEventAt).toBeNull();
    expect(row.createdAt).not.toBeNull();
    // The full webhook URL must not appear anywhere in the list payload.
    expect(raw).not.toContain(WEBHOOK_URL);

    const del = await h.fetch(`/api/admin/integrations/${created.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    const after = await listIntegrations(h);
    expect(after.rows).toHaveLength(0);
  });

  test("connecting the same kind twice upserts the one row", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const first = await connectSlack(h, null);
    const second = await connectSlack(h, ["orders.created"]);
    expect(second.id).toBe(first.id); // same row, updated in place
    const { rows } = await listIntegrations(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.events).toEqual(["orders.created"]);
  });

  test("POST rejects an unknown kind", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/integrations",
      json("POST", { kind: "mailchimp", config: {} }),
    );
    expect(res.status).toBe(400);
  });

  test("admin-only: 401 without a session, 403 for a non-admin user", async () => {
    h = makeHarness();
    const anon = await h.fetch("/api/admin/integrations");
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

    const catalog = await h.fetch("/api/admin/integrations/catalog");
    expect(catalog.status).toBe(403);
    const list = await h.fetch("/api/admin/integrations");
    expect(list.status).toBe(403);
    const create = await h.fetch(
      "/api/admin/integrations",
      json("POST", { kind: "slack", config: { webhookUrl: WEBHOOK_URL } }),
    );
    expect(create.status).toBe(403);
    const body = (await create.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
