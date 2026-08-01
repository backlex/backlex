/**
 * Klarna — buy-now-pay-later, and the second provider whose callback proves
 * nothing.
 *
 * Two things make it different from everything already here:
 *
 *   1. It is `retrieve`, like iyzico, but the handle arrives as JSON rather
 *      than a form field AND it is interpolated into a URL path. iyzico's token
 *      travels in a request body, so a hostile value could only ever be a
 *      strange token; Klarna's session id decides which endpoint the merchant's
 *      credentials are sent to. Most of the assertions below are about that.
 *   2. Its checkout takes TWO calls — the money is a Klarna Payments session,
 *      the page is an HPP session wrapped around it — and the second one
 *      carries `place_order_mode`, which is the difference between money moving
 *      and an authorisation quietly expiring a week later.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  PAYMENT_ACK,
  PAYMENT_HAS_CATALOG,
  PAYMENT_PROVIDER_MODES,
  PAYMENT_SECRET_KEYS,
  hasObjectCatalog,
  isCallbackProvider,
  isRetrieveProvider,
  isWebhookProvider,
  klarnaHost,
  normalizePaymentEvent,
  parseRetrieveHandle,
  retrieveKlarnaPayment,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";
import { PAYMENT_CHECKOUT_MODES, createCheckout } from "../../../packages/integrations/src/checkout";

const USERNAME = "PK12345_0a0a0a0a";
const PASSWORD = "klarna-api-password";
const CONFIG = {
  username: USERNAME,
  password: PASSWORD,
  region: "europe",
  environment: "playground",
  purchaseCountry: "DE",
};
const HOST = "https://api.playground.klarna.com";
const SESSION_ID = "35bde117-ce5f-774f-9bcb-ec514a0963ad";
const ORDER_ID = "7849fd84-47dc-4919-a7ce-b2c1d0e9f8a7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spyFetch = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Object.assign(fn, { calls });
};

const SESSION_COMPLETED = {
  session_id: SESSION_ID,
  status: "COMPLETED",
  order_id: ORDER_ID,
  klarna_reference: "X438HG0Q",
  updated_at: "2026-08-01T14:54:04.675Z",
  expires_at: "2026-08-03T13:51:43.507Z",
};

const ORDER_CAPTURED = {
  order_id: ORDER_ID,
  status: "CAPTURED",
  fraud_status: "ACCEPTED",
  order_amount: 10890,
  captured_amount: 10890,
  refunded_amount: 0,
  purchase_currency: "EUR",
  merchant_reference1: "inv42",
  klarna_reference: "X438HG0Q",
  billing_address: { email: "buyer@example.com", country: "DE" },
  created_at: "2026-08-01T14:53:00.000Z",
  completed_at: "2026-08-01T14:54:04.675Z",
};

/** Answer the session read and the order read from one place, so a test only
 *  states what it is actually varying. */
const klarnaApi = (over: { session?: unknown; order?: unknown; sessionStatus?: number; orderStatus?: number } = {}) =>
  spyFetch((url) => {
    if (url.includes("/hpp/v1/sessions/")) {
      return json(over.session ?? SESSION_COMPLETED, over.sessionStatus ?? 200);
    }
    if (url.includes("/ordermanagement/v1/orders/")) {
      return json(over.order ?? ORDER_CAPTURED, over.orderStatus ?? 200);
    }
    return json({}, 404);
  });

describe("provider registration", () => {
  test("Klarna is a retrieve provider, not a webhook one", () => {
    expect(PAYMENT_PROVIDER_MODES.klarna).toBe("retrieve");
    expect(isRetrieveProvider("klarna")).toBe(true);
    expect(isCallbackProvider("klarna")).toBe(false);
    // The predicate every "does this sign its requests" branch actually asks.
    expect(isWebhookProvider("klarna")).toBe(false);
  });

  test("it has no object catalog to reconcile against", () => {
    // Order Management is addressed one order_id at a time — there is no cursor
    // to walk, so offering a sync would report a clean run that synced nothing.
    expect(PAYMENT_HAS_CATALOG.klarna).toBe(false);
    expect(hasObjectCatalog("klarna")).toBe(false);
  });

  test("only the password is masked — the username is what tells two credentials apart", () => {
    expect(PAYMENT_SECRET_KEYS.klarna).toEqual(["password"]);
  });

  test("Klarna takes the default ack and offers an ad-hoc checkout", () => {
    expect(PAYMENT_ACK.klarna).toBeNull();
    expect(PAYMENT_CHECKOUT_MODES.klarna).toBe("adhoc");
  });
});

describe("the signature verifier refuses to pretend", () => {
  test("Klarna gets no signature branch, and does not fall through to one", async () => {
    // The last branch HMACs with whatever `secret` holds — empty here — and an
    // empty-key HMAC is computable by anyone. Falling through would accept every
    // forgery.
    const verdict = await verifyPaymentSignature("klarna", {
      rawBody: JSON.stringify({ session: { session_id: SESSION_ID } }),
      headers: { "x-signature": "deadbeef", "stripe-signature": "t=1,v1=deadbeef" },
      secret: "",
      config: CONFIG,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("unknown_provider");
  });
});

describe("lifting the handle out of the callback", () => {
  test("the session id is read from the JSON body Klarna actually posts", () => {
    const body = JSON.stringify({
      event_id: "270b2adc-35a4-4524-800a-a5d2b8a96a2c",
      session: { session_id: SESSION_ID, status: "COMPLETED", updated_at: "2026-08-01T14:54:04.675Z" },
    });
    expect(parseRetrieveHandle("klarna", body)).toBe(SESSION_ID);
  });

  test("iyzico's form parser is not applied to Klarna's JSON, or the reverse", () => {
    // Picking the wrong parser yields null, which the receive path reports as a
    // missing signature — that reads as a forged callback rather than as a bug.
    expect(parseRetrieveHandle("iyzico", JSON.stringify({ session: { session_id: SESSION_ID } }))).toBeNull();
    expect(parseRetrieveHandle("klarna", "token=abc")).toBeNull();
  });

  test("a session id that is not a plain id is refused, not escaped", () => {
    // This value is interpolated into a URL path that carries the merchant's
    // Basic-auth credentials. A separator in it chooses the endpoint.
    for (const bad of ["a/b", "..%2f..", "id?query=1", "id#frag", "", "x".repeat(65)]) {
      expect(parseRetrieveHandle("klarna", JSON.stringify({ session: { session_id: bad } }))).toBeNull();
    }
  });
});

describe("host selection", () => {
  test("region is a deployment, not a routing hint", () => {
    expect(klarnaHost({ region: "europe", environment: "production" })).toBe("https://api.klarna.com");
    expect(klarnaHost({ region: "north_america", environment: "production" })).toBe(
      "https://api-na.klarna.com",
    );
    expect(klarnaHost({ region: "oceania", environment: "production" })).toBe(
      "https://api-oc.klarna.com",
    );
    expect(klarnaHost({ region: "north_america", environment: "playground" })).toBe(
      "https://api-na.playground.klarna.com",
    );
  });

  test("an unconfigured connection points at the playground, not at production", () => {
    // The opposite default from every other provider here, on purpose: Klarna
    // credentials are region- AND environment-scoped, so a connection that never
    // chose is far likelier to be half-configured than live.
    expect(klarnaHost({})).toBe(HOST);
    expect(klarnaHost({ region: "atlantis" })).toBe(HOST);
  });
});

describe("the retrieve call", () => {
  test("it reads the session, then the order, over Basic auth", async () => {
    const fetchImpl = klarnaApi();
    const out = await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      `${HOST}/hpp/v1/sessions/${SESSION_ID}`,
      `${HOST}/ordermanagement/v1/orders/${ORDER_ID}`,
    ]);
    const auth = (fetchImpl.calls[0]!.init!.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`);
    // The order fields are what the ledger is written from; the session fields
    // ride along under their own keys so neither can shadow the other.
    expect(out.payload.captured_amount).toBe(10890);
    expect(out.payload.session_id).toBe(SESSION_ID);
    expect(out.payload.session_status).toBe("COMPLETED");
  });

  test("an id Klarna would not accept never reaches an outbound call", async () => {
    const fetchImpl = klarnaApi();
    expect(await retrieveKlarnaPayment({ config: CONFIG, sessionId: "a/../b", fetchImpl })).toEqual({
      ok: false,
      reason: "rejected",
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("an order id Klarna hands back is validated too, not just the callback's", async () => {
    // Klarna's own response decides the second URL. Trusting it because the
    // first call authenticated would move the injection point one hop along.
    const fetchImpl = klarnaApi({ session: { ...SESSION_COMPLETED, order_id: "../../hpp/v1/sessions" } });
    const out = await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl });
    expect(out.ok).toBe(true);
    // One call only: the bad order id is treated as "no order", not escaped.
    expect(fetchImpl.calls).toHaveLength(1);
  });

  test("an unknown session is a verdict; an outage is not", async () => {
    // 4xx means the session does not belong to these credentials — exactly what
    // a forged callback produces, and retrying it forever cannot help.
    const notFound = klarnaApi({ sessionStatus: 404 });
    expect(await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl: notFound })).toEqual({
      ok: false,
      reason: "rejected",
    });
    const down = klarnaApi({ sessionStatus: 503 });
    expect(await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl: down })).toEqual({
      ok: false,
      reason: "unreachable",
    });
    const throwing = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl: throwing })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("a session still in progress is a success with nothing to record", async () => {
    // Klarna calls status_update on EVERY transition. Refusing the interim ones
    // would 400 in its dashboard and read as a broken endpoint.
    const fetchImpl = klarnaApi({ session: { session_id: SESSION_ID, status: "IN_PROGRESS", updated_at: "t1" } });
    const out = await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.payload.order_id).toBeUndefined();
    expect(fetchImpl.calls).toHaveLength(1);
  });

  test("a completed session whose order cannot be read is retried, not guessed", async () => {
    // We know a payment happened and not what it was worth. Filing it at a made
    // up figure is worse than filing it a minute later off Klarna's retry.
    const fetchImpl = klarnaApi({ orderStatus: 500 });
    expect(await retrieveKlarnaPayment({ config: CONFIG, sessionId: SESSION_ID, fetchImpl })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("missing credentials never produce an unauthenticated call", async () => {
    const fetchImpl = klarnaApi();
    expect(await retrieveKlarnaPayment({ config: { region: "europe" }, sessionId: SESSION_ID, fetchImpl })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("a non-ASCII password is encoded, not thrown on", async () => {
    // `btoa` throws on anything above U+00FF. Klarna's own credentials are
    // ASCII, but this one came out of a text box — and a throw would escape
    // `createCheckout`, which documents itself as never throwing.
    const fetchImpl = klarnaApi();
    const out = await retrieveKlarnaPayment({
      config: { ...CONFIG, password: "şifre-Ω" },
      sessionId: SESSION_ID,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    const auth = (fetchImpl.calls[0]!.init!.headers as Record<string, string>).Authorization;
    // Base64 of the UTF-8 BYTES, so it round-trips through a UTF-8 decode —
    // `btoa` would have thrown on the Ω rather than producing this.
    const bytes = Uint8Array.from(atob(auth.slice("Basic ".length)), (ch) => ch.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(`${USERNAME}:şifre-Ω`);
  });
});

describe("normalizing what Klarna answered", () => {
  const completed = { ...ORDER_CAPTURED, session_id: SESSION_ID, session_status: "COMPLETED" };

  test("a captured order records minor units verbatim — no conversion", () => {
    // Klarna quotes minor units, the same as the ledger. iyzico is the one that
    // quotes decimals, and converting here would divide Klarna's rows by 100.
    const out = normalizePaymentEvent("klarna", completed);
    expect(out.type).toBe("order.CAPTURED");
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.amount).toBe(10890);
    expect(row.currency).toBe("EUR");
    expect(row.status).toBe("succeeded");
    expect(row.external_id).toBe(ORDER_ID);
    expect(row.id).toBe(`klarna_${ORDER_ID}`);
    // The whole point of the checkout: our own row id came back.
    expect(row.reference).toBe("inv42");
    expect((row.metadata as Record<string, unknown>).email).toBe("buyer@example.com");
  });

  test("an authorised-not-captured order is pending, and reports the authorised total", () => {
    const out = normalizePaymentEvent("klarna", {
      ...completed,
      status: "AUTHORIZED",
      captured_amount: 0,
    });
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("pending");
    // `captured_amount` is 0 here, so falling back to `order_amount` is what
    // keeps the row from claiming nothing was owed.
    expect(row.amount).toBe(10890);
  });

  test("a partial capture records what moved, and a refund is carried through", () => {
    const out = normalizePaymentEvent("klarna", {
      ...completed,
      status: "PART_CAPTURED",
      captured_amount: 5000,
      refunded_amount: 1000,
    });
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    expect(row.amount).toBe(5000);
    expect(row.amount_refunded).toBe(1000);
  });

  test("a fraud rejection is a failure whatever the order status says", () => {
    const out = normalizePaymentEvent("klarna", {
      ...completed,
      fraud_status: "REJECTED",
    });
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toContain("fraud");
  });

  test("a fraud review still pending is not yet a success", () => {
    const row = (
      normalizePaymentEvent("klarna", { ...completed, fraud_status: "PENDING" }).records[0]!
        .row as Record<string, unknown>
    );
    expect(row.status).toBe("pending");
  });

  test("a session-only delivery writes no row at all", () => {
    // An abandoned checkout is not a payment. A `failed` row for one the
    // consumer then retries successfully would sit in the ledger for ever next
    // to the real payment — the states Klarna calls FAILED/BACK/ERROR are
    // explicitly retryable.
    for (const status of ["IN_PROGRESS", "FAILED", "BACK", "CANCELLED", "TIMEOUT"]) {
      const out = normalizePaymentEvent("klarna", { session_id: SESSION_ID, status, updated_at: "t1" });
      expect(out.records).toEqual([]);
      expect(out.type).toBe(`session.${status}`);
    }
  });

  test("the dedupe key separates a real transition from Klarna's retry of one", () => {
    const at = (updated_at: string) =>
      normalizePaymentEvent("klarna", { session_id: SESSION_ID, status: "IN_PROGRESS", updated_at }).eventId;
    expect(at("t1")).toBe(at("t1"));
    expect(at("t1")).not.toBe(at("t2"));
  });
});

describe("opening a checkout", () => {
  const BASE = {
    config: CONFIG,
    amount: 10890,
    currency: "EUR",
    reference: "inv42",
    description: "Invoice INV-42",
    successUrl: "https://shop.example/thanks",
    callbackUrl: "https://app.example/api/payments/webhook/pwh_x",
    nowMs: Date.UTC(2026, 7, 1, 12, 0, 0),
  };

  const checkoutApi = (over: { session?: unknown; hpp?: unknown; sessionStatus?: number; hppStatus?: number } = {}) =>
    spyFetch((url) => {
      if (url.endsWith("/payments/v1/sessions")) {
        return json(over.session ?? { session_id: "kp-session-1", client_token: "ct" }, over.sessionStatus ?? 200);
      }
      if (url.endsWith("/hpp/v1/sessions")) {
        return json(
          over.hpp ?? {
            session_id: SESSION_ID,
            redirect_url: "https://pay.klarna.com/eu/hpp/payments/2OCkffK",
            expires_at: "2026-08-03T12:00:00.000Z",
          },
          over.hppStatus ?? 200,
        );
      }
      return json({}, 404);
    });

  test("it creates the payments session, then wraps it in a hosted page", async () => {
    const fetchImpl = checkoutApi();
    const res = await createCheckout("klarna", { ...BASE, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);

    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      `${HOST}/payments/v1/sessions`,
      `${HOST}/hpp/v1/sessions`,
    ]);
    expect(res.url).toBe("https://pay.klarna.com/eu/hpp/payments/2OCkffK");
    // The HPP session id, not the payments session id: it is what the status
    // callback reports on and what the retrieve reads back.
    expect(res.externalId).toBe(SESSION_ID);
    expect(res.expiresAt).toBe(Date.parse("2026-08-03T12:00:00.000Z"));
  });

  test("the payments session carries the amount, the market and the reference", async () => {
    const fetchImpl = checkoutApi();
    await createCheckout("klarna", { ...BASE, customer: { email: "buyer@example.com" }, fetchImpl });
    const body = JSON.parse(String(fetchImpl.calls[0]!.init!.body));
    expect(body.order_amount).toBe(10890);
    expect(body.purchase_currency).toBe("EUR");
    expect(body.purchase_country).toBe("DE");
    expect(body.locale).toBe("en-DE");
    // The one field that persists onto the order and comes back on settlement.
    expect(body.merchant_reference1).toBe("inv42");
    // Klarna validates that the lines sum to the order total.
    expect(body.order_lines).toHaveLength(1);
    expect(body.order_lines[0].total_amount).toBe(10890);
    expect(body.billing_address.email).toBe("buyer@example.com");
  });

  test("the hosted page asks Klarna to place AND capture the order", async () => {
    const fetchImpl = checkoutApi();
    await createCheckout("klarna", { ...BASE, fetchImpl });
    const body = JSON.parse(String(fetchImpl.calls[1]!.init!.body));
    // Left at Klarna's default (NONE) the consumer would be authorised, nobody
    // would place the order, and the authorisation would expire days later with
    // no money moved and a customer who believes they paid.
    expect(body.options.place_order_mode).toBe("CAPTURE_ORDER");
    // Server-to-server, and the only one of the URLs that is load-bearing —
    // the browser redirects do not happen if the consumer closes the window.
    expect(body.merchant_urls.status_update).toBe(BASE.callbackUrl);
    // Built from OUR host constant, never from Klarna's answer.
    expect(body.payment_session_url).toBe(`${HOST}/payments/v1/sessions/kp-session-1`);
  });

  test("a customer country overrides the connection default when it is really alpha-2", async () => {
    const fetchImpl = checkoutApi();
    await createCheckout("klarna", { ...BASE, customer: { country: "SE" }, fetchImpl });
    expect(JSON.parse(String(fetchImpl.calls[0]!.init!.body)).purchase_country).toBe("SE");

    // `CheckoutCustomer.country` also accepts a country NAME (iyzico wants
    // one), which Klarna would reject — so a non-code falls back to the
    // connection's own market rather than being sent.
    const named = checkoutApi();
    await createCheckout("klarna", { ...BASE, customer: { country: "Sweden" }, fetchImpl: named });
    expect(JSON.parse(String(named.calls[0]!.init!.body)).purchase_country).toBe("DE");
  });

  test("a market Klarna does not sell in is refused before any credential goes out", async () => {
    const fetchImpl = checkoutApi();
    const res = await createCheckout("klarna", {
      ...BASE,
      config: { ...CONFIG, purchaseCountry: "TR" },
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("invalid_input");
    expect(res.message).toContain("TR");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("no callback URL is refused rather than minting a link nothing listens to", async () => {
    const fetchImpl = checkoutApi();
    const res = await createCheckout("klarna", { ...BASE, callbackUrl: undefined, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("invalid_input");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("missing credentials are distinguishable from a refusal", async () => {
    const fetchImpl = checkoutApi();
    const res = await createCheckout("klarna", { ...BASE, config: { region: "europe" }, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("missing_secret");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("a refusal names Klarna's own message and correlation id", async () => {
    const res = await createCheckout("klarna", {
      ...BASE,
      fetchImpl: checkoutApi({
        sessionStatus: 400,
        session: {
          error_code: "BAD_VALUE",
          error_messages: ["Bad value: order_amount"],
          correlation_id: "corr-1",
        },
      }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("rejected");
    // The correlation id is the only thing Klarna's support will act on.
    expect(res.message).toContain("Bad value: order_amount");
    expect(res.message).toContain("corr-1");
  });

  test("a hosted page with no redirect URL is a refusal, not a broken link", async () => {
    const res = await createCheckout("klarna", {
      ...BASE,
      fetchImpl: checkoutApi({ hpp: { session_id: SESSION_ID } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("rejected");
  });

  test("an expiry outside Klarna's bounds is dropped rather than sent", async () => {
    const fetchImpl = checkoutApi();
    await createCheckout("klarna", { ...BASE, expiresInSec: 400 * 24 * 3600, fetchImpl });
    expect(JSON.parse(String(fetchImpl.calls[1]!.init!.body)).expires_at).toBeUndefined();

    const ok = checkoutApi();
    await createCheckout("klarna", { ...BASE, expiresInSec: 3600, fetchImpl: ok });
    expect(JSON.parse(String(ok.calls[1]!.init!.body)).expires_at).toBe(
      new Date(BASE.nowMs + 3600_000).toISOString(),
    );
  });
});

// End to end through the receive endpoint. The property that matters: Klarna's
// POST is a notification, not evidence.
describe("the callback body is discarded except for the session id", () => {
  let h: TestHarness;
  let webhookPath = "";
  let client: Database;
  let realFetch: typeof globalThis.fetch;

  const mockKlarna = (respond: (url: string) => Response) => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("klarna.com")) return respond(url);
      return realFetch(input, init);
    }) as typeof fetch;
  };

  const post = (body: unknown) =>
    h.fetch(webhookPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const paymentRows = () => {
    const table = (
      client.query("select physical_table as t from collections where slug = 'payment_transactions'").get() as
        | { t: string }
        | undefined
    )?.t;
    return table
      ? (client.query(`select * from "${table}" order by id`).all() as Record<string, unknown>[])
      : [];
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    realFetch = globalThis.fetch;
    const res = await h.fetch("/api/admin/payments/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "klarna", config: CONFIG }),
    });
    expect(res.status).toBe(200);
    webhookPath = ((await res.json()) as any).data.webhookPath;
    client = new Database(h.env.SQLITE_PATH as string);
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a callback claiming a huge settled order records nothing", async () => {
    // The whole body is attacker-controlled. If any of it reached the ledger,
    // anyone who found the callback URL could mint payments.
    mockKlarna(() => json({ error_code: "NOT_FOUND" }, 404));
    const res = await post({
      event_id: "e1",
      session: { session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "COMPLETED" },
      order_id: "hijacked",
      captured_amount: 99999900,
      merchant_reference1: "inv42",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(paymentRows()).toHaveLength(0);
  });

  test("a genuine session records the amount Klarna reports, not the posted one", async () => {
    mockKlarna((url) =>
      url.includes("/hpp/v1/sessions/")
        ? json(SESSION_COMPLETED)
        : json({ ...ORDER_CAPTURED, order_id: ORDER_ID }),
    );
    const res = await post({
      session: { session_id: SESSION_ID, status: "COMPLETED", updated_at: "2026-08-01T14:54:04.675Z" },
      captured_amount: 1,
    });
    expect(res.status).toBe(200);
    const row = paymentRows().find((r) => r.external_id === ORDER_ID);
    expect(row).toBeDefined();
    expect(Number(row!.amount)).toBe(10890);
    expect(row!.status).toBe("succeeded");
    expect(row!.reference).toBe("inv42");
  });

  test("an interim status is accepted with a 2xx and writes no row", async () => {
    // A 4xx here would show up as a failing endpoint in Klarna's dashboard for
    // deliveries that are entirely correct.
    mockKlarna(() => json({ session_id: SESSION_ID, status: "IN_PROGRESS", updated_at: "t9" }));
    const before = paymentRows().length;
    const res = await post({ session: { session_id: SESSION_ID, status: "IN_PROGRESS" } });
    expect(res.status).toBe(200);
    expect(paymentRows()).toHaveLength(before);
  });

  test("a callback with no session id is refused before any outbound call", async () => {
    let called = false;
    mockKlarna(() => {
      called = true;
      return json(SESSION_COMPLETED);
    });
    const res = await post({ event_id: "e2", session: { status: "COMPLETED" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(called).toBe(false);
  });

  test("Klarna being unreachable is a 5xx, so its retry schedule gets a turn", async () => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("klarna.com")) throw new Error("ECONNRESET");
      return realFetch(input, init);
    }) as typeof fetch;
    const res = await post({ session: { session_id: SESSION_ID, status: "COMPLETED" } });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("reconcile is refused rather than reported as a clean empty sync", async () => {
    const providers = (await (await h.fetch("/api/admin/payments/providers")).json()) as any;
    const id = providers.data[0].id as string;
    const res = await h.fetch(`/api/admin/payments/providers/${id}/sync`, { method: "POST" });
    expect(await res.text()).toContain("no object catalog");
  });

  test("the password never comes back out, but the username does", async () => {
    const body = await (await h.fetch("/api/admin/payments/providers")).text();
    expect(body).not.toContain(PASSWORD);
    // Masking it too would hide the field an admin needs to tell two Klarna
    // credentials apart.
    expect(body).toContain(USERNAME);
  });
});
