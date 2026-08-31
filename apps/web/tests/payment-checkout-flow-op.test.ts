/**
 * The `payment.checkout` flow operation.
 *
 * This is what turns outbound payments from an API call into automation: an
 * invoice row lands, and the flow mints a payment link and writes it onto that
 * same row. Fifteen of the schema templates model money arriving, so "row
 * created → ask for payment" is the shape they all want.
 *
 * The failure modes that matter are all render-time, because almost every
 * field is a template over the triggering row: an amount that renders to
 * something that isn't a positive integer, and a write-back target that
 * renders empty. Both have to fail the run rather than mint a live payment
 * link that nothing records.
 *
 * Runs go through the HTTP invoke endpoint so interpolation, tenant scoping
 * and the error surface are exercised together, with the `dummy` provider
 * standing in for an acquirer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import type { FlowRunResult } from "../../../packages/client/src/index";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("payment.checkout flow op", () => {
  let h: TestHarness;
  let invoiceId = "";

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/payments/providers", json({ provider: "dummy", config: {} }));
    await h.fetch(
      "/api/collections",
      json({
        slug: "bills",
        fields: [
          { name: "amount_due", type: "integer" },
          { name: "email", type: "text" },
          { name: "pay_url", type: "text" },
        ],
      }),
    );
    const created = (await (
      await h.fetch("/api/items/bills", json({ amount_due: 7500, email: "a@b.test" }))
    ).json()) as { data: { id: string } };
    invoiceId = created.data.id;
  });
  afterEach(() => h.cleanup());

  const run = async (op: Record<string, unknown>, input: Record<string, unknown> = {}) => {
    const created = await h.fetch(
      "/api/flows",
      json({
        name: `pay-${Math.random().toString(36).slice(2)}`,
        trigger: "manual:",
        operations: [op],
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${data.id}/run`, json(input));
    return (await res.json()) as { ok: boolean; error?: string; results?: unknown[] };
  };

  test("mints a link off the triggering row and writes it back", async () => {
    const out = await run(
      {
        type: "payment.checkout",
        provider: "dummy",
        amount: "{{ data.amount_due }}",
        currency: "USD",
        email: "{{ data.email }}",
        description: "Invoice {{ data.id }}",
        writeBack: { collection: "bills", itemId: "{{ data.id }}", urlField: "pay_url" },
      },
      { id: invoiceId, amount_due: 7500, email: "a@b.test" },
    );
    expect(out.ok).toBe(true);

    const row = (await (await h.fetch(`/api/items/bills/${invoiceId}`)).json()) as {
      data: { pay_url: string | null };
    };
    expect(row.data.pay_url).toContain("/api/payments/dummy/");
    // Minor units travel through untouched — the op is the one place a
    // template could quietly turn 7500 into "7500.00".
    expect(new URL(row.data.pay_url as string).searchParams.get("a")).toBe("7500");
  });

  test("the link is returned into $last so a following step can send it", async () => {
    // Without this, the only way to reach a customer with the link would be a
    // write-back plus a second flow — the pairing with `email`/`sms` is the
    // whole point of returning it, so a following step is how it gets pinned.
    const created = await h.fetch(
      "/api/flows",
      json({
        name: "checkout-then-use-last",
        trigger: "manual:",
        operations: [
          { type: "payment.checkout", provider: "dummy", amount: 4200, currency: "USD" },
          {
            type: "item.update",
            collection: "bills",
            id: "{{ data.id }}",
            data: { pay_url: "{{ $last.url }}" },
          },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const out = (await (
      await h.fetch(`/api/flows/${data.id}/run`, json({ id: invoiceId }))
    ).json()) as FlowRunResult;
    expect(out.ok).toBe(true);

    const row = (await (await h.fetch(`/api/items/bills/${invoiceId}`)).json()) as {
      data: { pay_url: string | null };
    };
    expect(row.data.pay_url).toContain("/api/payments/dummy/");
  });

  test("an amount that renders to a non-integer fails the run", async () => {
    const out = await run(
      { type: "payment.checkout", provider: "dummy", amount: "{{ data.total }}", currency: "USD" },
      { total: "12.50" },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/minor units/);
    // The template is named; the rendered value is not. This message lands on
    // a persisted activity row and the value is a customer's invoice total.
    expect(out.error).toContain("{{ data.total }}");
    expect(out.error).not.toContain("12.50");
  });

  test("an amount that renders empty fails the run", async () => {
    const out = await run(
      { type: "payment.checkout", provider: "dummy", amount: "{{ data.total }}", currency: "USD" },
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/minor units/);
  });

  test("a write-back target that renders empty fails rather than orphaning a link", async () => {
    const out = await run(
      {
        type: "payment.checkout",
        provider: "dummy",
        amount: 1000,
        currency: "USD",
        writeBack: { collection: "bills", itemId: "{{ data.id }}", urlField: "pay_url" },
      },
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/write-back target rendered empty/);
  });

  test("naming both a provider and a connection id is refused at save time", async () => {
    const res = await h.fetch(
      "/api/flows",
      json({
        name: "ambiguous",
        trigger: "manual:",
        operations: [
          {
            type: "payment.checkout",
            provider: "dummy",
            providerId: "some-id",
            amount: 100,
            currency: "USD",
          },
        ],
      }),
    );
    // `providerId` would silently win, so a flow charging through the wrong
    // connection would look like it was working.
    expect(res.status).toBe(422);
  });

  test("a catalog provider surfaces its explanation through the run", async () => {
    await h.fetch(
      "/api/admin/payments/providers",
      json({ provider: "paddle", config: { apiKey: "k", webhookSecret: "s" } }),
    );
    const out = await run({
      type: "payment.checkout",
      provider: "paddle",
      amount: 1000,
      currency: "USD",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("existing price");
  });
});
