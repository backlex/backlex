import { PAYMENT_PROVIDERS } from "@backlex/integrations/payments";
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { allTools } from "../src/server/mcp/tools";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for payments (#18). REST is covered by payments.test.ts;
 * this pins the other four surfaces — GraphQL, the SDK, MCP and the CLI's
 * endpoint contract — to the same `/api/admin/payments` semantics, so a change
 * to one can't quietly leave the others behind.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const CONFIG = { apiKey: "sk_test_surfaces", webhookSecret: "whsec_surfaces" };

describe("payments — GraphQL surface", () => {
  let h: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("connect → list → events → rotate → disconnect round-trips", async () => {
    const created = await gql(
      `mutation($d:PaymentProviderInput!){ connectPaymentProvider(data:$d){ id provider status webhookPath config } }`,
      { d: { provider: "stripe", config: CONFIG } },
    );
    expect(created.errors).toBeUndefined();
    const row = created.data?.connectPaymentProvider;
    expect(row.provider).toBe("stripe");
    expect(row.webhookPath).toStartWith("/api/payments/webhook/pwh_");
    // The masking guard has to hold on every surface, not just REST.
    expect(row.config.apiKey).not.toBe(CONFIG.apiKey);

    const listed = await gql(`{ paymentProviders { id provider status } }`);
    expect(listed.data?.paymentProviders).toHaveLength(1);

    const events = await gql(`{ paymentEvents(limit: 5) { id type status } }`);
    expect(events.errors).toBeUndefined();
    expect(events.data?.paymentEvents).toEqual([]);

    const rotated = await gql(
      `mutation($id:ID!){ rotatePaymentWebhookToken(id:$id){ webhookPath } }`,
      { id: row.id },
    );
    expect(rotated.data?.rotatePaymentWebhookToken.webhookPath).not.toBe(row.webhookPath);

    const provisioned = await gql(`mutation{ provisionPaymentCollections{ created existing } }`);
    expect(provisioned.data?.provisionPaymentCollections.existing).toHaveLength(4);

    const gone = await gql(`mutation($id:ID!){ disconnectPaymentProvider(id:$id) }`, { id: row.id });
    expect(gone.data?.disconnectPaymentProvider).toBe(true);
    expect((await gql(`{ paymentProviders { id } }`)).data?.paymentProviders).toEqual([]);
  });

  test("connecting provisions the four collections", async () => {
    await gql(`mutation($d:PaymentProviderInput!){ connectPaymentProvider(data:$d){ id } }`, {
      d: { provider: "polar", config: CONFIG },
    });
    const cols = (await (await h.fetch("/api/collections")).json()) as {
      data: { slug: string }[];
    };
    const slugs = cols.data.map((c) => c.slug);
    for (const s of [
      "payment_customers",
      "payment_subscriptions",
      "payment_invoices",
      "payment_transactions",
    ]) {
      expect(slugs).toContain(s);
    }
  });

  test("an unknown provider is a VALIDATION error, not a silent insert", async () => {
    const out = await gql(`mutation($d:PaymentProviderInput!){ connectPaymentProvider(data:$d){ id } }`, {
      d: { provider: "paypal", config: {} },
    });
    expect(out.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("payments — non-admin gate", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a signed-out caller can't read or connect providers", async () => {
    const anon = makeHarness({ SQLITE_PATH: h.env.SQLITE_PATH });
    try {
      expect((await anon.fetch("/api/admin/payments/providers")).status).toBe(401);
      expect(
        (await anon.fetch("/api/admin/payments/providers", json({ provider: "stripe" }))).status,
      ).toBe(401);
      const gqlRes = (await (
        await anon.fetch("/api/graphql", json({ query: `{ paymentProviders { id } }` }))
      ).json()) as { errors?: { extensions?: { code?: string } }[] };
      expect(gqlRes.errors?.[0]?.extensions?.code).toBeDefined();
    } finally {
      // Same file as `h`; only `h.cleanup()` should remove it.
    }
  });
});

describe("payments — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let providerId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({
      url: h.env.APP_URL,
      fetch: (input, init) => h.fetch(String(input), init as RequestInit),
    });
  });
  afterAll(() => h.cleanup());

  test("client.payments.* mirrors the REST endpoints", async () => {
    const catalog = await client.payments.catalog();
    // Derived, not literal — see payments.test.ts.
    expect(catalog.providers.map((p) => p.provider).sort()).toEqual([...PAYMENT_PROVIDERS].sort());
    expect(catalog.recordKinds).toEqual(["customer", "subscription", "invoice", "payment"]);

    const connected = await client.payments.connect({ provider: "lemonsqueezy", config: CONFIG });
    providerId = connected.data.id;
    expect(connected.collections.created).toHaveLength(4);
    expect(connected.data.config.apiKey).not.toBe(CONFIG.apiKey);

    const listed = await client.payments.list();
    expect(listed.data).toHaveLength(1);
    expect(listed.stats).toBeDefined();

    const events = await client.payments.events({ limit: 10 });
    expect(events.data).toEqual([]);

    const queued = await client.payments.sync(providerId, { async: true });
    expect(queued.queued).toBe(true);
    expect(queued.jobId).toBeTruthy();

    const rotated = await client.payments.rotateToken(providerId);
    expect(rotated.data.webhookPath).not.toBe(connected.data.webhookPath);

    const reprovision = await client.payments.provisionCollections();
    expect(reprovision.created).toEqual([]);

    expect(await client.payments.disconnect(providerId)).toEqual({ ok: true });
  });
});

describe("payments — MCP surface", () => {
  test("every payments tool is registered with a wire-safe id", () => {
    const names = allTools.map((t) => t.name).filter((n) => n.startsWith("payments."));
    expect(names.sort()).toEqual([
      "payments.catalog",
      "payments.checkout",
      "payments.connect",
      "payments.disconnect",
      "payments.events",
      "payments.list",
      "payments.provision_collections",
      "payments.refund",
      "payments.rotate_token",
      "payments.sync",
    ]);
    // The claude.ai connector contract rejects a dot, so ids are hyphenated on
    // the wire — which only round-trips if no id contains a hyphen itself.
    for (const n of names) expect(n).not.toContain("-");
  });

  test("the connect tool constrains provider to the supported set", () => {
    const tool = allTools.find((t) => t.name === "payments.connect")!;
    const schema = tool.inputSchema as unknown as {
      properties: { provider: { enum: string[] } };
      required: string[];
    };
    // Asserted against the registry rather than a hand-written list: this
    // enum had silently drifted three providers behind it, so an agent could
    // not connect Paddle, PayTR or iyzico even though REST accepted them.
    expect(schema.properties.provider.enum).toEqual([...PAYMENT_PROVIDERS]);
    expect(schema.required).toEqual(["provider"]);
  });

  test("the checkout tool takes an amount and a currency, and nothing else is required", () => {
    const tool = allTools.find((t) => t.name === "payments.checkout")!;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["amount", "currency"]);
    // `writeBack` is what turns a URL generator into a feature — an agent that
    // can't see it can't put the link on the invoice.
    expect(Object.keys(schema.properties)).toContain("writeBack");
    expect(Object.keys(schema.properties)).toContain("reference");
  });

  test("the refund tool requires nothing, because every field has a default meaning", () => {
    const tool = allTools.find((t) => t.name === "payments.refund")!;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    // Deliberately no `required`: which payment is named by ONE of three
    // fields, and an omitted amount means "the whole remaining balance". A
    // JSON-Schema `required` cannot express either, so the check lives in the
    // service where it can say which of the three is missing.
    expect(schema.required).toBeUndefined();
    for (const key of ["paymentRowId", "externalId", "reference", "amount"]) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });
});

describe("payments — CLI surface", () => {
  test("the CLI registers `payments` and documents every subcommand", async () => {
    const bin = await Bun.file(
      new URL("../../../packages/cli/bin/backlex.ts", import.meta.url).pathname,
    ).text();
    expect(bin).toContain('case "payments":');
    expect(bin).toContain("runPayments");

    const mod = await Bun.file(
      new URL("../../../packages/cli/src/payments.ts", import.meta.url).pathname,
    ).text();
    for (const sub of [
      "catalog",
      "list",
      "connect",
      "checkout",
      "refund",
      "sync",
      "events",
      "rotate-token",
      "provision",
      "disconnect",
    ]) {
      expect(mod).toContain(`case "${sub}":`);
    }
    // Every CLI call must go through the shared admin endpoints, not a
    // hand-rolled second implementation.
    expect(mod).toContain('const BASE = "/api/admin/payments"');
  });
});

describe("payments — checkout parity across surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({
      url: h.env.APP_URL,
      fetch: (input, init) => h.fetch(String(input), init as RequestInit),
    });
    await client.payments.connect({ provider: "dummy", config: {} });
  });
  afterAll(() => h.cleanup());

  test("the catalog reports each provider's checkout mode", async () => {
    const catalog = await client.payments.catalog();
    const modes = Object.fromEntries(catalog.providers.map((p) => [p.provider, p.checkoutMode]));
    // The split the whole feature branches on: an ad-hoc provider takes an
    // amount, a catalog one needs a pre-made price.
    expect(modes.stripe).toBe("adhoc");
    expect(modes.paytr).toBe("adhoc");
    expect(modes.iyzico).toBe("adhoc");
    expect(modes.dummy).toBe("adhoc");
    expect(modes.polar).toBe("catalog");
    expect(modes.lemonsqueezy).toBe("catalog");
    expect(modes.paddle).toBe("catalog");
  });

  test("SDK and GraphQL open the same checkout as REST", async () => {
    const viaSdk = await client.payments.checkout({
      provider: "dummy",
      amount: 2500,
      currency: "USD",
      description: "SDK checkout",
    });
    expect(viaSdk.data.url).toContain("/api/payments/dummy/");
    expect(viaSdk.data.reference).toMatch(/^[A-Za-z0-9]{1,48}$/);
    expect(viaSdk.data.writtenBack).toBeNull();

    const viaGql = await gql(
      `mutation($d:PaymentCheckoutInput!){ createPaymentCheckout(data:$d){ provider url reference } }`,
      { d: { provider: "dummy", amount: 2500, currency: "USD" } },
    );
    expect(viaGql.errors).toBeUndefined();
    expect(viaGql.data?.createPaymentCheckout.provider).toBe("dummy");
    expect(viaGql.data?.createPaymentCheckout.url).toContain("/api/payments/dummy/");

    const viaRest = (await (
      await h.fetch(
        "/api/admin/payments/checkout",
        json({ provider: "dummy", amount: 2500, currency: "USD" }),
      )
    ).json()) as { data: { url: string } };
    expect(viaRest.data.url).toContain("/api/payments/dummy/");
  });

  test("the catalog reports how much of a payment each provider gives back", async () => {
    const catalog = await client.payments.catalog();
    const support = Object.fromEntries(
      catalog.providers.map((p) => [p.provider, p.refundSupport]),
    );
    // Unlike checkout, the split here is not adhoc-vs-catalog: every provider
    // can refund, and only Paddle is limited, because its partial refund
    // adjusts line items a payment row does not carry.
    expect(support.stripe).toBe("full_and_partial");
    expect(support.klarna).toBe("full_and_partial");
    expect(support.polar).toBe("full_and_partial");
    expect(support.paddle).toBe("full_only");
  });

  test("SDK and GraphQL refund through the same service as REST", async () => {
    // One paid payment, refunded a third at a time through each surface — so a
    // surface that silently no-ops shows up as an untouched ledger rather than
    // as a passing assertion on its own response.
    const checkout = await client.payments.checkout({
      provider: "dummy",
      amount: 9000,
      currency: "USD",
    });
    const url = new URL(checkout.data.url);
    await h.fetch(url.pathname + url.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome: "success" }).toString(),
    });
    const reference = checkout.data.reference;

    const viaSdk = await client.payments.refund({ provider: "dummy", reference, amount: 3000 });
    expect(viaSdk.data).toMatchObject({ amount: 3000, currency: "USD", full: false });
    expect(viaSdk.data.ledger).toEqual({ amountRefunded: 3000, status: "succeeded" });

    const viaGql = await gql(
      `mutation($d:PaymentRefundInput!){ refundPayment(data:$d){ amount currency status full } }`,
      { d: { provider: "dummy", reference, amount: 3000 } },
    );
    expect(viaGql.errors).toBeUndefined();
    expect(viaGql.data?.refundPayment).toMatchObject({ amount: 3000, status: "succeeded" });

    const viaRest = (await (
      await h.fetch(
        "/api/admin/payments/refund",
        json({ provider: "dummy", reference, amount: 3000 }),
      )
    ).json()) as { data: { full: boolean; ledger: { amountRefunded: number } } };
    // The third one takes it to the whole amount, which is the only one that
    // may flip the status.
    expect(viaRest.data.full).toBe(true);
    expect(viaRest.data.ledger.amountRefunded).toBe(9000);
  });

  test("GraphQL reports an over-refund with the service's own error code", async () => {
    const res = await gql(
      `mutation($d:PaymentRefundInput!){ refundPayment(data:$d){ amount } }`,
      { d: { provider: "dummy", externalId: "not_a_payment", amount: 1 } },
    );
    // NOT_FOUND rather than a generic failure: the payment is missing, which
    // is a different thing from the provider refusing.
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  test("a catalog provider is refused with an explanation, not a confusing failure", async () => {
    await client.payments.connect({ provider: "polar", config: CONFIG });
    const res = await h.fetch(
      "/api/admin/payments/checkout",
      json({ provider: "polar", amount: 1000, currency: "USD" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(JSON.stringify(body)).toContain("existing product price");
  });
});
