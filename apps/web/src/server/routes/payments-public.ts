import {
  PAYMENT_ACK,
  toMajorUnits,
  type PaymentProvider,
} from "@backlex/integrations/payments";
import { signDummySettlement, verifyDummyCheckout } from "@backlex/integrations/checkout";
/**
 * Public payment-webhook receiver — `POST /api/payments/webhook/:token`.
 *
 * Unauthenticated by necessity: Stripe/Polar/Lemon Squeezy will not carry a
 * backlex session. Three things stand in for auth:
 *   1. the path token is a 24-byte random secret that resolves the workspace,
 *   2. the body must carry a valid provider HMAC signature over the RAW bytes,
 *   3. a per-token and per-IP rate limit bounds what an attacker who guesses a
 *      token can spend before the signature check rejects them anyway.
 *
 * Status codes are chosen for the PROVIDER's retry logic, not for humans:
 * 2xx means "don't send this again" (processed, duplicate, or an event type we
 * deliberately ignore), 400 means "your signature didn't verify" (providers do
 * not retry those, which is what we want), and 5xx means "we broke — please
 * retry", which is how a transient DB failure gets a second chance.
 */
import { Hono, type Context } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { rateLimitOk } from "../lib/rate-limit";
import { assertWorkspaceRequestQuota, setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import {
  decryptProviderConfig,
  getProviderByToken,
  receiveWebhook,
  type PaymentProviderRow,
} from "../services/payments";
import { log } from "../lib/log";

/** A busy Stripe account bursts on subscription renewals, so the per-endpoint
 *  ceiling is generous; the per-IP one is what blunts a guessing attack. */
const WEBHOOK_MAX_PER_IP_PER_MINUTE = 240;
const WEBHOOK_MAX_PER_TOKEN_PER_MINUTE = 600;
const MINUTE_MS = 60_000;

/** Providers cap their own payloads well below this; anything larger is not a
 *  real delivery and shouldn't be buffered into memory to find out. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The `dummy` provider's hosted checkout — `/api/payments/dummy/:token`.
 *
 * Every real provider hosts its own payment page; the dummy one has nowhere to
 * host it but here. GET renders a page with the amount and two buttons; POST
 * settles, by signing a callback body and driving it through the SAME
 * `receiveWebhook` a real provider's delivery goes through. Nothing about the
 * settlement path is special-cased for it, which is the point: a test provider
 * that bypassed verification and dedupe would be testing nothing.
 *
 * The query string is HMAC-signed by `createCheckout`, so this endpoint cannot
 * be used to invent a payment for an arbitrary amount — an unsigned or edited
 * link is refused before anything is recorded.
 */
const dummyPage = (params: {
  amount: string;
  currency: string;
  description: string;
  reference: string;
  action: string;
}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test checkout — ${escapeHtml(params.description)}</title>
<style>
  /* This page is served raw by the Worker, with none of the admin SPA's
     reset behind it. Without border-box the card's padding is ADDED to its
     min(24rem, 100vw - 2rem) width, so it overflows a phone viewport by
     exactly the padding — which only shows up at 390px. */
  *, *::before, *::after { box-sizing: border-box; }
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; overflow-x:hidden;
    font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    background:#f6f7f9; color:#111; }
  @media (prefers-color-scheme: dark) { body { background:#0b0c0e; color:#f2f2f3; } }
  .card { width:min(24rem,calc(100vw - 2rem)); padding:1.75rem; border-radius:14px;
    background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { .card { background:#17181b; box-shadow:none; border:1px solid #2a2c31; } }
  .tag { display:inline-block; font-size:.75rem; letter-spacing:.04em; text-transform:uppercase;
    padding:.15rem .5rem; border-radius:999px; background:#fde68a; color:#713f12; }
  h1 { font-size:1.05rem; margin:.9rem 0 .25rem; }
  .amount { font-size:2rem; font-weight:650; letter-spacing:-.02em; margin:.25rem 0 .1rem; }
  .ref { font-size:.8rem; opacity:.6; word-break:break-all; margin-bottom:1.25rem; }
  form { display:flex; flex-direction:column; gap:.5rem; }
  button { font:inherit; padding:.65rem 1rem; border-radius:9px; border:1px solid transparent; cursor:pointer; }
  .pay { background:#111; color:#fff; }
  @media (prefers-color-scheme: dark) { .pay { background:#f2f2f3; color:#111; } }
  .fail { background:transparent; border-color:#d1d5db; color:inherit; }
  @media (prefers-color-scheme: dark) { .fail { border-color:#3a3c42; } }
</style></head>
<body><main class="card">
  <span class="tag">Test mode</span>
  <h1>${escapeHtml(params.description)}</h1>
  <div class="amount">${escapeHtml(params.amount)} ${escapeHtml(params.currency)}</div>
  <div class="ref">Reference ${escapeHtml(params.reference)}</div>
  <form method="post" action="${escapeHtml(params.action)}">
    <button class="pay" name="outcome" value="success" type="submit">Pay</button>
    <button class="fail" name="outcome" value="failure" type="submit">Decline</button>
  </form>
</main></body></html>`;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

/** Resolve + authenticate a dummy-page request. Shared by GET and POST so the
 *  render and the settlement can never disagree about what is allowed. */
const loadDummyCheckout = async (
  c: Context<AppBindings>,
): Promise<{ provider: PaymentProviderRow; secret: string; params: URLSearchParams }> => {
  const ctx = c.get("ctx");
  const token = c.req.param("token") ?? "";
  const provider = await getProviderByToken(ctx, token);
  // A wrong token and a token belonging to a REAL provider are the same answer
  // on purpose — this endpoint must never be a way to probe which providers a
  // workspace has connected.
  if (!provider || provider.provider !== "dummy" || provider.status !== "connected") {
    throw new AppError("NOT_FOUND", "Unknown checkout");
  }
  const config = await decryptProviderConfig(ctx, provider);
  const secret = typeof config.secret === "string" ? config.secret : "";
  if (!secret) throw new AppError("NOT_FOUND", "Unknown checkout");

  const params = new URL(c.req.url).searchParams;
  if (!(await verifyDummyCheckout(secret, params))) {
    // The signature is what stops this page recording a payment for an amount
    // nobody asked for. An edited link fails here, before anything is written.
    throw new AppError("BAD_REQUEST", "This checkout link is not valid");
  }
  return { provider, secret, params };
};

export const paymentsPublicRoutes = new Hono<AppBindings>()
  .get("/dummy/:token", async (c) => {
    const { params } = await loadDummyCheckout(c);
    const currency = params.get("c") ?? "USD";
    const amount = params.get("a") ?? "0";
    const url = new URL(c.req.url);
    return c.html(
      dummyPage({
        amount: toMajorUnits(Number(amount), currency),
        currency,
        description: params.get("d") || "Payment",
        reference: params.get("r") ?? "",
        // Same URL, same query string — the POST re-verifies the signature
        // rather than trusting that a GET already did.
        action: `${url.pathname}${url.search}`,
      }),
    );
  })
  .post("/dummy/:token", async (c) => {
    const ctx = c.get("ctx");
    const { provider, secret, params } = await loadDummyCheckout(c);
    const form = await c.req.formData();
    const succeeded = form.get("outcome") !== "failure";

    // Built and signed exactly the way a provider would, then pushed through
    // the ordinary receive path — verification, dedupe, normalize, upsert.
    const body = new URLSearchParams({
      reference: params.get("r") ?? "",
      status: succeeded ? "success" : "failed",
      amount: params.get("a") ?? "0",
      currency: params.get("c") ?? "USD",
      at: String(Date.now()),
      ...(succeeded ? {} : { reason: "declined by the tester" }),
    }).toString();
    const signature = await signDummySettlement(secret, body);

    await receiveWebhook(ctx, {
      token: provider.webhookToken,
      rawBody: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-backlex-signature": signature,
      },
    });

    const back = params.get(succeeded ? "s" : "f");
    if (back) return c.redirect(back, 303);
    return c.json({ ok: true, status: succeeded ? "success" : "failed" });
  })
  .post("/webhook/:token", async (c) => {
  const ctx = c.get("ctx");
  const token = c.req.param("token");

  const ip = requestMeta(c.req.raw).ip ?? "unknown";
  const withinIpBudget = await rateLimitOk(
    ctx.env,
    `pay-webhook-ip:${ip}`,
    WEBHOOK_MAX_PER_IP_PER_MINUTE,
    MINUTE_MS,
  );
  const withinTokenBudget =
    withinIpBudget &&
    (await rateLimitOk(
      ctx.env,
      `pay-webhook:${token}`,
      WEBHOOK_MAX_PER_TOKEN_PER_MINUTE,
      MINUTE_MS,
    ));
  if (!withinTokenBudget) {
    throw new AppError("RATE_LIMITED", "Too many webhook deliveries — slow down");
  }

  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AppError("BAD_REQUEST", "Webhook payload too large");
  }

  // The token row is what tells us which workspace owns this unauthenticated
  // request, so metering can only start here (same shape as the flow trigger).
  const provider = await getProviderByToken(ctx, token);
  if (!provider) throw new AppError("NOT_FOUND", "Unknown webhook endpoint");
  if (provider.tenantId) {
    setMeterTenant(c, provider.tenantId);
    await assertWorkspaceRequestQuota(ctx, provider.tenantId);
  }

  // MUST be the raw text: the signature covers the exact bytes the provider
  // sent, so any re-serialization (JSON.parse → stringify) breaks the HMAC.
  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    throw new AppError("BAD_REQUEST", "Webhook payload too large");
  }

  // A processing failure (schema mismatch, DB blip) is OUR fault, so it must
  // read as 5xx: providers retry those, and the delivery is already recorded
  // as `failed` with the reason for the admin to act on. Letting the raw
  // AppError through would surface a 4xx and imply the provider sent garbage.
  let outcome: Awaited<ReturnType<typeof receiveWebhook>>;
  try {
    outcome = await receiveWebhook(ctx, {
      token,
      rawBody,
      headers: c.req.raw.headers,
    });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    log.error("payments.webhook_processing_failed", {
      requestId: c.get("requestId"),
      provider: provider.provider,
      err: message,
    });
    throw new AppError("INTERNAL", `Could not apply the delivery: ${message}`);
  }

  if (!outcome.ok) {
    if (outcome.status === "unknown_token") {
      throw new AppError("NOT_FOUND", "Unknown webhook endpoint");
    }
    if (outcome.status === "disabled") {
      // 410 would be more precise, but AppError's map doesn't carry it and a
      // provider treats 4xx the same way: stop retrying, surface to the admin.
      throw new AppError("FORBIDDEN", "This payment integration is disabled");
    }
    log.warn("payments.webhook_rejected", {
      requestId: c.get("requestId"),
      provider: provider.provider,
      reason: outcome.reason,
    });
    // 400, not 422: Stripe documents a signature failure as a 400 and no
    // provider retries one — which is exactly the behaviour we want.
    throw new AppError("BAD_REQUEST", `Signature verification failed (${outcome.reason})`);
  }

  // Some providers demand a specific ACK body. PayTR requires the literal `OK`
  // and treats anything else — including a perfectly good JSON success — as a
  // failure, retrying on a schedule and eventually disabling the merchant's
  // notification URL. Returning JSON to it would look fine in our logs and be
  // broken at the merchant's end.
  const ack = PAYMENT_ACK[provider.provider as PaymentProvider];
  if (ack) {
    return c.body(ack.body, 200, { "content-type": ack.contentType });
  }
  return c.json({ ok: true, status: outcome.status, written: outcome.written });
  });
