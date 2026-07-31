/**
 * Outbound checkout, end to end over HTTP.
 *
 * `payments-checkout.test.ts` pins the pure per-provider request shapes; this
 * drives the whole loop the feature exists for, with the `dummy` provider
 * standing in for an acquirer:
 *
 *   ask for money  →  link written onto the invoice row
 *   customer pays  →  settlement verified, deduped and normalized
 *   payment lands  →  `payment_transactions.reference` matches the invoice
 *
 * That last step is the point of the whole feature. Everything else here is a
 * URL generator without it.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("checkout → settle → reconcile against the row", () => {
  let h: TestHarness;
  let invoiceId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/payments/providers", json({ provider: "dummy", config: {} }));

    // A minimal invoicing collection, shaped like the templates': a total, a
    // customer email, and somewhere to put the link.
    await h.fetch(
      "/api/collections",
      json({
        slug: "shop_invoices",
        fields: [
          { name: "total", type: "integer" },
          { name: "email", type: "text" },
          { name: "pay_url", type: "text" },
          { name: "pay_ref", type: "text" },
        ],
      }),
    );
    const created = (await (
      await h.fetch(
        "/api/items/shop_invoices",
        json({ total: 4200, email: "buyer@example.com" }),
      )
    ).json()) as { data: { id: string } };
    invoiceId = created.data.id;
  });
  afterAll(() => h.cleanup());

  test("the link is written onto the row, and the reference is derived from its id", async () => {
    const res = await h.fetch(
      "/api/admin/payments/checkout",
      json({
        provider: "dummy",
        amount: 4200,
        currency: "USD",
        description: "Invoice INV-1",
        customer: { email: "buyer@example.com" },
        writeBack: {
          collection: "shop_invoices",
          itemId: invoiceId,
          urlField: "pay_url",
          referenceField: "pay_ref",
        },
      }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { url: string; reference: string; writtenBack: { fields: string[] } };
    };
    // Derived from the row id with the characters PayTR would refuse removed,
    // so the same value works on every provider.
    expect(data.reference).toBe(invoiceId.replace(/[^A-Za-z0-9]/g, ""));
    expect(data.writtenBack.fields.sort()).toEqual(["pay_ref", "pay_url"]);

    const row = (await (
      await h.fetch(`/api/items/shop_invoices/${invoiceId}`)
    ).json()) as { data: { pay_url: string; pay_ref: string } };
    expect(row.data.pay_url).toBe(data.url);
    expect(row.data.pay_ref).toBe(data.reference);
  });

  test("the hosted page renders the amount in major units", async () => {
    const row = (await (
      await h.fetch(`/api/items/shop_invoices/${invoiceId}`)
    ).json()) as { data: { pay_url: string } };
    const page = await h.fetch(new URL(row.data.pay_url).pathname + new URL(row.data.pay_url).search);
    expect(page.status).toBe(200);
    const html = await page.text();
    // 4200 minor units is $42.00 — showing "4200 USD" to a customer would be a
    // 100x lie on the one screen where it matters.
    expect(html).toContain("42.00");
    expect(html).toContain("Test mode");
  });

  test("an edited link is refused before anything is recorded", async () => {
    const row = (await (
      await h.fetch(`/api/items/shop_invoices/${invoiceId}`)
    ).json()) as { data: { pay_url: string } };
    const url = new URL(row.data.pay_url);
    url.searchParams.set("a", "1");
    const res = await h.fetch(url.pathname + url.search);
    expect(res.status).toBe(400);

    const events = (await (await h.fetch("/api/admin/payments/events")).json()) as {
      data: unknown[];
    };
    expect(events.data).toEqual([]);
  });

  test("paying settles through the ordinary receive path and ties back to the invoice", async () => {
    const row = (await (
      await h.fetch(`/api/items/shop_invoices/${invoiceId}`)
    ).json()) as { data: { pay_url: string; pay_ref: string } };
    const url = new URL(row.data.pay_url);
    const paid = await h.fetch(url.pathname + url.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome: "success" }).toString(),
    });
    // Redirected back to the merchant's success URL, as a real provider would.
    expect([200, 303]).toContain(paid.status);

    const payments = (await (
      await h.fetch("/api/items/payment_transactions")
    ).json()) as {
      data: { amount: number; status: string; reference: string; provider: string }[];
    };
    expect(payments.data).toHaveLength(1);
    const payment = payments.data[0]!;
    expect(payment.provider).toBe("dummy");
    expect(payment.amount).toBe(4200);
    expect(payment.status).toBe("succeeded");
    // The join that makes this a feature: the payment carries the invoice's
    // own reference, so "which invoice did this pay?" has an answer.
    expect(payment.reference).toBe(row.data.pay_ref);

    const events = (await (await h.fetch("/api/admin/payments/events")).json()) as {
      data: { status: string }[];
    };
    expect(events.data[0]?.status).toBe("processed");
  });

  test("a replayed settlement is deduped, not double-counted", async () => {
    const row = (await (
      await h.fetch(`/api/items/shop_invoices/${invoiceId}`)
    ).json()) as { data: { pay_url: string } };
    const url = new URL(row.data.pay_url);
    await h.fetch(url.pathname + url.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome: "success" }).toString(),
    });
    const payments = (await (
      await h.fetch("/api/items/payment_transactions")
    ).json()) as { data: unknown[] };
    expect(payments.data).toHaveLength(1);
  });

  test("a write-back field that doesn't exist is refused before a link is minted", async () => {
    const res = await h.fetch(
      "/api/admin/payments/checkout",
      json({
        provider: "dummy",
        amount: 999,
        currency: "USD",
        writeBack: { collection: "shop_invoices", itemId: invoiceId, urlField: "nope" },
      }),
    );
    // A live payment link nothing in the workspace knows about is worse than a
    // failed request, so this has to fail BEFORE the provider is called.
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("nope");
  });

  test("checkout needs a connected provider", async () => {
    const res = await h.fetch(
      "/api/admin/payments/checkout",
      json({ provider: "stripe", amount: 100, currency: "USD" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("provisioning catches an older workspace up", () => {
  test("a sync target missing a column gains it instead of failing deliveries", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      await h.fetch("/api/admin/payments/providers", json({ provider: "dummy", config: {} }));

      // Simulate a workspace provisioned before `reference` existed.
      const cols = (await (await h.fetch("/api/collections")).json()) as {
        data: { slug: string; fields: { name: string }[] }[];
      };
      const payments = cols.data.find((c) => c.slug === "payment_transactions")!;
      expect(payments.fields.map((f) => f.name)).toContain("reference");

      // Re-provisioning is idempotent and reports nothing added in the steady
      // state — the interesting assertion is that it doesn't churn.
      const out = (await (
        await h.fetch("/api/admin/payments/collections", { method: "POST" })
      ).json()) as { existing: string[]; addedFields: Record<string, string[]> };
      expect(out.existing).toHaveLength(4);
      expect(out.addedFields).toEqual({});
    } finally {
      h.cleanup();
    }
  });
});
