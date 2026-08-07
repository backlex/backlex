import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { elapsedMs, requestMeta } from "../services/activity";
import { loadCollection } from "../services/items/collection-loader";
import {
  performCreate,
  type WriteEnv,
} from "../services/items/write";
import {
  assertConsents,
  assertScales,
  formAnsweredCookieName,
  formAvailability,
  exposedBlocks,
  exposedFieldNames,
  publicFormDefinition,
  recordFormBlocked,
  recordFormSubmission,
  resolveFormLocale,
  resolveFormToken,
  verifyTurnstile,
  type FormRow,
} from "../services/forms";
import {
  checkFormInvite,
  consumeFormInvite,
  releaseFormInvite,
} from "../services/form-invites";
import {
  consumeFormUploadTicket,
  formUploadPolicy,
  matchesAccept,
  storeFormUpload,
} from "../services/form-uploads";
import { DEMO_BLOCKED_MESSAGE, isDemoMode } from "../services/demo";
import { assertStorageWithinLimit } from "../services/usage";

const TAGS = ["forms"];

/** Per-form, per-IP submit budget — separate from the global API limiter so a
 *  flooded form can't eat the workspace's overall request budget. */
export const SUBMIT_MAX_PER_MINUTE = 10;
const SUBMIT_WINDOW_MS = 60_000;

/** Per-form, per-IP upload budget — uploads happen per field before submit,
 *  so the minute window is looser than the submit one. */
export const UPLOAD_MAX_PER_MINUTE = 20;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    scale: z
      .object({
        min: z.number(),
        max: z.number(),
        style: z.enum(["stars", "number", "nps"]),
        minLabel: z.string().optional(),
        maxLabel: z.string().optional(),
      })
      .nullable(),
    consent: z.boolean(),
    policyUrl: z.string().nullable(),
    choices: z
      .array(z.object({ value: z.string(), label: z.string().optional() }))
      .nullable(),
    accept: z.array(z.string()).nullable(),
    maxBytes: z.number().nullable(),
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
    /** Non-null ⇒ not taking answers; the page shows `message` instead of the
     *  questions. Blocks are still sent so the page keeps its shape. */
    closed: z
      .object({
        reason: z.enum([
          "scheduled",
          "ended",
          "full",
          "answered",
          "invite",
          "invite_used",
        ]),
        message: z.string(),
      })
      .nullable(),
    submitLabel: z.string().nullable(),
    successMessage: z.string().nullable(),
    redirectUrl: z.string().nullable(),
    theme: z.enum(["dark", "light"]),
    accent: z.string().nullable(),
    font: z.enum(["sans", "lexend", "mono", "system"]),
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
    /** Single-use invite token (`inv_…`), required by invite-only forms. The
     *  page carries it over from `?i=` in its own URL. */
    invite: z.string().max(120).optional(),
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

/** Has THIS browser already answered THIS form? Only asked when the form opted
 *  in — reading the cookie otherwise would make a guard out of a setting the
 *  operator did not turn on. */
const hasAnsweredCookie = async (
  c: { req: { header: (name: string) => string | undefined } },
  form: FormRow,
): Promise<boolean> => {
  if (!form.settings?.onePerBrowser) return false;
  const header = c.req.header("cookie");
  if (!header) return false;
  const name = await formAnsweredCookieName(form.id);
  return header.split(";").some((part) => part.trim().startsWith(`${name}=`));
};

/**
 * Remember that this browser answered.
 *
 * `SameSite=None; Secure` when the page is served over https, because the form
 * is embeddable and a Lax cookie is not sent from inside a cross-site iframe —
 * which would make the guard silently do nothing on exactly the deployment
 * that embeds it. Plain http (local dev) keeps Lax, since a browser drops a
 * `Secure` cookie there and the guard would again do nothing.
 */
const setAnsweredCookie = async (
  c: { req: { url: string }; header: (name: string, value: string, opts?: { append?: boolean }) => void },
  form: FormRow,
): Promise<void> => {
  const name = await formAnsweredCookieName(form.id);
  const https = c.req.url.startsWith("https://");
  const attrs = [
    `${name}=1`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    https ? "SameSite=None" : "SameSite=Lax",
    ...(https ? ["Secure"] : []),
  ];
  c.header("set-cookie", attrs.join("; "), { append: true });
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
      // Public path: no authenticated identity, so the form row is what
      // attributes this request to a workspace for usage metering.
      setMeterTenant(c, form.tenantId);

      let collection;
      try {
        collection = await loadCollection(ctx, form.tenantId, form.collection);
      } catch {
        throw new AppError("NOT_FOUND", NOT_AVAILABLE);
      }

      // Invite-only forms resolve the `?i=` token here so the page can say
      // "already used" before someone fills in six answers they can't submit.
      const inviteProblem = form.settings?.inviteOnly
        ? (await checkFormInvite(ctx, form.id, c.req.query("i") ?? null)).problem
        : null;

      return c.json({
        data: publicFormDefinition(
          form,
          collection,
          ctx.env.TURNSTILE_SITE_KEY ?? null,
          c.req.query("lang") ?? null,
          formUploadPolicy(ctx.env).maxBytes,
          formAvailability(form, Date.now(), {
            alreadyAnswered: await hasAnsweredCookie(c, form),
            inviteProblem,
          }),
        ),
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{token}/upload",
      tags: TAGS,
      summary: "Upload a file for a form's file block",
      description:
        "PUBLIC — no auth. Stores the file (private ACL) and returns a signed one-time ticket the submit payload carries in place of the field value. Size, MIME allow-list, per-form/IP rate limits and the workspace storage cap are all enforced here; unsubmitted uploads are swept after 24h.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: z
                .object({
                  /** Field name of the file block the upload belongs to. */
                  field: z.string(),
                  file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
                })
                .openapi("PublicFormUpload"),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Stored",
          content: {
            "application/json": {
              schema: z.object({
                data: z
                  .object({
                    ticket: z.string(),
                    name: z.string(),
                    size: z.number(),
                    contentType: z.string().nullable(),
                  })
                  .openapi("PublicFormUploadResult"),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const form = requireLiveForm(await resolveFormToken(ctx, token));
      // Public path: no authenticated identity, so the form row is what
      // attributes this request to a workspace for usage metering.
      setMeterTenant(c, form.tenantId);
      // The playground wipes hourly and its storage is shared — anonymous
      // uploads would turn it into a free file host, so they stay off there.
      if (isDemoMode(ctx.env))
        throw new AppError("FORBIDDEN", DEMO_BLOCKED_MESSAGE);
      if (!form.tenantId)
        throw new AppError("VALIDATION", "This form does not accept file uploads");

      const meta = requestMeta(c.req.raw);
      const ip = meta.ip ?? "unknown";
      const policy = formUploadPolicy(ctx.env);
      const minuteOk = await rateLimitOk(
        ctx.env,
        `form-upload:${form.id}:${ip}`,
        UPLOAD_MAX_PER_MINUTE,
        SUBMIT_WINDOW_MS,
      );
      // Daily budget is per FORM (not per IP) — it caps what a botnet can
      // store, not just what one address can.
      const dayOk =
        minuteOk &&
        (await rateLimitOk(
          ctx.env,
          `form-upload-day:${form.id}`,
          policy.maxPerDay,
          DAY_WINDOW_MS,
        ));
      if (!minuteOk || !dayOk) {
        await recordFormBlocked(ctx, form.id);
        throw new AppError(
          "RATE_LIMITED",
          "Too many uploads — please wait and try again",
        );
      }

      let collection;
      try {
        collection = await loadCollection(ctx, form.tenantId, form.collection);
      } catch {
        throw new AppError("NOT_FOUND", NOT_AVAILABLE);
      }

      const body = c.req.valid("form");
      const entry = exposedBlocks(form, collection).find(
        (e) => e.def !== null && e.def.name === body.field && e.def.type === "file",
      );
      if (!entry?.def)
        throw new AppError(
          "VALIDATION",
          `"${body.field}" is not an upload field on this form`,
        );

      const file = body.file;
      const cap = Math.min(entry.block.maxBytes || policy.maxBytes, policy.maxBytes);
      if (file.size === 0)
        throw new AppError("VALIDATION", "The uploaded file is empty");
      if (file.size > cap)
        throw new AppError(
          "VALIDATION",
          `File is too large — the limit for this field is ${Math.floor(cap / 1024 / 1024)} MB`,
          { maxBytes: cap, size: file.size },
        );
      if (!matchesAccept(entry.block.accept, file.type))
        throw new AppError(
          "VALIDATION",
          "This file type is not accepted for this field",
          { accept: entry.block.accept ?? null, contentType: file.type || null },
        );
      await assertStorageWithinLimit(ctx, ctx.env, form.tenantId, file.size);

      const stored = await storeFormUpload(
        ctx,
        { id: form.id, tenantId: form.tenantId },
        file,
      );
      return c.json({ data: stored }, 201);
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
      // Public path: no authenticated identity, so the form row is what
      // attributes this request to a workspace for usage metering.
      setMeterTenant(c, form.tenantId);

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

      // Closed on its own terms — a schedule, a response cap, or this browser
      // having answered already. GONE rather than a 4xx that reads like the
      // answer was malformed: the form was reachable, it is simply over. The
      // page shows the same sentence the definition endpoint gave it, so a
      // visitor who kept a tab open across the closing time is told the same
      // thing as one arriving after it.
      const invite = settings.inviteOnly
        ? await checkFormInvite(ctx, form.id, body.invite ?? c.req.query("i"))
        : null;
      const availability = formAvailability(form, Date.now(), {
        alreadyAnswered: await hasAnsweredCookie(c, form),
        inviteProblem: invite?.problem ?? null,
      });
      if (!availability.open) {
        throw new AppError("GONE", availability.message ?? "This form is closed");
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

      assertConsents(form, collection, data);
      assertScales(form, collection, data);

      // File blocks: the payload carries the signed ticket minted by the
      // upload endpoint — NEVER a raw storage key. Swap each ticket for its
      // logical key (and reject anything else) before the row write.
      for (const { block, def } of exposedBlocks(form, collection)) {
        if (!def || def.type !== "file") continue;
        const v = data[def.name];
        if (v === undefined || v === null || v === "") {
          delete data[def.name];
          continue;
        }
        if (!form.tenantId)
          throw new AppError("VALIDATION", "This form does not accept file uploads");
        data[def.name] = await consumeFormUploadTicket(
          ctx,
          { id: form.id, tenantId: form.tenantId },
          v,
          block.label || def.label || def.name,
        );
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
      // Spend the invite BEFORE the write: that is the only ordering in which
      // a double-click cannot leave two answers behind one link. The cost is
      // that a submission which then fails validation would take the person's
      // one link with it, so the catch below hands it back.
      if (invite?.invite) {
        const spent = await consumeFormInvite(ctx, invite.invite.id);
        if (!spent) {
          throw new AppError("GONE", "This invitation has already been used.");
        }
      }

      let res: Awaited<ReturnType<typeof performCreate>>;
      try {
        res = await performCreate(env, data, {
          whereSql: null,
          fields: exposed,
        });
      } catch (e) {
        if (invite?.invite) await releaseFormInvite(ctx, invite.invite.id);
        throw e;
      }
      for (const fx of res.sideEffects) await fx();
      await recordFormSubmission(ctx, form.id);
      // Set AFTER the write, so a submission that failed validation doesn't
      // spend the browser's one answer.
      if (settings.onePerBrowser) await setAnsweredCookie(c, form);

      // The row id stays private — a public submitter has no read path to the
      // record, so leaking its id would only aid enumeration.
      return c.json({ data: { id: null, ...success } }, 201);
    },
  );
