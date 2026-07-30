/**
 * iyzico — the first retrieve-style payment provider.
 *
 * The other two modes prove a request came from the provider by checking a
 * signature on it. iyzico posts a bare token with NO signature, so there is
 * nothing on the request to check. Authenticity comes from asking iyzico, with
 * the merchant's own credentials, what that token means.
 *
 * That inverts where the danger lives. The posted body is attacker-controlled
 * in full, so the assertions here are mostly about it being IGNORED: whatever
 * the caller claims about the amount or the outcome must not reach the ledger,
 * and only iyzico's answer may.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  PAYMENT_ACK,
  PAYMENT_PROVIDER_MODES,
  PAYMENT_SECRET_KEYS,
  isCallbackProvider,
  isRetrieveProvider,
  isWebhookProvider,
  normalizePaymentEvent,
  retrieveIyzicoPayment,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";

const API_KEY = "iyz-api-key";
const SECRET_KEY = "iyz-secret-key";
const CONFIG = { apiKey: API_KEY, secretKey: SECRET_KEY, environment: "sandbox" };
const PATH = "/payment/iyzipos/checkoutform/auth/ecom/detail";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Capture what the retrieve call actually sent. */
const spyFetch = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Object.assign(fn, { calls });
};

const SUCCESS = {
  status: "success",
  paymentStatus: "SUCCESS",
  paymentId: "17654321",
  token: "sandbox-tok-1",
  price: "100.00",
  paidPrice: "108.90",
  currency: "TRY",
  basketId: "B-9001",
  conversationId: "conv-1",
  installment: 3,
  paymentChannel: "WEB",
  cardAssociation: "MASTER_CARD",
};

describe("provider registration", () => {
  test("iyzico is a retrieve provider, and that is a third thing", () => {
    expect(PAYMENT_PROVIDER_MODES.iyzico).toBe("retrieve");
    expect(isRetrieveProvider("iyzico")).toBe(true);
    // Not the callback mode: PayTR's hash-on-form-fields does not apply here.
    expect(isCallbackProvider("iyzico")).toBe(false);
    // And not a webhook provider, which is what every "does this sign its
    // requests / expose a catalog" branch actually asks.
    expect(isWebhookProvider("iyzico")).toBe(false);
    expect(isWebhookProvider("stripe")).toBe(true);
  });

  test("the API credentials are secrets — they authenticate the retrieve", () => {
    expect(PAYMENT_SECRET_KEYS.iyzico).toEqual(["apiKey", "secretKey"]);
  });

  test("iyzico takes the default ack", () => {
    expect(PAYMENT_ACK.iyzico).toBeNull();
  });
});

describe("the signature verifier refuses to pretend", () => {
  test("iyzico gets no signature branch, and does not fall through to one", async () => {
    // The last branch in `verifyPaymentSignature` HMACs with whatever `secret`
    // holds — empty, for a provider with no webhook secret — and an empty-key
    // HMAC is computable by anyone. Falling through there would accept every
    // forgery. The backstop asks "is this a webhook provider", so a mode added
    // later fails closed the same way.
    const verdict = await verifyPaymentSignature("iyzico", {
      rawBody: "token=whatever",
      headers: {},
      secret: "",
      config: CONFIG,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("unknown_provider");
  });

  test("a forged signature header cannot make it pass either", async () => {
    const verdict = await verifyPaymentSignature("iyzico", {
      rawBody: "token=whatever",
      headers: { "stripe-signature": "t=1,v1=deadbeef", "x-signature": "deadbeef" },
      secret: "",
      config: CONFIG,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("the retrieve call", () => {
  test("it authenticates with IYZWSv2 over randomKey + path + body", async () => {
    const fetchImpl = spyFetch(() => json(SUCCESS));
    const out = await retrieveIyzicoPayment({
      config: CONFIG,
      token: "tok-1",
      fetchImpl,
      randomKey: "RND123",
    });
    expect(out.ok).toBe(true);

    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe(`https://sandbox-api.iyzipay.com${PATH}`);
    const headers = call.init!.headers as Record<string, string>;
    expect(headers["x-iyzi-rnd"]).toBe("RND123");

    // Recomputed here independently of the code under test — a shared helper
    // would hide a wrong formula from both sides.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const body = String(call.init!.body);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`RND123${PATH}${body}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(headers.Authorization).toBe(
      `IYZWSv2 ${btoa(`apiKey:${API_KEY}&randomKey:RND123&signature:${hex}`)}`,
    );
  });

  test("the token travels in the body, never in the URL", async () => {
    const fetchImpl = spyFetch(() => json(SUCCESS));
    await retrieveIyzicoPayment({ config: CONFIG, token: "../../admin?x=1", fetchImpl });
    const call = fetchImpl.calls[0]!;
    // It is a third party's value reaching an outbound request; a URL segment
    // would make it a path-traversal surface against iyzico's own API.
    expect(call.url).toBe(`https://sandbox-api.iyzipay.com${PATH}`);
    expect(JSON.parse(String(call.init!.body)).token).toBe("../../admin?x=1");
  });

  test("production is the default host; sandbox is opt-in", async () => {
    const fetchImpl = spyFetch(() => json(SUCCESS));
    await retrieveIyzicoPayment({ config: { apiKey: API_KEY, secretKey: SECRET_KEY }, token: "t", fetchImpl });
    expect(fetchImpl.calls[0]!.url).toStartWith("https://api.iyzipay.com");
  });

  test("a token iyzico does not recognise is rejected, not retried", async () => {
    // iyzico answers 200 with `status: failure` for an unknown token, which is
    // exactly what a forged callback produces. That is a verdict, not an
    // outage: retrying it forever would never turn into a payment.
    const fetchImpl = spyFetch(() => json({ status: "failure", errorCode: "3", errorMessage: "Invalid token" }));
    const out = await retrieveIyzicoPayment({ config: CONFIG, token: "forged", fetchImpl });
    expect(out).toEqual({ ok: false, reason: "rejected" });
  });

  test("a transport failure is reported as unreachable, not as a rejection", async () => {
    // The distinction decides whether the caller retries. Calling a network
    // blip a forgery would drop a payment that really happened.
    const throwing = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await retrieveIyzicoPayment({ config: CONFIG, token: "t", fetchImpl: throwing })).toEqual({
      ok: false,
      reason: "unreachable",
    });
    const five = spyFetch(() => new Response("nope", { status: 502 }));
    expect(await retrieveIyzicoPayment({ config: CONFIG, token: "t", fetchImpl: five })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("missing credentials never produce an unauthenticated call", async () => {
    const fetchImpl = spyFetch(() => json(SUCCESS));
    expect(await retrieveIyzicoPayment({ config: {}, token: "t", fetchImpl })).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe("normalizing what iyzico answered", () => {
  test("a settled payment records the amount actually charged", () => {
    const out = normalizePaymentEvent("iyzico", SUCCESS);
    expect(out.type).toBe("payment.success");
    expect(out.eventId).toBe("17654321");
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    // `paidPrice` includes the installment surcharge; `price` is the basket
    // total, and recording that would under-report what the customer paid.
    expect(row.amount).toBe(108.9);
    expect(row.currency).toBe("TRY");
    expect(row.external_id).toBe("17654321");
    expect((row.metadata as Record<string, unknown>).basket_id).toBe("B-9001");
  });

  test("a successful API call about a DECLINED card is a failed payment", () => {
    // `status` only says the API call worked. Conflating it with
    // `paymentStatus` files every decline as a completed payment.
    const out = normalizePaymentEvent("iyzico", {
      ...SUCCESS,
      paymentStatus: "FAILURE",
      errorMessage: "Not sufficient funds",
    });
    expect(out.type).toBe("payment.failed");
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("Not sufficient funds");
  });

  test("a response with no payment id records nothing", () => {
    const out = normalizePaymentEvent("iyzico", { status: "success", paymentStatus: "SUCCESS" });
    expect(out.records).toEqual([]);
  });

  test("the sandbox is not reported as live", () => {
    expect(normalizePaymentEvent("iyzico", SUCCESS).livemode).toBe(false);
    expect(normalizePaymentEvent("iyzico", { ...SUCCESS, token: "live-tok" }).livemode).toBe(true);
  });
});

// End to end through the receive endpoint. Everything above tests the pieces;
// this tests the property that matters: the POSTed body is not evidence.
describe("the callback body is discarded except for the token", () => {
  let h: TestHarness;
  let webhookPath = "";
  let client: Database;
  let realFetch: typeof globalThis.fetch;

  /** Answer the retrieve call; let everything else through. */
  const mockIyzico = (respond: (body: Record<string, unknown>) => Response) => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("iyzipay.com")) {
        return respond(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      }
      return realFetch(input, init);
    }) as typeof fetch;
  };

  const post = (body: string) =>
    h.fetch(webhookPath, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
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
      body: JSON.stringify({ provider: "iyzico", config: CONFIG }),
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

  test("a callback claiming a huge successful payment records what iyzico says", async () => {
    // The entire body is attacker-controlled. If any of it reached the ledger,
    // anyone who found the callback URL could mint payments.
    mockIyzico(() => json({ status: "failure", errorCode: "3", errorMessage: "Invalid token" }));
    const res = await post(
      new URLSearchParams({
        token: "forged",
        status: "success",
        paymentStatus: "SUCCESS",
        paidPrice: "999999.00",
        paymentId: "hijacked",
      }).toString(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(paymentRows()).toHaveLength(0);
  });

  test("only the token is carried over to the retrieve", async () => {
    let seen: Record<string, unknown> = {};
    mockIyzico((body) => {
      seen = body;
      return json(SUCCESS);
    });
    await post(
      new URLSearchParams({ token: "tok-real", paidPrice: "999999.00", locale: "xx" }).toString(),
    );
    expect(seen.token).toBe("tok-real");
    // Nothing else from the POST may influence the question we ask.
    expect(seen.paidPrice).toBeUndefined();
    expect(seen.locale).toBe("tr");
  });

  test("a genuine token records the amount iyzico reports, not the posted one", async () => {
    mockIyzico(() => json({ ...SUCCESS, paymentId: "PAY-REAL-1" }));
    const res = await post(
      new URLSearchParams({ token: "tok-real-1", paidPrice: "1.00" }).toString(),
    );
    expect(res.status).toBe(200);
    const row = paymentRows().find((r) => r.external_id === "PAY-REAL-1");
    expect(row).toBeDefined();
    expect(Number(row!.amount)).toBe(108.9);
    expect(row!.status).toBe("succeeded");
  });

  test("a declined payment is recorded as failed, not skipped", async () => {
    mockIyzico(() =>
      json({ ...SUCCESS, paymentId: "PAY-DECLINED", paymentStatus: "FAILURE", errorMessage: "Insufficient funds" }),
    );
    expect((await post(new URLSearchParams({ token: "tok-declined" }).toString())).status).toBe(200);
    const row = paymentRows().find((r) => r.external_id === "PAY-DECLINED");
    expect(row?.status).toBe("failed");
  });

  test("a callback with no token is refused before any outbound call", async () => {
    let called = false;
    mockIyzico(() => {
      called = true;
      return json(SUCCESS);
    });
    const res = await post(new URLSearchParams({ paymentStatus: "SUCCESS" }).toString());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(called).toBe(false);
  });

  test("iyzico being unreachable is a 5xx, so the retry schedule gets a turn", async () => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("iyzipay.com")) throw new Error("ECONNRESET");
      return realFetch(input, init);
    }) as typeof fetch;
    const res = await post(new URLSearchParams({ token: "tok-blip" }).toString());
    // Answering 4xx here would tell iyzico to stop, dropping a payment that may
    // well have settled.
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("reconcile is refused rather than reported as a clean empty sync", async () => {
    const providers = (await (await h.fetch("/api/admin/payments/providers")).json()) as any;
    const id = providers.data[0].id as string;
    const res = await h.fetch(`/api/admin/payments/providers/${id}/sync`, { method: "POST" });
    const body = await res.text();
    // iyzico has no object catalog. Walking pages would 404 forever; a clean
    // "0 synced" would read as "nothing to do".
    expect(body).toContain("no object catalog");
  });

  test("the credentials never come back out", async () => {
    const body = await (await h.fetch("/api/admin/payments/providers")).text();
    expect(body).not.toContain(SECRET_KEY);
    expect(body).not.toContain(API_KEY);
  });
});
