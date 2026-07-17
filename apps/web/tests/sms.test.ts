import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("SMS messaging", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("register → list → unregister a phone number", async () => {
    const reg = await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155552671" }));
    expect(reg.status).toBe(200);
    const { data } = (await reg.json()) as { data: { id: string } };
    expect(data.id).toBeTruthy();

    const list = await h.fetch("/api/phone-numbers");
    const listed = (await list.json()) as { data: { id: string; phoneNumber: string }[] };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.phoneNumber).toBe("+14155552671");

    const del = await h.fetch(`/api/phone-numbers/${data.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const list2 = await h.fetch("/api/phone-numbers");
    expect(((await list2.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  test("re-registering the same number revives it instead of duplicating", async () => {
    await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155550000" }));
    await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155550000" }));
    const list = await h.fetch("/api/phone-numbers");
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  test("registration rejects a non-E.164 number", async () => {
    const res = await h.fetch("/api/phone-numbers", json({ phoneNumber: "5551234" }));
    expect(res.status).toBe(422); // zod schema rejection
  });

  test("sms-config test send reaches the caller's number (console adapter)", async () => {
    await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155552671" }));
    const res = await h.fetch("/api/admin/sms-config/test", json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
  });

  test("sms-config test send to an explicit number works without a registered one", async () => {
    const res = await h.fetch("/api/admin/sms-config/test", json({ to: "+14155559999" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sent: number }).sent).toBe(1);
  });

  test("sms-config test send 422s with no registered number and no `to`", async () => {
    const res = await h.fetch("/api/admin/sms-config/test", json({}));
    expect(res.status).toBe(422);
  });

  test("sms config round-trips, secrets are never returned", async () => {
    const put = await h.fetch("/api/admin/sms-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "twilio",
        config: { accountSid: "AC123", from: "+14155550000" },
        secrets: { authToken: "super-secret-token" },
      }),
    });
    expect(put.status).toBe(200);
    const get = await h.fetch("/api/admin/sms-config");
    const cfg = (await get.json()) as {
      data: { provider: string; secretsSet: { authToken: boolean }; config: Record<string, unknown> };
    };
    expect(cfg.data.provider).toBe("twilio");
    expect(cfg.data.secretsSet.authToken).toBe(true);
    expect(cfg.data.config.accountSid).toBe("AC123");
    // ciphertext must never surface
    expect(JSON.stringify(cfg.data)).not.toContain("super-secret-token");
  });

  test("messaging.send_sms fans out to the user's registered numbers", async () => {
    const me = await h.fetch("/api/me");
    const userId = ((await me.json()) as { data: { id: string } }).data.id;
    await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155551234" }));
    const res = await h.fetch("/api/messaging/sms", json({ userId, body: "hi from backlex" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
  });

  test("phone registration requires auth", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/phone-numbers", json({ phoneNumber: "+14155552671" }));
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
