/**
 * Public integration-webhook receiver — `POST /api/integrations/hooks/:token`.
 *
 * Unauthenticated by necessity: a marketplace and a carrier will not carry a
 * backlex session. Three things stand in for auth, the same three the payment
 * receiver leans on and for the same reasons:
 *   1. the path token is 256 bits of random that resolves the workspace,
 *   2. the delivery must present the endpoint's secret — signed over the raw
 *      bytes where the provider signs, in a header where it does not,
 *   3. per-token and per-IP rate limits bound what an attacker who guesses a
 *      token can spend before the secret check refuses them anyway.
 *
 * Status codes are chosen for the PROVIDER's retry logic, not for a human
 * reading them, and the two providers that ship with this make the stakes
 * concrete. EasyPost retries six times and gives up. Trendyol retries every five
 * minutes until it succeeds and then DEACTIVATES the webhook and emails the
 * seller — so a 4xx for something we merely did not recognise would eventually
 * cost the operator their endpoint. Hence: 2xx for anything understood (applied,
 * duplicate, filtered, a ping), 400 only for a delivery that failed to prove
 * itself, and 5xx strictly for our own failures, which are the ones a retry
 * genuinely fixes.
 */
import { Hono } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { rateLimitOk } from "../lib/rate-limit";
import { assertWorkspaceRequestQuota, setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { receiveDelivery, tenantForWebhookToken } from "../services/integration-webhooks";
import { log } from "../lib/log";

/** A marketplace bursts when a seller's catalogue moves, so the per-endpoint
 *  ceiling is generous; the per-IP one is what blunts a guessing attack. */
const MAX_PER_IP_PER_MINUTE = 240;
const MAX_PER_TOKEN_PER_MINUTE = 600;
const MINUTE_MS = 60_000;

/** An order envelope with a hundred lines is tens of kilobytes. Anything past
 *  this is not a delivery, and finding out should not cost the memory. */
const MAX_BODY_BYTES = 1_000_000;

export const integrationsPublicRoutes = new Hono<AppBindings>().post("/hooks/:token", async (c) => {
  const ctx = c.get("ctx");
  const token = c.req.param("token");

  const ip = requestMeta(c.req.raw).ip ?? "unknown";
  const withinIpBudget = await rateLimitOk(ctx.env, `hook-ip:${ip}`, MAX_PER_IP_PER_MINUTE, MINUTE_MS);
  const withinTokenBudget =
    withinIpBudget && (await rateLimitOk(ctx.env, `hook:${token}`, MAX_PER_TOKEN_PER_MINUTE, MINUTE_MS));
  if (!withinTokenBudget) {
    throw new AppError("RATE_LIMITED", "Too many webhook deliveries — slow down");
  }

  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AppError("BAD_REQUEST", "Webhook payload too large");
  }

  // The token row is what tells us which workspace this unauthenticated request
  // belongs to, so metering can only start here — the same shape the payment
  // receiver and the flow trigger use.
  const tenantId = await tenantForWebhookToken(ctx, token);
  if (!tenantId) throw new AppError("NOT_FOUND", "Unknown webhook endpoint");
  setMeterTenant(c, tenantId);
  await assertWorkspaceRequestQuota(ctx, tenantId);

  // MUST be the raw text: a signature covers the exact bytes the provider sent,
  // so any re-serialization (JSON.parse → stringify) breaks the HMAC.
  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    throw new AppError("BAD_REQUEST", "Webhook payload too large");
  }

  let outcome: Awaited<ReturnType<typeof receiveDelivery>>;
  try {
    outcome = await receiveDelivery(ctx, { token, rawBody, headers: c.req.raw.headers });
  } catch (e) {
    // A processing failure — a schema mismatch, a DB blip — is OURS, so it must
    // read as 5xx: providers retry those, and the delivery is already recorded as
    // failed with the reason for an operator to act on. Letting the raw AppError
    // through would surface a 4xx and imply the provider sent garbage.
    const message = (e as Error)?.message ?? String(e);
    log.error("integrations.webhook_processing_failed", {
      requestId: c.get("requestId"),
      err: message,
    });
    throw new AppError("INTERNAL", `Could not apply the delivery: ${message}`);
  }

  if (!outcome.ok) {
    if (outcome.status === "unknown_token") {
      throw new AppError("NOT_FOUND", "Unknown webhook endpoint");
    }
    if (outcome.status === "disabled") {
      // 4xx on purpose: it tells the provider to stop rather than queue an hour
      // of deliveries to replay the moment the sync is switched back on.
      throw new AppError("FORBIDDEN", "This subscription is turned off");
    }
    log.warn("integrations.webhook_rejected", {
      requestId: c.get("requestId"),
      reason: outcome.reason,
    });
    // 400, not 422: no provider retries a 400, which is exactly the behaviour a
    // delivery that cannot prove itself should get.
    throw new AppError("BAD_REQUEST", `Delivery rejected (${outcome.reason})`);
  }

  return c.json({ ok: true, status: outcome.status, written: outcome.written });
});
