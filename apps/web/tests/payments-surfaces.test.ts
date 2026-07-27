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
    expect(catalog.providers.map((p) => p.provider)).toEqual(["stripe", "polar", "lemonsqueezy"]);
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
      "payments.connect",
      "payments.disconnect",
      "payments.events",
      "payments.list",
      "payments.provision_collections",
      "payments.rotate_token",
      "payments.sync",
    ]);
    // The claude.ai connector contract rejects a dot, so ids are hyphenated on
    // the wire — which only round-trips if no id contains a hyphen itself.
    for (const n of names) expect(n).not.toContain("-");
  });

  test("the connect tool constrains provider to the supported set", () => {
    const tool = allTools.find((t) => t.name === "payments.connect")!;
    const schema = tool.inputSchema as {
      properties: { provider: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.provider.enum).toEqual(["stripe", "polar", "lemonsqueezy"]);
    expect(schema.required).toEqual(["provider"]);
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
