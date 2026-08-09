/**
 * Captcha configuration — admin routes. Mounted at `/api/admin/captcha`.
 *
 * The site key comes back on read (it is the public half, and a client has to
 * render the widget with it); the secret never does.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  CAPTCHA_PROVIDERS,
  CAPTCHA_TARGETS,
  clearCaptchaConfig,
  loadCaptchaConfig,
  saveCaptchaConfig,
  toCaptchaView,
} from "../services/captcha";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const View = z
  .object({
    provider: z.enum(CAPTCHA_PROVIDERS).nullable(),
    siteKey: z.string(),
    protect: z.array(z.enum(CAPTCHA_TARGETS)),
    onError: z.enum(["allow", "deny"]),
    enabled: z.boolean(),
    hasSecret: z.boolean(),
  })
  .openapi("CaptchaConfig");

const Input = z
  .object({
    provider: z.enum(CAPTCHA_PROVIDERS),
    siteKey: z.string().min(1).openapi({
      description: "The public half. Handed to browsers so they can render the widget.",
    }),
    secretKey: z.string().min(1).nullish().openapi({
      description: "Write-only. Omit on update to keep the stored one.",
    }),
    protect: z.array(z.enum(CAPTCHA_TARGETS)).openapi({
      description:
        "Which endpoints to gate. A list rather than a switch because the costs differ: a sign-up " +
        "creates a row, a password reset mails somebody who did not ask, a form submission can be " +
        "the abuse itself.",
    }),
    onError: z.enum(["allow", "deny"]).openapi({
      description:
        "Required, no default. `allow` means the gate stops working exactly when the provider is " +
        "having a bad day — which an attacker can arrange. `deny` turns their outage into yours.",
    }),
    enabled: z.boolean().optional(),
  })
  .openapi("CaptchaInput");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["captcha"];

export const captchaRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "Read the captcha configuration",
      description: "The secret is reported as present or absent, never returned.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({
        data: toCaptchaView(await loadCaptchaConfig(c.get("ctx"), requireTenant(c))),
      }),
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags,
      summary: "Configure the captcha",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: Input } } } },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const data = await saveCaptchaConfig(c.get("ctx"), requireTenant(c), c.req.valid("json"));
      await logActivity(c, {
        action: "update",
        collection: "system_captcha",
        itemId: "config",
        // The provider and what it gates are the audit-worthy part; the secret
        // is never written anywhere but the encrypted column.
        payload: { provider: data.provider, protect: data.protect, onError: data.onError },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/",
      tags,
      summary: "Remove the captcha",
      description: "Every gated endpoint stops asking on the next request.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      await clearCaptchaConfig(c.get("ctx"), requireTenant(c));
      await logActivity(c, {
        action: "delete",
        collection: "system_captcha",
        itemId: "config",
      });
      return c.json({ ok: true });
    },
  );
