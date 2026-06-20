import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { importVapidKey, signJwt } from "../src/server/lib/push-crypto";

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

describe("VAPID key import (web-push generate-vapid-keys format)", () => {
  test("imports a raw base64url keypair and produces a verifiable ES256 JWT", async () => {
    // Generate a keypair and export it the way `web-push generate-vapid-keys`
    // does: private = raw base64url `d`, public = raw base64url P-256 point.
    const kp = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const privateKey = jwk.d as string;
    const publicKey = b64url(pubRaw);

    const key = await importVapidKey(privateKey, publicKey);
    const jwt = await signJwt({}, { aud: "https://push.example", exp: 9999999999, sub: "mailto:a@b.c" }, key, "ES256");

    const [head, body, sig] = jwt.split(".");
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      b64urlToBytes(sig!),
      new TextEncoder().encode(`${head}.${body}`),
    );
    expect(ok).toBe(true);
  });
});

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("push messaging", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("register → list → unregister a device", async () => {
    const reg = await h.fetch(
      "/api/device-tokens",
      json({ platform: "fcm", token: "tok-abc", deviceName: "Pixel" }),
    );
    expect(reg.status).toBe(200);
    const { data } = (await reg.json()) as { data: { id: string } };
    expect(data.id).toBeTruthy();

    const list = await h.fetch("/api/device-tokens");
    const listed = (await list.json()) as { data: { id: string; token: string }[] };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.token).toBe("tok-abc");

    const del = await h.fetch(`/api/device-tokens/${data.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const list2 = await h.fetch("/api/device-tokens");
    expect(((await list2.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  test("re-registering the same token revives it instead of duplicating", async () => {
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "dup" }));
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "dup", deviceName: "x" }));
    const list = await h.fetch("/api/device-tokens");
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  test("web-push registration requires subscription keys", async () => {
    const res = await h.fetch(
      "/api/device-tokens",
      json({ platform: "web-push", token: "https://push.example/sub" }),
    );
    expect(res.status).toBe(422);
  });

  test("push-config test send reaches the caller's device (console adapter)", async () => {
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "tok-1" }));
    const res = await h.fetch("/api/admin/push-config/test", json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
  });

  test("push-config test send 422s with no registered devices", async () => {
    const res = await h.fetch("/api/admin/push-config/test", json({}));
    expect(res.status).toBe(422);
  });

  test("push config round-trips, secrets are never returned", async () => {
    const put = await h.fetch("/api/admin/push-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "fcm",
        config: { projectId: "p1", clientEmail: "svc@p1.iam" },
        secrets: { privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" },
      }),
    });
    expect(put.status).toBe(200);
    const get = await h.fetch("/api/admin/push-config");
    const cfg = (await get.json()) as {
      data: { provider: string; secretsSet: { privateKey: boolean }; config: Record<string, unknown> };
    };
    expect(cfg.data.provider).toBe("fcm");
    expect(cfg.data.secretsSet.privateKey).toBe(true);
    expect(cfg.data.config.projectId).toBe("p1");
    // ciphertext must never surface
    expect(JSON.stringify(cfg.data)).not.toContain("BEGIN PRIVATE KEY");
  });

  test("push template create + send-test renders to the caller's device", async () => {
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "tok-tpl" }));
    const create = await h.fetch(
      "/api/admin/push-templates",
      json({ key: "welcome", name: "Welcome", title: "Hi {{ user.email }}", body: "Welcome aboard" }),
    );
    expect(create.status).toBe(201);
    const { data } = (await create.json()) as { data: { id: string } };
    const send = await h.fetch(`/api/admin/push-templates/${data.id}/send-test`, json({}));
    expect(send.status).toBe(200);
    expect(((await send.json()) as { sent: number }).sent).toBe(1);
  });

  test("notification with push:true fans out to devices", async () => {
    await h.fetch("/api/device-tokens", json({ platform: "fcm", token: "tok-n" }));
    const res = await h.fetch(
      "/api/notifications",
      json({ title: "Ping", body: "you have mail", push: true }),
    );
    expect(res.status).toBe(201);
  });

  test("device registration requires auth", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/device-tokens", json({ platform: "fcm", token: "x" }));
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
