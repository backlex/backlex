/**
 * Managed outbound webhooks — replay-safe signatures + the auto-disable circuit
 * breaker. Drives delivery through `deliverWebhookById` (the queue runtime) with
 * a stubbed global fetch so outcomes are deterministic, and reads hook state
 * back through the admin HTTP surface.
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { like } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { deliverWebhookById } from "../src/server/services/webhooks";
import { verifyWebhook } from "../../../packages/client/src/webhook";
import * as sqlite from "@backlex/db/sqlite";

const json = { "content-type": "application/json" };
const realFetch = globalThis.fetch;

/** Swap the global fetch for a deterministic stub. `capture` sees each
 *  outbound (url, init) so a test can inspect the signed headers. */
const stubFetch = (
  status: number,
  capture?: (url: unknown, init: { headers?: Record<string, string>; body?: string }) => void,
): void => {
  globalThis.fetch = (async (url: unknown, init: any) => {
    capture?.(url, init ?? {});
    return new Response("ok", { status });
  }) as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

const createHook = async (
  h: TestHarness,
  body: Record<string, unknown>,
): Promise<string> => {
  const res = await h.fetch("/api/webhooks", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
};

const getHook = async (
  h: TestHarness,
  id: string,
): Promise<{ active: boolean; consecutiveFailures?: number; disabledReason?: string | null } | undefined> => {
  const res = await h.fetch("/api/webhooks");
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as { data: any[] }).data;
  return rows.find((r) => r.id === id);
};

describe("replay-safe webhook signatures", () => {
  let h: TestHarness;
  const secret = "whsec_managed_test_secret";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("delivery carries timestamp + v1 + v2 signatures, all verifiable", async () => {
    const id = await createHook(h, {
      name: "sig hook",
      url: "https://example.test/hook",
      events: ["items.posts.created"],
      secret,
    });

    let captured: { headers?: Record<string, string>; body?: string } = {};
    stubFetch(200, (_url, init) => {
      captured = init;
    });

    const ctx = await buildContext(h.env);
    const body = JSON.stringify({ channel: "items", event: "created", data: { id: "x" } });
    await deliverWebhookById(ctx, {
      webhookId: id,
      channel: "items",
      event: "created",
      body,
    });

    const headers = captured.headers ?? {};
    const ts = headers["x-backlex-timestamp"];
    const v1 = headers["x-backlex-signature"];
    const v2 = headers["x-backlex-signature-v2"];
    expect(ts).toBeTruthy();
    expect(v1).toBeTruthy();
    expect(v2).toBeTruthy();
    expect(v1).not.toBe(v2); // different signed content

    // V2 (replay-safe) verifies with the timestamp; tampering fails.
    expect(await verifyWebhook({ secret, body, signature: v2!, timestamp: ts })).toBe(true);
    expect(await verifyWebhook({ secret, body: `${body} `, signature: v2!, timestamp: ts })).toBe(false);
    expect(await verifyWebhook({ secret: "wrong", body, signature: v2!, timestamp: ts })).toBe(false);

    // Legacy V1 verifies over the bare body (no timestamp).
    expect(await verifyWebhook({ secret, body, signature: v1! })).toBe(true);

    // Stale timestamp is rejected once outside the tolerance window.
    const stale = String(Math.floor(Date.now() / 1000) - 10_000);
    const staleSig = await (async () => {
      // re-sign for the stale ts so only the freshness check can fail it
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${stale}.${body}`));
      return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
    })();
    expect(await verifyWebhook({ secret, body, signature: staleSig, timestamp: stale })).toBe(false);
    expect(
      await verifyWebhook({ secret, body, signature: staleSig, timestamp: stale, toleranceSec: 0 }),
    ).toBe(true); // tolerance 0 disables the freshness check
  });
});

describe("webhook circuit breaker", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("auto-disables after the failure threshold + notifies, manual resume resets", async () => {
    const id = await createHook(h, {
      name: "flaky hook",
      url: "https://down.test/hook",
      events: ["items.posts.created"],
      secret: "whsec_x",
    });

    stubFetch(500);
    const ctx = await buildContext(h.env);
    const body = JSON.stringify({ channel: "items", event: "created" });
    // The threshold is 15; drive enough failing deliveries to cross it.
    for (let i = 0; i < 15; i++) {
      await deliverWebhookById(ctx, { webhookId: id, channel: "items", event: "created", body });
    }
    globalThis.fetch = realFetch;

    const hook = await getHook(h, id);
    expect(hook?.active).toBe(false);
    expect(hook?.consecutiveFailures).toBeGreaterThanOrEqual(15);
    expect(hook?.disabledReason).toBeTruthy();

    // A broadcast notification was written for the auto-disable.
    const notifs = (await (ctx.db as any)
      .select()
      .from(sqlite.schema.notifications)
      .where(like(sqlite.schema.notifications.title, "%auto-disabled%"))) as any[];
    expect(notifs.length).toBeGreaterThanOrEqual(1);

    // While disabled, further deliveries are a terminal no-op (don't re-fail).
    stubFetch(500);
    const out = await deliverWebhookById(ctx, { webhookId: id, channel: "items", event: "created", body });
    expect(out.status).toBe(200);
    globalThis.fetch = realFetch;

    // Manual resume clears the breaker.
    const patch = await h.fetch(`/api/webhooks/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ active: true }),
    });
    expect(patch.status).toBe(200);
    const resumed = await getHook(h, id);
    expect(resumed?.active).toBe(true);
    expect(resumed?.consecutiveFailures).toBe(0);
    expect(resumed?.disabledReason).toBeFalsy();
  });

  test("a success resets the failure counter before the threshold", async () => {
    const id = await createHook(h, {
      name: "recovering hook",
      url: "https://flap.test/hook",
      events: ["items.posts.created"],
      secret: "whsec_y",
    });
    const ctx = await buildContext(h.env);
    const body = JSON.stringify({ channel: "items", event: "created" });

    stubFetch(503);
    for (let i = 0; i < 3; i++) {
      await deliverWebhookById(ctx, { webhookId: id, channel: "items", event: "created", body });
    }
    globalThis.fetch = realFetch;
    let hook = await getHook(h, id);
    expect(hook?.active).toBe(true);
    expect(hook?.consecutiveFailures).toBe(3);

    stubFetch(200);
    await deliverWebhookById(ctx, { webhookId: id, channel: "items", event: "created", body });
    globalThis.fetch = realFetch;
    hook = await getHook(h, id);
    expect(hook?.consecutiveFailures).toBe(0);
  });
});
