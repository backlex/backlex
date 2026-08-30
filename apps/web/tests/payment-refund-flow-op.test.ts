/**
 * The `payment.refund` flow operation.
 *
 * The automation this pairs with is a status changing: an order row moves to
 * `cancelled`, or a return is approved, and the money goes back without an
 * operator remembering to open the PSP's dashboard.
 *
 * Two failure modes are specific to this op and neither can be caught at save
 * time:
 *
 *   - every one of the three payment handles RENDERS empty, because the
 *     template points at a column the triggering row doesn't carry. Refunding
 *     "whichever payment" instead is not a recoverable guess;
 *   - a PRESENT amount renders to something that isn't a positive integer.
 *     An ABSENT one is fine and means the whole remaining balance, which is
 *     the opposite of how `payment.checkout` treats its amount.
 *
 * Runs go through the HTTP invoke endpoint so interpolation, tenant scoping and
 * the error surface are exercised together, with the `dummy` provider standing
 * in for an acquirer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import type { FlowRunResult } from "../../../packages/client/src/index";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("payment.refund flow op", () => {
  let h: TestHarness;
  let reference = "";
  let orderId = "";

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/payments/providers", json({ provider: "dummy", config: {} }));

    // An order row shaped like the templates': a total, and the reference the
    // payment link travelled out with — which is all a cancellation flow has.
    await h.fetch(
      "/api/collections",
      json({
        slug: "orders",
        fields: [
          { name: "total", type: "integer" },
          { name: "payment_reference", type: "text" },
          { name: "status", type: "text" },
        ],
      }),
    );

    const checkout = (await (
      await h.fetch(
        "/api/admin/payments/checkout",
        json({ provider: "dummy", amount: 6000, currency: "USD", description: "Order" }),
      )
    ).json()) as { data: { url: string; reference: string } };
    reference = checkout.data.reference;
    const url = new URL(checkout.data.url);
    await h.fetch(url.pathname + url.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome: "success" }).toString(),
    });

    const created = (await (
      await h.fetch(
        "/api/items/orders",
        json({ total: 6000, payment_reference: reference, status: "cancelled" }),
      )
    ).json()) as { data: { id: string } };
    orderId = created.data.id;
  });
  afterEach(() => h.cleanup());

  const run = async (
    op: Record<string, unknown>,
    input: Record<string, unknown> = {},
  ): Promise<FlowRunResult & { saveError?: string }> => {
    const created = await h.fetch(
      "/api/flows",
      json({
        name: `refund-${Math.random().toString(36).slice(2)}`,
        trigger: "manual:",
        operations: [op],
      }),
    );
    const body = (await created.json()) as { data?: { id: string }; error?: unknown };
    if (created.status !== 201) return { ok: false, saveError: JSON.stringify(body) };
    const res = await h.fetch(`/api/flows/${body.data!.id}/run`, json(input));
    return (await res.json()) as FlowRunResult;
  };

  const payment = async () => {
    const rows = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: { amount_refunded: number; status: string }[];
    };
    return rows.data[0]!;
  };

  test("refunds the whole balance off the row's own reference", async () => {
    const out = await run(
      { type: "payment.refund", provider: "dummy", reference: "{{ data.payment_reference }}" },
      { payment_reference: reference },
    );
    expect(out.ok).toBe(true);
    expect(await payment()).toMatchObject({ amount_refunded: 6000, status: "refunded" });
  });

  test("a rendered amount refunds only part of it", async () => {
    const out = await run(
      {
        type: "payment.refund",
        provider: "dummy",
        reference: "{{ data.payment_reference }}",
        amount: "{{ data.refund_amount }}",
      },
      { payment_reference: reference, refund_amount: 1500 },
    );
    expect(out.ok).toBe(true);
    expect(await payment()).toMatchObject({ amount_refunded: 1500, status: "succeeded" });
  });

  test("the outcome is returned into $last so a following step can record it", async () => {
    // Without this the op would move money and tell the flow nothing, so the
    // `status` a following `condition` needs to branch on — Adyen and Paddle
    // both answer `pending` — would be unreachable.
    const created = await h.fetch(
      "/api/flows",
      json({
        name: "refund-then-use-last",
        trigger: "manual:",
        operations: [
          { type: "payment.refund", provider: "dummy", reference, amount: 2000 },
          {
            type: "item.update",
            collection: "orders",
            id: "{{ data.id }}",
            data: { status: "refunded {{ $last.amount }} {{ $last.currency }} {{ $last.status }}" },
          },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const out = (await (
      await h.fetch(`/api/flows/${data.id}/run`, json({ id: orderId }))
    ).json()) as FlowRunResult;
    expect(out.ok).toBe(true);

    const order = (await (await h.fetch(`/api/items/orders/${orderId}`)).json()) as {
      data: { status: string };
    };
    expect(order.data.status).toBe("refunded 2000 USD succeeded");
  });

  test("an amount that renders to nonsense fails the run instead of refunding everything", async () => {
    const out = await run(
      {
        type: "payment.refund",
        provider: "dummy",
        reference: "{{ data.payment_reference }}",
        amount: "{{ data.missing_column }}",
      },
      { payment_reference: reference },
    );
    expect(out.ok).toBe(false);
    // Falling through to "the whole balance" would give back more than the
    // author asked for, silently.
    expect(out.error).toContain("did not render to a positive integer");
    expect(await payment()).toMatchObject({ amount_refunded: 0 });
  });

  test("a handle that renders empty fails the run rather than refunding some other payment", async () => {
    const out = await run(
      { type: "payment.refund", provider: "dummy", reference: "{{ data.nope }}" },
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("could not tell which payment");
    expect(await payment()).toMatchObject({ amount_refunded: 0 });
  });

  test("an over-refund surfaces the service's own message, not a generic failure", async () => {
    await run(
      {
        type: "payment.refund",
        provider: "dummy",
        reference: "{{ data.payment_reference }}",
        amount: 5000,
      },
      { payment_reference: reference },
    );
    const out = await run(
      {
        type: "payment.refund",
        provider: "dummy",
        reference: "{{ data.payment_reference }}",
        amount: 5000,
      },
      { payment_reference: reference },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("1000");
    expect(await payment()).toMatchObject({ amount_refunded: 5000 });
  });

  test("an op naming no payment at all is refused at SAVE time", async () => {
    const out = await run({ type: "payment.refund", provider: "dummy", amount: 100 });
    // Not a flow that sometimes fails — one that can never do anything, so the
    // author should hear about it while they are still in the builder.
    expect(out.ok).toBe(false);
    expect(String((out as { saveError?: string }).saveError)).toContain("paymentRowId");
  });

  test("naming both a provider and a connection id is refused at SAVE time", async () => {
    const out = await run({
      type: "payment.refund",
      provider: "dummy",
      providerId: "some-id",
      reference: "x",
    });
    expect(out.ok).toBe(false);
    expect(String((out as { saveError?: string }).saveError)).toContain("not both");
  });

  test("refunding by the payment row id works as well as by reference", async () => {
    const rows = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: { id: string }[];
    };
    const out = await run(
      { type: "payment.refund", provider: "dummy", paymentRowId: "{{ data.pid }}", amount: 600 },
      { pid: rows.data[0]!.id },
    );
    expect(out.ok).toBe(true);
    expect(await payment()).toMatchObject({ amount_refunded: 600 });
    // The order row is untouched — the refund writes to the ledger, not to
    // whatever triggered it.
    const order = (await (await h.fetch(`/api/items/orders/${orderId}`)).json()) as {
      data: { status: string };
    };
    expect(order.data.status).toBe("cancelled");
  });
});
