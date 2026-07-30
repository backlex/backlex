import { PAYMENT_PROVIDERS, PAYMENT_SECRET_KEYS, type PaymentProvider } from "@backlex/integrations/payments";
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import {
  fetchPaymentPage,
  normalizePaymentEvent,
  paymentRowId,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Payments integration (#18): signature verification per provider, the
 * replay guard, event normalization, collection provisioning and the
 * reconcile pull. The provider APIs are never contacted — signatures are
 * computed with the same HMAC the verifier uses (so the test proves the
 * scheme, not a recorded fixture) and reconcile runs against a stub `fetch`.
 */

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const enc = new TextEncoder();

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
};

const hmacB64 = async (keyBytes: Uint8Array, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.slice().buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
};

const STRIPE_SECRET = "whsec_test_stripe_secret";
const LS_SECRET = "ls_signing_secret";

const stripeHeaders = async (body: string, atMs: number, secret = STRIPE_SECRET) => {
  const t = Math.floor(atMs / 1000);
  return {
    "content-type": "application/json",
    "stripe-signature": `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`,
  };
};

// ── Signature verification ──────────────────────────────────────────────────

describe("payments — signature verification", () => {
  const NOW = 1_800_000_000_000;

  test("stripe accepts a correct t/v1 pair and rejects a tampered body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "customer.created" });
    const headers = await stripeHeaders(body, NOW);

    expect(
      await verifyPaymentSignature("stripe", { rawBody: body, headers, secret: STRIPE_SECRET, nowMs: NOW }),
    ).toEqual({ ok: true });

    expect(
      await verifyPaymentSignature("stripe", {
        rawBody: `${body} `,
        headers,
        secret: STRIPE_SECRET,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("stripe rejects a replayed timestamp outside the tolerance window", async () => {
    const body = JSON.stringify({ id: "evt_2", type: "customer.created" });
    const headers = await stripeHeaders(body, NOW);
    const out = await verifyPaymentSignature("stripe", {
      rawBody: body,
      headers,
      secret: STRIPE_SECRET,
      nowMs: NOW + 10 * 60 * 1000,
    });
    expect(out).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  test("stripe accepts any one of several v1 signatures (secret rotation)", async () => {
    const body = JSON.stringify({ id: "evt_3", type: "customer.created" });
    const t = Math.floor(NOW / 1000);
    const headers = {
      "stripe-signature": `t=${t},v1=${await hmacHex("old_secret", `${t}.${body}`)},v1=${await hmacHex(
        STRIPE_SECRET,
        `${t}.${body}`,
      )}`,
    };
    expect(
      await verifyPaymentSignature("stripe", { rawBody: body, headers, secret: STRIPE_SECRET, nowMs: NOW }),
    ).toEqual({ ok: true });
  });

  test("polar verifies the standard-webhooks id.timestamp.body scheme", async () => {
    const body = JSON.stringify({ type: "customer.created", data: { id: "c1" } });
    const keyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    let raw = "";
    for (const b of keyBytes) raw += String.fromCharCode(b);
    const secret = `whsec_${btoa(raw)}`;
    const id = "msg_abc";
    const t = Math.floor(NOW / 1000);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(t),
      "webhook-signature": `v1,${await hmacB64(keyBytes, `${id}.${t}.${body}`)}`,
    };
    expect(await verifyPaymentSignature("polar", { rawBody: body, headers, secret, nowMs: NOW })).toEqual({
      ok: true,
    });

    expect(
      await verifyPaymentSignature("polar", {
        rawBody: body,
        headers: { ...headers, "webhook-id": "msg_other" },
        secret,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("lemonsqueezy verifies the hex X-Signature over the raw body", async () => {
    const body = JSON.stringify({ meta: { event_name: "order_created" } });
    const headers = { "x-signature": await hmacHex(LS_SECRET, body) };
    expect(
      await verifyPaymentSignature("lemonsqueezy", { rawBody: body, headers, secret: LS_SECRET, nowMs: NOW }),
    ).toEqual({ ok: true });
    expect(
      await verifyPaymentSignature("lemonsqueezy", {
        rawBody: body,
        headers: { "x-signature": "00" },
        secret: LS_SECRET,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("a missing header or secret fails closed rather than throwing", async () => {
    expect(
      await verifyPaymentSignature("stripe", { rawBody: "{}", headers: {}, secret: STRIPE_SECRET }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(await verifyPaymentSignature("stripe", { rawBody: "{}", headers: {}, secret: "" })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(await verifyPaymentSignature("paypal", { rawBody: "{}", headers: {}, secret: "x" })).toEqual({
      ok: false,
      reason: "unknown_provider",
    });
  });
});

// ── Normalization ───────────────────────────────────────────────────────────

describe("payments — event normalization", () => {
  test("a stripe subscription event maps price, period and customer relation", () => {
    const out = normalizePaymentEvent("stripe", {
      id: "evt_sub",
      type: "customer.subscription.updated",
      livemode: true,
      data: {
        object: {
          id: "sub_123",
          customer: "cus_9",
          status: "active",
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          cancel_at_period_end: false,
          created: 1_690_000_000,
          items: {
            data: [
              { quantity: 2, price: { unit_amount: 2500, currency: "usd", nickname: "Pro", recurring: { interval: "month" } } },
            ],
          },
        },
      },
    });
    expect(out.eventId).toBe("evt_sub");
    expect(out.livemode).toBe(true);
    expect(out.records).toHaveLength(1);
    const row = out.records[0]!.row;
    expect(out.records[0]!.kind).toBe("subscription");
    expect(row.id).toBe("stripe_sub_123");
    expect(row.customer).toBe("stripe_cus_9");
    expect(row.price_amount).toBe(2500);
    expect(row.billing_interval).toBe("month");
    expect(row.quantity).toBe(2);
    expect(row.current_period_end).toBe(1_702_592_000_000);
  });

  test("a stripe invoice reads the subscription from either API shape", () => {
    const legacy = normalizePaymentEvent("stripe", {
      id: "evt_a",
      type: "invoice.paid",
      data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1", amount_paid: 900 } },
    });
    expect(legacy.records[0]!.row.subscription).toBe("stripe_sub_1");

    const modern = normalizePaymentEvent("stripe", {
      id: "evt_b",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_2",
          customer: "cus_1",
          parent: { subscription_details: { subscription: "sub_2" } },
          amount_paid: 900,
        },
      },
    });
    expect(modern.records[0]!.row.subscription).toBe("stripe_sub_2");
  });

  test("a polar order produces both an invoice and a payment row", () => {
    const out = normalizePaymentEvent(
      "polar",
      {
        type: "order.created",
        data: {
          id: "ord_1",
          customer_id: "cus_p",
          subscription_id: "sub_p",
          status: "paid",
          paid: true,
          total_amount: 4900,
          currency: "usd",
          created_at: "2026-07-01T10:00:00Z",
        },
      },
      { headerEventId: "msg_1" },
    );
    expect(out.eventId).toBe("msg_1");
    expect(out.records.map((r) => r.kind).sort()).toEqual(["invoice", "payment"]);
    const invoice = out.records.find((r) => r.kind === "invoice")!.row;
    expect(invoice.amount_paid).toBe(4900);
    expect(invoice.amount_remaining).toBe(0);
    expect(invoice.subscription).toBe("polar_sub_p");
    const payment = out.records.find((r) => r.kind === "payment")!.row;
    expect(payment.status).toBe("succeeded");
  });

  test("a lemonsqueezy order derives the customer it never sends separately", () => {
    const out = normalizePaymentEvent("lemonsqueezy", {
      meta: { event_name: "order_created", webhook_id: "wh_1" },
      data: {
        type: "orders",
        id: "77",
        attributes: {
          customer_id: 42,
          user_email: "buyer@example.com",
          user_name: "Buyer",
          currency: "USD",
          total: 1900,
          status: "paid",
          order_number: 1001,
          created_at: "2026-07-02T08:00:00Z",
        },
      },
    });
    expect(out.eventId).toBe("wh_1");
    const customer = out.records.find((r) => r.kind === "customer")!.row;
    expect(customer.id).toBe(paymentRowId("lemonsqueezy", "42"));
    expect(customer.email).toBe("buyer@example.com");
    const invoice = out.records.find((r) => r.kind === "invoice")!.row;
    expect(invoice.customer).toBe("lemonsqueezy_42");
    expect(invoice.number).toBe("1001");
  });

  test("an unrecognised event type yields no rows but still carries its id", () => {
    const out = normalizePaymentEvent("stripe", {
      id: "evt_x",
      type: "radar.early_fraud_warning.created",
      data: { object: { id: "issfr_1" } },
    });
    expect(out.eventId).toBe("evt_x");
    expect(out.records).toEqual([]);
  });
});

// ── End-to-end over the HTTP surface ────────────────────────────────────────

describe("payments — connect, receive, reconcile", () => {
  let h: TestHarness;
  let providerId = "";
  let webhookPath = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/payments/providers",
      json({ provider: "stripe", config: { apiKey: "sk_test_x", webhookSecret: STRIPE_SECRET } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; webhookPath: string; config: Record<string, string> };
      collections: { created: string[] };
    };
    providerId = body.data.id;
    webhookPath = body.data.webhookPath;
    expect(body.collections.created.sort()).toEqual([
      "payment_customers",
      "payment_invoices",
      "payment_subscriptions",
      "payment_transactions",
    ]);
    expect(body.collections.conflicts).toEqual([]);
  });
  afterAll(() => h.cleanup());

  test("the API key is masked on read and never echoed in full", async () => {
    const res = await h.fetch("/api/admin/payments/providers");
    const body = (await res.json()) as { data: { config: Record<string, string> }[] };
    const cfg = body.data[0]!.config;
    // A fixed sentinel, not a head/tail mask: the stored value is ciphertext,
    // so masking it would only reveal the encryption envelope.
    expect(cfg.apiKey).toBe("••••••••");
    expect(cfg.webhookSecret).toBe("••••••••");
    expect(JSON.stringify(body)).not.toContain("sk_test_x");
    expect(JSON.stringify(body)).not.toContain("stripe_secret");
  });

  test("reconnecting with masked values keeps the stored secret intact", async () => {
    const before = await h.fetch("/api/admin/payments/providers");
    const masked = ((await before.json()) as { data: { config: Record<string, string> }[] }).data[0]!.config;
    // The admin UI reads config back masked; re-submitting that form must not
    // overwrite the real key with its own mask.
    await h.fetch("/api/admin/payments/providers", json({ provider: "stripe", config: masked }));

    const body = JSON.stringify({ id: "evt_keep", type: "customer.created", data: { object: { id: "cus_keep" } } });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    expect(res.status).toBe(200);
  });

  test("a signed delivery lands rows in the payment collections", async () => {
    const body = JSON.stringify({
      id: "evt_cust_1",
      type: "customer.created",
      data: { object: { id: "cus_1", email: "a@example.com", name: "Ada", created: 1_700_000_000 } },
    });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "processed", written: 1 });

    const rows = await (await h.fetch("/api/items/payment_customers")).json();
    expect((rows as { data: Record<string, unknown>[] }).data).toHaveLength(2); // + cus_keep
    const ada = (rows as { data: Record<string, unknown>[] }).data.find((r) => r.id === "stripe_cus_1");
    expect(ada).toMatchObject({ email: "a@example.com", name: "Ada", provider: "stripe" });
  });

  test("a replayed delivery is acknowledged but not re-applied", async () => {
    const body = JSON.stringify({
      id: "evt_cust_1",
      type: "customer.updated",
      data: { object: { id: "cus_1", email: "changed@example.com" } },
    });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "duplicate", written: 0 });

    const rows = (await (await h.fetch("/api/items/payment_customers")).json()) as {
      data: Record<string, unknown>[];
    };
    expect(rows.data.find((r) => r.id === "stripe_cus_1")?.email).toBe("a@example.com");
  });

  test("a later event for the same object upserts it in place", async () => {
    const body = JSON.stringify({
      id: "evt_cust_2",
      type: "customer.updated",
      data: { object: { id: "cus_1", email: "ada@example.com", name: "Ada L" } },
    });
    await h.fetch(webhookPath, { method: "POST", headers: await stripeHeaders(body, Date.now()), body });

    const rows = (await (await h.fetch("/api/items/payment_customers")).json()) as {
      data: Record<string, unknown>[];
    };
    const ada = rows.data.filter((r) => r.id === "stripe_cus_1");
    expect(ada).toHaveLength(1);
    expect(ada[0]!.email).toBe("ada@example.com");
  });

  test("a bad signature is rejected and writes nothing", async () => {
    const body = JSON.stringify({
      id: "evt_forged",
      type: "customer.created",
      data: { object: { id: "cus_forged" } },
    });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body,
    });
    expect(res.status).toBe(400);

    const rows = (await (await h.fetch("/api/items/payment_customers")).json()) as {
      data: Record<string, unknown>[];
    };
    expect(rows.data.some((r) => r.id === "stripe_cus_forged")).toBe(false);
  });

  test("an unknown token is a 404, not a signature error", async () => {
    const res = await h.fetch("/api/payments/webhook/pwh_nope", json({}));
    expect(res.status).toBe(404);
  });

  test("an unhandled event type is recorded and acknowledged", async () => {
    const body = JSON.stringify({
      id: "evt_ignored",
      type: "radar.early_fraud_warning.created",
      data: { object: { id: "issfr_1" } },
    });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    expect(await res.json()).toMatchObject({ status: "ignored", written: 0 });

    const events = (await (await h.fetch("/api/admin/payments/events")).json()) as {
      data: { externalId: string; status: string }[];
    };
    expect(events.data.find((e) => e.externalId === "evt_ignored")?.status).toBe("skipped");
    expect(events.data.find((e) => e.externalId === "evt_cust_1")?.status).toBe("processed");
  });

  test("rotating the token invalidates the old receive URL", async () => {
    const res = await h.fetch(`/api/admin/payments/providers/${providerId}/rotate-token`, { method: "POST" });
    const rotated = (await res.json()) as { data: { webhookPath: string } };
    expect(rotated.data.webhookPath).not.toBe(webhookPath);

    const body = JSON.stringify({ id: "evt_old_url", type: "customer.created", data: { object: { id: "cus_2" } } });
    const stale = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    expect(stale.status).toBe(404);
    webhookPath = rotated.data.webhookPath;
  });

  test("the catalog advertises every provider and marks its secret fields", async () => {
    const body = (await (await h.fetch("/api/admin/payments/catalog")).json()) as {
      providers: { provider: string; fields: { key: string; secret?: boolean }[] }[];
      recordKinds: string[];
    };
    // Derived from the source list, not a literal: a hardcoded array here just
    // breaks whenever a provider is added, which teaches nothing.
    expect(body.providers.map((p) => p.provider).sort()).toEqual([...PAYMENT_PROVIDERS].sort());
    for (const p of body.providers) {
      // Every provider must declare at least one secret field, and every key
      // named in PAYMENT_SECRET_KEYS must actually exist in its field list —
      // a secret key naming a field nobody collects is never encrypted.
      const secretFields = p.fields.filter((f) => f.secret).map((f) => f.key);
      expect(secretFields.length).toBeGreaterThan(0);
      expect(secretFields.sort()).toEqual(
        [...PAYMENT_SECRET_KEYS[p.provider as PaymentProvider]].sort(),
      );
    }
    expect(body.recordKinds).toEqual(["customer", "subscription", "invoice", "payment"]);
  });

  test("disconnect removes the connection but keeps the synced rows", async () => {
    const del = await h.fetch(`/api/admin/payments/providers/${providerId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const list = (await (await h.fetch("/api/admin/payments/providers")).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(0);

    const rows = (await (await h.fetch("/api/items/payment_customers")).json()) as { data: unknown[] };
    expect(rows.data.length).toBeGreaterThan(0);
  });
});

describe("payments — slug conflicts", () => {
  let h: TestHarness;
  let webhookPath = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // A workspace that already owns an unrelated `payment_transactions` table —
    // exactly what the ecommerce / invoicing / clinic templates produce for
    // slugs in this space. Nothing of ours may be written into it.
    const made = await h.fetch(
      "/api/collections",
      json({
        slug: "payment_transactions",
        fields: [
          { name: "note", type: "text" },
          { name: "cents", type: "integer" },
        ],
      }),
    );
    expect(made.status).toBeLessThan(300);

    const res = await h.fetch(
      "/api/admin/payments/providers",
      json({ provider: "stripe", config: { apiKey: "sk_x", webhookSecret: STRIPE_SECRET } }),
    );
    const body = (await res.json()) as {
      data: { webhookPath: string };
      collections: { created: string[]; conflicts: string[] };
    };
    webhookPath = body.data.webhookPath;
    // Reported, not silently skipped.
    expect(body.collections.conflicts).toEqual(["payment_transactions"]);
    expect(body.collections.created.sort()).toEqual([
      "payment_customers",
      "payment_invoices",
      "payment_subscriptions",
    ]);
  });
  afterAll(() => h.cleanup());

  test("an event targeting the conflicting slug fails loudly instead of vanishing", async () => {
    const body = JSON.stringify({
      id: "evt_conflict",
      type: "charge.succeeded",
      data: { object: { id: "ch_1", customer: "cus_1", amount: 500, currency: "usd", created: 1 } },
    });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    // 5xx so the provider retries once an admin has renamed the collection.
    expect(res.status).toBeGreaterThanOrEqual(500);

    const events = (await (await h.fetch("/api/admin/payments/events")).json()) as {
      data: { status: string; error: string | null }[];
    };
    const failed = events.data.find((e) => e.status === "failed");
    expect(failed?.error).toContain("payment_transactions");

    // The unrelated collection is untouched.
    const rows = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: unknown[];
    };
    expect(rows.data).toEqual([]);
  });

  test("events for the non-conflicting kinds still land", async () => {
    const body = JSON.stringify({
      id: "evt_ok",
      type: "customer.created",
      data: { object: { id: "cus_ok", email: "ok@example.com" } },
    });
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: await stripeHeaders(body, Date.now()),
      body,
    });
    expect(res.status).toBe(200);
    const rows = (await (await h.fetch("/api/items/payment_customers")).json()) as {
      data: { id: string }[];
    };
    expect(rows.data.some((r) => r.id === "stripe_cus_ok")).toBe(true);
  });
});

describe("payments — reconcile", () => {
  let h: TestHarness;
  let providerId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/payments/providers",
      json({ provider: "stripe", config: { apiKey: "sk_test_recon", webhookSecret: STRIPE_SECRET } }),
    );
    providerId = ((await res.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("fetchPaymentPage walks stripe's starting_after cursor", async () => {
    const seen: string[] = [];
    const stub = async (url: string): Promise<Response> => {
      seen.push(url);
      const page1 = { data: [{ id: "cus_a", email: "a@x.com" }, { id: "cus_b" }], has_more: true };
      const page2 = { data: [{ id: "cus_c" }], has_more: false };
      const body = url.includes("starting_after=cus_b") ? page2 : page1;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };

    const first = await fetchPaymentPage({
      provider: "stripe",
      config: { apiKey: "sk" },
      kind: "customer",
      fetchImpl: stub,
    });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBe("cus_b");

    const second = await fetchPaymentPage({
      provider: "stripe",
      config: { apiKey: "sk" },
      kind: "customer",
      cursor: first.nextCursor,
      fetchImpl: stub,
    });
    expect(second.records).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(seen[1]).toContain("starting_after=cus_b");
  });

  test("a provider error surfaces instead of being reported as a clean sync", async () => {
    const out = await fetchPaymentPage({
      provider: "stripe",
      config: { apiKey: "sk" },
      kind: "customer",
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    expect(out.error).toBe("stripe 401");
    expect(out.records).toEqual([]);
  });

  test("a missing API key never reaches the network", async () => {
    let called = false;
    const out = await fetchPaymentPage({
      provider: "stripe",
      config: {},
      kind: "customer",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(out.error).toBe("missing_api_key");
    expect(called).toBe(false);
  });

  test("POST /sync?async queues a durable job rather than blocking", async () => {
    const res = await h.fetch(`/api/admin/payments/providers/${providerId}/sync`, json({ async: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean; jobId: string };
    expect(body.queued).toBe(true);

    const jobs = (await (await h.fetch("/api/jobs")).json()) as {
      jobs: { id: string; type: string; status: string }[];
    };
    const queued = jobs.jobs.find((j) => j.id === body.jobId);
    expect(queued?.type).toBe("payments.reconcile");
  });

  test("re-provisioning the collections is a no-op", async () => {
    const res = await h.fetch("/api/admin/payments/collections", { method: "POST" });
    const body = (await res.json()) as { created: string[]; existing: string[] };
    expect(body.created).toEqual([]);
    expect(body.existing).toHaveLength(4);
  });
});
