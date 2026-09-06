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
  assertChoices,
  assertConsents,
  assertScales,
  draftableValues,
  formAnsweredCookieName,
  formAvailability,
  exposedBlocks,
  exposedFieldNames,
  FORM_HONEYPOT_FIELD,
  publicFormDefinition,
  recordFormBlocked,
  recordFormSubmission,
  resolveFormLocale,
  resolveFormToken,
  verifyTurnstile,
  type FormRow,
} from "../services/forms";
import { enforceCaptcha, loadCaptchaConfig } from "../services/captcha";
import {
  checkFormInvite,
  consumeFormInvite,
  releaseFormInvite,
} from "../services/form-invites";
import {
  deleteFormDraft,
  formDraftCookieName,
  formDraftKeyHash,
  loadFormDraft,
  newFormDraftSecret,
  saveFormDraft,
  FORM_DRAFT_MAX_BYTES,
} from "../services/form-drafts";
import {
  consumeFormUploadTicket,
  formUploadPolicy,
  matchesAccept,
  storeFormUpload,
} from "../services/form-uploads";
import { assertDeclaredLengthWithin } from "../services/storage/limit-stream";
import { DEMO_BLOCKED_MESSAGE, isDemoMode } from "../services/demo";
import { assertStorageWithinLimit } from "../services/usage";

const TAGS = ["forms"];

/** Per-form, per-IP submit budget — separate from the global API limiter so a
 *  flooded form can't eat the workspace's overall request budget. */
export const SUBMIT_MAX_PER_MINUTE = 10;
const SUBMIT_WINDOW_MS = 60_000;

/** Multipart boundaries + per-part headers, allowed on top of the file cap.
 *  Generous — this check exists to refuse a body that is obviously too big, not
 *  to be the byte-exact limit. `file.size > cap` below still is. */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;

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
    /** Non-null ⇒ one row of a matrix; blocks sharing an `id` are drawn as one
     *  grid. The row is still an ordinary field block and renders alone. */
    matrix: z
      .object({ id: z.string(), label: z.string(), help: z.string().nullable() })
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
    /**
     * The challenge this form's submit enforces — `null` when there is none.
     *
     * `turnstileSiteKey` above cannot express the other two providers, and it
     * reported a DEPLOYMENT env var while the submit below enforces the
     * WORKSPACE config. See `publicFormDefinition` for what that cost.
     */
    captcha: z
      .object({
        provider: z.enum(["turnstile", "hcaptcha", "recaptcha"]),
        siteKey: z.string(),
      })
      .nullable(),
    /**
     * Name of the honeypot input a client must render (hidden) and submit at
     * the TOP level of the body, beside `data`.
     *
     * The hosted page has always drawn it, but the field name lived only in
     * that page's markup and in prose — so anyone building their own form
     * against this endpoint had no way to know it existed, and a value placed
     * inside `data` is treated as an ordinary field, which writes the spam row
     * it was meant to stop. Naming it here makes the layer usable by the
     * clients the endpoint exists for.
     */
    honeypotField: z.string(),
    /** True ⇒ the page saves what is filled in as it is filled in. */
    saveProgress: z.boolean(),
    /** What this visitor left behind last time, or null for a fresh start. */
    draft: z
      .object({
        data: z.record(z.string(), z.unknown()),
        step: z.number(),
        savedAt: z.number(),
      })
      .nullable(),
  })
  .openapi("PublicForm");

const SubmitBody = z
  .object({
    data: z.record(z.string(), z.unknown()),
    /** Turnstile widget response — required when the form has turnstile on. */
    turnstileToken: z.string().optional(),
    /** Captcha widget response, for a workspace-configured captcha (any of the
     *  three providers). Kept separate from `turnstileToken` so a page serving
     *  both a legacy deployment-Turnstile form and a workspace-captcha form
     *  does not have to guess which one the server will check. */
    captchaToken: z.string().optional(),
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

/** Per-form, per-IP draft-save budget. The page saves on a debounce and on
 *  every step change, so this sits well above the submit limit — it is a valve
 *  against a script writing rows in a loop, not against someone answering. */
export const DRAFT_MAX_PER_MINUTE = 60;

const NOT_AVAILABLE = "This form is no longer available";
const PAUSED = "This form is not accepting submissions right now";

/** 404 unknown token; 410 known-but-paused (embedders can tell them apart). */
const requireLiveForm = (form: FormRow | null): FormRow => {
  if (!form) throw new AppError("NOT_FOUND", NOT_AVAILABLE);
  if (!form.active) throw new AppError("GONE", PAUSED);
  return form;
};

/** One cookie's value out of a request header, or null. */
const readCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
};

/**
 * Attributes every cookie these public endpoints set.
 *
 * `SameSite=None; Secure` when the page is served over https, because the form
 * is embeddable and a Lax cookie is not sent from inside a cross-site iframe —
 * which would make the guard silently do nothing on exactly the deployment
 * that embeds it. Plain http (local dev) keeps Lax, since a browser drops a
 * `Secure` cookie there and the guard would again do nothing.
 */
const cookieAttrs = (https: boolean, maxAgeSeconds: number): string[] => [
  "Path=/",
  `Max-Age=${maxAgeSeconds}`,
  "HttpOnly",
  https ? "SameSite=None" : "SameSite=Lax",
  ...(https ? ["Secure"] : []),
];

/** Has THIS browser already answered THIS form? Only asked when the form opted
 *  in — reading the cookie otherwise would make a guard out of a setting the
 *  operator did not turn on. */
const hasAnsweredCookie = async (
  c: { req: { header: (name: string) => string | undefined } },
  form: FormRow,
): Promise<boolean> => {
  if (!form.settings?.onePerBrowser) return false;
  const name = await formAnsweredCookieName(form.id);
  return readCookie(c.req.header("cookie"), name) !== null;
};

/** Remember that this browser answered. */
const setAnsweredCookie = async (
  c: { req: { url: string }; header: (name: string, value: string, opts?: { append?: boolean }) => void },
  form: FormRow,
): Promise<void> => {
  const name = await formAnsweredCookieName(form.id);
  const attrs = [`${name}=1`, ...cookieAttrs(c.req.url.startsWith("https://"), 31536000)];
  c.header("set-cookie", attrs.join("; "), { append: true });
};

/** A draft cookie lives as long as a draft does — a month. */
const DRAFT_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Which draft this visitor is holding the key to.
 *
 * An invited person's key is their invite token: the draft then follows the
 * link they were mailed, so the phone that started the survey and the laptop
 * that finishes it are the same person. Everyone else gets an opaque cookie,
 * which is the same courtesy-not-a-count posture as `onePerBrowser`.
 *
 * `mint` distinguishes the two callers. A save may create the key (that is what
 * starting to answer means); a read may not — minting one on every definition
 * fetch would set a cookie on people who never typed anything, for a draft that
 * does not exist.
 */
const resolveDraftKey = async (
  c: {
    req: { url: string; header: (name: string) => string | undefined };
    header: (name: string, value: string, opts?: { append?: boolean }) => void;
  },
  form: FormRow,
  inviteToken: string | null | undefined,
  opts: { mint: boolean },
): Promise<string | null> => {
  if (!form.settings?.saveProgress) return null;
  if (form.settings.inviteOnly) {
    return inviteToken ? await formDraftKeyHash(`i:${inviteToken}`) : null;
  }
  const name = await formDraftCookieName(form.id);
  const existing = readCookie(c.req.header("cookie"), name);
  if (existing) return await formDraftKeyHash(`b:${existing}`);
  if (!opts.mint) return null;
  const secret = newFormDraftSecret();
  c.header(
    "set-cookie",
    [`${name}=${secret}`, ...cookieAttrs(c.req.url.startsWith("https://"), DRAFT_COOKIE_MAX_AGE)].join("; "),
    { append: true },
  );
  return await formDraftKeyHash(`b:${secret}`);
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
      const inviteToken = c.req.query("i") ?? null;
      const inviteProblem = form.settings?.inviteOnly
        ? (await checkFormInvite(ctx, form.id, inviteToken)).problem
        : null;

      const availability = formAvailability(form, Date.now(), {
        alreadyAnswered: await hasAnsweredCookie(c, form),
        inviteProblem,
      });

      // Saved answers ride back with the definition, so a returning visitor
      // gets one request and a filled-in form rather than a blank one that
      // repopulates a moment later. A closed form skips the read: there is
      // nothing to come back to.
      const keyHash = availability.open
        ? await resolveDraftKey(c, form, inviteToken, { mint: false })
        : null;
      const draft = keyHash ? await loadFormDraft(ctx, form.id, keyHash) : null;

      // This response is per-visitor — it carries their own half-filled
      // answers, and its "you already answered" state was already a function of
      // their cookie. Said out loud so no intermediary caches one person's
      // answers and hands them to the next.
      c.header("cache-control", "private, no-store");
      c.header("vary", "cookie", { append: true });

      // The same config the submit handler below enforces, read here so the
      // page can render the widget it is about to be asked for. Before this
      // the two read different sources and a protected form could never be
      // submitted from its own page.
      const wsCaptcha = form.tenantId ? await loadCaptchaConfig(ctx, form.tenantId) : null;
      const formCaptcha =
        wsCaptcha?.enabled && wsCaptcha.protect.includes("forms")
          ? { provider: wsCaptcha.provider, siteKey: wsCaptcha.siteKey }
          : null;

      return c.json({
        data: publicFormDefinition(
          form,
          collection,
          ctx.env.TURNSTILE_SITE_KEY ?? null,
          c.req.query("lang") ?? null,
          formUploadPolicy(ctx.env).maxBytes,
          availability,
          draft,
          formCaptcha,
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

      const meta = requestMeta(c.req.raw, c.get("ctx").env);
      const ip = meta.ip ?? "unknown";
      const policy = formUploadPolicy(ctx.env);
      // Refuse on the DECLARED length, before anything reads the body.
      //
      // `c.req.valid("form")` calls `Request.formData()`, which buffers the
      // ENTIRE multipart body — every part, in memory — before a line of
      // handler code runs. So the `file.size > cap` refusal further down fired
      // only after the bytes were already resident: an unauthenticated visitor
      // could POST 100 MB to a form whose file block declares a 1 MB cap, push
      // a 128 MB Workers isolate toward its ceiling, and get a 422 afterwards.
      // Repeated from a few addresses inside the per-IP minute budget, that is
      // unauthenticated memory pressure on the tenant's Worker.
      //
      // The framing allowance covers the multipart boundaries and part headers,
      // which are part of the request but not of the file.
      assertDeclaredLengthWithin(
        c.req.header("content-length"),
        policy.maxBytes + MULTIPART_FRAMING_ALLOWANCE,
        "Upload",
      );
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
      method: "put",
      path: "/{token}/draft",
      tags: TAGS,
      summary: "Save a half-filled form so it can be resumed",
      description:
        "PUBLIC — no auth. Stores the answers given so far against the visitor's resume key (their invite token on invite-only forms, otherwise an opaque HttpOnly cookie this endpoint mints). Only forms with `settings.saveProgress` accept this; answers are clamped to the exposed field set and file blocks are never stored. The saved answers come back on the next `GET /{token}`.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({
                  data: z.record(z.string(), z.unknown()),
                  /** Step page reached, so the visitor returns to where they
                   *  stopped rather than to question one. */
                  step: z.number().int().min(0).max(500).optional(),
                  /** Invite token — on invite-only forms this IS the key the
                   *  draft is filed under, so it travels with every save. */
                  invite: z.string().max(120).optional(),
                })
                .openapi("PublicFormDraftInput"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: {
            "application/json": {
              schema: z.object({
                data: z
                  .object({ savedAt: z.number() })
                  .openapi("PublicFormDraftResult"),
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
      const body = c.req.valid("json");
      const form = requireLiveForm(await resolveFormToken(ctx, token));
      setMeterTenant(c, form.tenantId);

      if (!form.settings?.saveProgress) {
        throw new AppError("VALIDATION", "This form does not save progress");
      }

      // A form that is over has nothing to come back to, and a draft written
      // against one is storage nobody will ever read.
      const inviteToken = body.invite ?? c.req.query("i") ?? null;
      const invite = form.settings.inviteOnly
        ? await checkFormInvite(ctx, form.id, inviteToken)
        : null;
      const availability = formAvailability(form, Date.now(), {
        alreadyAnswered: await hasAnsweredCookie(c, form),
        inviteProblem: invite?.problem ?? null,
      });
      if (!availability.open) {
        throw new AppError("GONE", availability.message ?? "This form is closed");
      }

      const ip = requestMeta(c.req.raw, c.get("ctx").env).ip ?? "unknown";
      const allowed = await rateLimitOk(
        ctx.env,
        `form-draft:${form.id}:${ip}`,
        DRAFT_MAX_PER_MINUTE,
        SUBMIT_WINDOW_MS,
      );
      if (!allowed) {
        throw new AppError("RATE_LIMITED", "Too many saves — please slow down");
      }

      let collection;
      try {
        collection = await loadCollection(ctx, form.tenantId, form.collection);
      } catch {
        throw new AppError("NOT_FOUND", NOT_AVAILABLE);
      }

      // Same exposed-field clamp the submit uses: a public endpoint that stores
      // whatever it is handed is a key-value store, not a form.
      const data = draftableValues(form, collection, body.data);
      if (JSON.stringify(data).length > FORM_DRAFT_MAX_BYTES) {
        throw new AppError(
          "VALIDATION",
          "These answers are too large to save — submit the form instead",
        );
      }

      const keyHash = await resolveDraftKey(c, form, inviteToken, { mint: true });
      if (!keyHash) {
        // Invite-only and no usable invite: availability above already refuses
        // that, so reaching here means the form changed under the request.
        throw new AppError("VALIDATION", "This form cannot save progress for you");
      }
      const savedAt = await saveFormDraft(ctx, {
        formId: form.id,
        tenantId: form.tenantId,
        keyHash,
        data,
        step: body.step ?? 0,
      });
      return c.json({ data: { savedAt } });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{token}/draft",
      tags: TAGS,
      summary: "Throw away a saved half-filled form",
      description:
        "PUBLIC — no auth. Deletes the saved answers behind this visitor's resume key. What the 'start over' button on the form page calls, so someone is never stuck with answers they no longer want.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({ i: z.string().max(120).optional() }),
      },
      responses: {
        200: {
          description: "Cleared",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ cleared: z.boolean() }) }),
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
      setMeterTenant(c, form.tenantId);
      const keyHash = await resolveDraftKey(c, form, c.req.query("i") ?? null, {
        mint: false,
      });
      if (keyHash) await deleteFormDraft(ctx, form.id, keyHash);
      // `cleared: true` either way: whether a row existed is the caller's own
      // business, and the outcome they asked for — nothing saved — is the same.
      return c.json({ data: { cleared: true } });
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
      if (body[FORM_HONEYPOT_FIELD as "website"]) {
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

      const meta = requestMeta(c.req.raw, c.get("ctx").env);
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

      // The workspace's own captcha config (any of three providers, its own
      // encrypted secret) SUPERSEDES the deployment-level Turnstile keys when
      // it covers forms — running both would put two challenges in front of
      // one submit. `enforceCaptcha` is a no-op when the workspace has not
      // configured one, so the legacy path below still runs for everyone else.
      const workspaceCaptcha = form.tenantId
        ? await loadCaptchaConfig(ctx, form.tenantId)
        : null;
      const captchaCoversForms =
        Boolean(workspaceCaptcha?.enabled) && Boolean(workspaceCaptcha?.protect.includes("forms"));
      if (captchaCoversForms) {
        try {
          await enforceCaptcha(
            ctx,
            form.tenantId,
            "forms",
            body.captchaToken ?? body.turnstileToken ?? null,
            meta.ip,
          );
        } catch (e) {
          await recordFormBlocked(ctx, form.id);
          throw e;
        }
      } else if (settings.turnstile) {
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
      assertChoices(form, collection, data);

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
        // A public submitter has no read path to the record — the response
        // below deliberately withholds even its id. Empty, not `null`: `null`
        // means unrestricted.
        readFields: new Set<string>(),
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
          // Unrestricted, deliberately. A public form submission is not made by
          // a principal holding a role, so there is no permission condition to
          // judge it against — the form's own `exposed` field list IS the
          // authority here, and it is passed on the line above. Stating `null`
          // rather than inheriting it is the point of the field being required.
          conditions: null,
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
      // The half-filled copy has served its purpose — and it is the same
      // personal data as the row that just landed, kept where nothing reads it.
      if (settings.saveProgress) {
        const keyHash = await resolveDraftKey(
          c,
          form,
          body.invite ?? c.req.query("i") ?? null,
          { mint: false },
        );
        if (keyHash) await deleteFormDraft(ctx, form.id, keyHash);
      }

      // The row id stays private — a public submitter has no read path to the
      // record, so leaking its id would only aid enumeration.
      return c.json({ data: { id: null, ...success } }, 201);
    },
  );
