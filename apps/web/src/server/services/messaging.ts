/**
 * Shared direct-messaging dispatch (push + SMS). The SINGLE source of truth for
 * the abuse guard, input validation, and the admin-or-self target gate so the
 * REST route (`/api/messaging/{push,sms}`) and the GraphQL mutations
 * (`sendPush`/`sendSms`) can't drift — both call `dispatchPush`/`dispatchSms`.
 *
 * Dispatch-only: no in-app notification row (that's `/api/notifications`).
 * A recipient with no registered device/number resolves to `sent: 0`.
 */
import { z } from "zod";
import { AppError, type AuthSubject } from "@backlex/core";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { sendPushToUsers } from "./push";
import { sendSmsToUsers } from "./sms";
import type { Ctx } from "../context";

/** Per-IP dispatch budgets — the abuse/cost guard (SMS + push cost real money
 *  per message at the provider). Shared by both surfaces via `enforceIpRateLimit`. */
export const SMS_SEND_RATE_MAX = 30;
export const PUSH_SEND_RATE_MAX = 60;

export const PushDispatchInput = z.object({
  userId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  url: z.string().url().optional(),
  data: z.record(z.string(), z.string()).optional(),
});
export type PushDispatchInput = z.infer<typeof PushDispatchInput>;

export const SmsDispatchInput = z.object({
  userId: z.string().min(1),
  body: z.string().min(1).max(1600),
});
export type SmsDispatchInput = z.infer<typeof SmsDispatchInput>;

export interface DispatchResult {
  ok: boolean;
  sent: number;
  failed: number;
}

/** Minimal shape `enforceIpRateLimit` needs — a Hono context or an equivalent
 *  shim (the GraphQL resolver builds one from its raw request + Ctx). */
type RateLimitCtx = Parameters<typeof enforceIpRateLimit>[0];

const parseOrThrow = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid input");
  }
  return r.data;
};

/** Admins may target any user; non-admins may only message themselves. */
const assertMayTarget = (auth: AuthSubject, targetUserId: string): void => {
  if (!auth.roles.includes("admin") && targetUserId !== auth.userId) {
    throw new AppError("FORBIDDEN", "Non-admins can only message themselves");
  }
};

export const dispatchPush = async (
  rateCtx: RateLimitCtx,
  ctx: Ctx,
  auth: AuthSubject,
  raw: unknown,
): Promise<DispatchResult> => {
  await enforceIpRateLimit(rateCtx, "push-send", PUSH_SEND_RATE_MAX);
  const input = parseOrThrow(PushDispatchInput, raw);
  assertMayTarget(auth, input.userId);
  const r = await sendPushToUsers(ctx, auth.tenantId ?? null, {
    userIds: [input.userId],
    title: input.title,
    body: input.body,
    url: input.url,
    data: input.data,
  });
  return { ok: true, sent: r.sent, failed: r.failed };
};

export const dispatchSms = async (
  rateCtx: RateLimitCtx,
  ctx: Ctx,
  auth: AuthSubject,
  raw: unknown,
): Promise<DispatchResult> => {
  await enforceIpRateLimit(rateCtx, "sms-send", SMS_SEND_RATE_MAX);
  const input = parseOrThrow(SmsDispatchInput, raw);
  assertMayTarget(auth, input.userId);
  const r = await sendSmsToUsers(ctx, auth.tenantId ?? null, {
    userIds: [input.userId],
    body: input.body,
  });
  return { ok: true, sent: r.sent, failed: r.failed };
};

/** Build a rate-limit context from a raw request + Ctx (GraphQL resolvers have
 *  no Hono `c`). `enforceIpRateLimit` only reads `req.raw` (for the IP header)
 *  and `get("ctx")` (for `env`). */
export const rateLimitCtxFrom = (
  rawRequest: Request | undefined,
  ctx: Ctx,
): RateLimitCtx => ({
  req: { raw: rawRequest ?? new Request("http://local/") },
  get: () => ctx,
});
