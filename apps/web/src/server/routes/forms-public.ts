import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { elapsedMs, requestMeta } from "../services/activity";
import { loadCollection } from "../services/items/collection-loader";
import {
  performCreate,
  type WriteEnv,
} from "../services/items/write";
import {
  exposedFieldNames,
  publicFormDefinition,
  recordFormBlocked,
  recordFormSubmission,
  resolveFormLocale,
  resolveFormToken,
  verifyTurnstile,
  type FormRow,
} from "../services/forms";

const TAGS = ["forms"];

/** Per-form, per-IP submit budget — separate from the global API limiter so a
 *  flooded form can't eat the workspace's overall request budget. */
export const SUBMIT_MAX_PER_MINUTE = 10;
const SUBMIT_WINDOW_MS = 60_000;

const PublicFormBlockSchema = z
  .object({
    kind: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    label: z.string(),
    placeholder: z.string().nullable(),
    help: z.string().nullable(),
    required: z.boolean(),
    rating: z.boolean(),
    choices: z
      .array(z.object({ value: z.string(), label: z.string().optional() }))
      .nullable(),
    validation: z.record(z.string(), z.unknown()).nullable(),
    cond: z
      .object({ field: z.string(), op: z.string(), value: z.string() })
      .nullable(),
  })
  .openapi("PublicFormBlock");

const PublicFormSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    collection: z.string(),
    blocks: z.array(PublicFormBlockSchema),
    submitLabel: z.string().nullable(),
    successMessage: z.string().nullable(),
    redirectUrl: z.string().nullable(),
    theme: z.enum(["dark", "light"]),
    accent: z.string().nullable(),
    font: z.enum(["sans", "lexend", "mono"]),
    languages: z.array(z.string()),
    locale: z.string(),
    turnstileSiteKey: z.string().nullable(),
  })
  .openapi("PublicForm");

const SubmitBody = z
  .object({
    data: z.record(z.string(), z.unknown()),
    /** Turnstile widget response — required when the form has turnstile on. */
    turnstileToken: z.string().optional(),
    /** Honeypot — rendered invisibly by the form page; any non-empty value
     *  marks the submission as bot traffic and it is silently dropped. */
    website: z.string().optional(),
  })
  .openapi("PublicFormSubmission");

const SubmitResult = z
  .object({
    id: z.string().nullable(),
    successMessage: z.string().nullable(),
    redirectUrl: z.string().nullable(),
  })
  .openapi("PublicFormSubmitResult");

const NOT_AVAILABLE = "This form is no longer available";
const PAUSED = "This form is not accepting submissions right now";

/** 404 unknown token; 410 known-but-paused (embedders can tell them apart). */
const requireLiveForm = (form: FormRow | null): FormRow => {
  if (!form) throw new AppError("NOT_FOUND", NOT_AVAILABLE);
  if (!form.active) throw new AppError("GONE", PAUSED);
  return form;
};

/**
 * Public, unauthenticated form endpoints. Mounted at `/api/public/forms` with
 * NO `requireUser` — the token is the grant (mirrors `routes/shared-public.ts`).
 * The `/api/public/` prefix also inherits the framable CSP + XFO-strip in
 * app.ts, so the embed page can call these from inside an iframe.
 *
 * Submissions run through `performCreate` with a null user and the exposed
 * field set as the permission clamp, so field validation, hashed fields,
 * flows/webhooks/realtime events and the audit trail behave exactly like an
 * authenticated create.
 */
export const formsPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{token}",
      tags: TAGS,
      summary: "Resolve a public form token to its definition",
      description:
        "PUBLIC — no auth. Returns the form's blocks (labels, types, choices, validation hints, step breaks, show-conditions) resolved for `?lang=` so the form page can render inputs. Never exposes non-listed fields. Paused forms answer 410.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({ lang: z.string().optional() }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: PublicFormSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const form = requireLiveForm(await resolveFormToken(ctx, token));

      let collection;
      try {
        collection = await loadCollection(ctx, form.tenantId, form.collection);
      } catch {
        throw new AppError("NOT_FOUND", NOT_AVAILABLE);
      }

      return c.json({
        data: publicFormDefinition(
          form,
          collection,
          ctx.env.TURNSTILE_SITE_KEY ?? null,
          c.req.query("lang") ?? null,
        ),
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{token}/submit",
      tags: TAGS,
      summary: "Submit a public form",
      description:
        "PUBLIC — no auth. Validates the honeypot, Turnstile (when enabled) and a per-form/IP rate limit, then creates the row through the standard items write path (validation + flows/webhooks/realtime + audit).",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({ lang: z.string().optional() }),
        body: {
          required: true,
          content: { "application/json": { schema: SubmitBody } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: SubmitResult }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const body = c.req.valid("json");
      const form = requireLiveForm(await resolveFormToken(ctx, token));

      const settings = form.settings ?? {};
      const locale = resolveFormLocale(form, c.req.query("lang") ?? null);
      const base = (settings.languages?.length ? settings.languages : ["en"])[0];
      const i18n = locale !== base ? (settings.i18n?.[locale] ?? {}) : {};
      const success = {
        successMessage: i18n.successMessage || settings.successMessage || null,
        redirectUrl: settings.redirectUrl ?? null,
      };

      // Honeypot: bots fill every input; humans never see this one. Answer
      // with the exact success shape (id kept null on the real path too) so
      // automated probes can't distinguish a dropped submission.
      if (body.website) {
        await recordFormBlocked(ctx, form.id);
        return c.json({ data: { id: null, ...success } }, 201);
      }

      const meta = requestMeta(c.req.raw);
      const ip = meta.ip ?? "unknown";
      const allowed = await rateLimitOk(
        ctx.env,
        `form-submit:${form.id}:${ip}`,
        SUBMIT_MAX_PER_MINUTE,
        SUBMIT_WINDOW_MS,
      );
      if (!allowed) {
        await recordFormBlocked(ctx, form.id);
        throw new AppError(
          "RATE_LIMITED",
          "Too many submissions — please wait a minute and try again",
        );
      }

      if (settings.turnstile) {
        try {
          await verifyTurnstile(
            ctx.env.TURNSTILE_SECRET_KEY,
            body.turnstileToken,
            meta.ip,
          );
        } catch (e) {
          await recordFormBlocked(ctx, form.id);
          throw e;
        }
      }

      let collection;
      try {
        collection = await loadCollection(ctx, form.tenantId, form.collection);
      } catch {
        throw new AppError("NOT_FOUND", NOT_AVAILABLE);
      }

      // Clamp to the exposed field set, re-derived against TODAY's schema.
      // Unknown/extra keys are dropped up front (bots pad payloads; that must
      // not 422 a legitimate-looking submit), and the same set doubles as the
      // permission field clamp inside performCreate for defense in depth.
      const exposed = exposedFieldNames(form, collection);
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body.data)) {
        if (exposed.has(key)) data[key] = value;
      }

      const env: WriteEnv = {
        ctx,
        collection,
        userId: null,
        tenantId: form.tenantId,
        roles: [],
        email: null,
        meta,
        durationMs: () => elapsedMs(c),
        locale: null,
      };
      const res = await performCreate(env, data, {
        whereSql: null,
        fields: exposed,
      });
      for (const fx of res.sideEffects) await fx();
      await recordFormSubmission(ctx, form.id);

      // The row id stays private — a public submitter has no read path to the
      // record, so leaking its id would only aid enumeration.
      return c.json({ data: { id: null, ...success } }, 201);
    },
  );
