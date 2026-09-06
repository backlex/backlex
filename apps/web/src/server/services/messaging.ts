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
import { assertNotDemo } from "./demo";
import { httpUrl } from "../lib/openapi";
import { sendTemplatedPush } from "./push";
import { sendSmsToUsers } from "./sms";
import type { Ctx } from "../context";

/** Per-IP dispatch budgets — the abuse/cost guard (SMS + push cost real money
 *  per message at the provider). Shared by both surfaces via `enforceIpRateLimit`. */
export const SMS_SEND_RATE_MAX = 30;
export const PUSH_SEND_RATE_MAX = 60;

export const PushDispatchInput = z
  .object({
    userId: z.string().min(1),
    /** Render title/body/url from the matching `push_templates` row (tenant
     *  override → global). Literal `title`/`body` then act as the fallback. */
    templateKey: z.string().min(1).max(40).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(2000).optional(),
    url: httpUrl().optional(),
    data: z.record(z.string(), z.string()).optional(),
  })
  // `title`/`body` were required before templates had a send path, and every
  // existing caller still sends them. What this refuses is the new shape's one
  // bad case: neither a key nor any text, which used to be impossible.
  .refine((v) => Boolean(v.templateKey) || (Boolean(v.title) && Boolean(v.body)), {
    message: "Provide a templateKey, or both title and body",
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
  // Naming a template is an admin act, even when the recipient is yourself.
  // `push_templates` is admin-only config (`/api/admin/push-templates`), and a
  // caller-chosen key is the first surface anywhere that would let a workspace
  // member render one and read the result off their own device — email has no
  // equivalent, because its only template callers are flows an admin authored.
  if (input.templateKey && !auth.roles.includes("admin")) {
    throw new AppError("FORBIDDEN", "Only admins may send by template key");
  }
  const r = await sendTemplatedPush(ctx, auth.tenantId ?? null, {
    userIds: [input.userId],
    templateKey: input.templateKey,
    vars: input.vars,
    fallback: { title: input.title, body: input.body, url: input.url },
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
  // Blocked in the playground wherever it is reached from — the route
  // prefix list is one layer and GraphQL does not pass through it.
  // See `services/demo.ts::assertNotDemo`.
  assertNotDemo(ctx.env);
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
