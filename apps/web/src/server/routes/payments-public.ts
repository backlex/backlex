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
import { Hono } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { rateLimitOk } from "../lib/rate-limit";
import { assertWorkspaceRequestQuota, setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { getProviderByToken, receiveWebhook } from "../services/payments";
import { log } from "../lib/log";

/** A busy Stripe account bursts on subscription renewals, so the per-endpoint
 *  ceiling is generous; the per-IP one is what blunts a guessing attack. */
const WEBHOOK_MAX_PER_IP_PER_MINUTE = 240;
const WEBHOOK_MAX_PER_TOKEN_PER_MINUTE = 600;
const MINUTE_MS = 60_000;

/** Providers cap their own payloads well below this; anything larger is not a
 *  real delivery and shouldn't be buffered into memory to find out. */
const MAX_BODY_BYTES = 1_000_000;

export const paymentsPublicRoutes = new Hono<AppBindings>().post("/webhook/:token", async (c) => {
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

  return c.json({ ok: true, status: outcome.status, written: outcome.written });
});
