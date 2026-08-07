import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import { getChoices } from "@backlex/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { loadCollection } from "../services/items/collection-loader";
import {
  createForm,
  deleteForm,
  formEligibleFields,
  getForm,
  listForms,
  MATRIX_MAX_ROWS,
  rotateFormToken,
  updateForm,
  type FormRow,
} from "../services/forms";
import { formResults } from "../services/forms-results";
import {
  createFormInvites,
  deleteFormInvite,
  listFormInvites,
  markInviteSent,
  MAX_INVITES_PER_CALL,
  type FormInviteRow,
  type MintedInvite,
} from "../services/form-invites";
import { sendTemplatedEmail } from "../services/email";
import { escapeHtml } from "../services/signatures";

const TAGS = ["forms"];

const FormBlockI18nSchema = z.object({
  label: z.string().max(300).optional(),
  placeholder: z.string().max(300).optional(),
  help: z.string().max(500).optional(),
});

const FormBlockSchema = z
  .object({
    id: z.string().max(40).optional(),
    /** "field" (default), the "step" page break, or the "matrix" grid. */
    kind: z.enum(["field", "step", "matrix"]).optional(),
    name: z.string().min(1).optional(),
    label: z.string().max(300).optional(),
    placeholder: z.string().max(300).optional(),
    help: z.string().max(500).optional(),
    /** @deprecated Superseded by `scale` — still accepted and still renders. */
    rating: z.boolean().optional(),
    /** Integer fields only: answer by picking a point on a row (stars / a
     *  numbered row / the 0–10 NPS row). Bounds are re-checked at submit. */
    scale: z
      .object({
        min: z.number().int().min(-1000).max(1000),
        max: z.number().int().min(-1000).max(1000),
        style: z.enum(["stars", "number", "nps"]),
        minLabel: z.string().max(80).optional(),
        maxLabel: z.string().max(80).optional(),
      })
      .optional(),
    /** Matrix blocks: the statements the grid asks. Their fields must all be
     *  integer (answered on the block's shared `scale`) or all offer the same
     *  choices in the same order — re-checked when the form is saved. */
    rows: z
      .array(
        z.object({
          name: z.string().min(1),
          label: z.string().max(300).optional(),
          i18n: z.record(z.string(), FormBlockI18nSchema).optional(),
        }),
      )
      .max(MATRIX_MAX_ROWS)
      .optional(),
    consent: z.boolean().optional(),
    policyUrl: z.string().url().max(2000).optional(),
    /** File blocks: MIME allow-list (`image/*`, exact types) + byte cap. The
     *  env ceiling (`FORM_UPLOAD_MAX_BYTES`) clamps `maxBytes` at upload time. */
    accept: z.array(z.string().min(3).max(80)).max(20).optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024 * 1024)
      .optional(),
    cond: z
      .object({
        field: z.string().min(1),
        op: z.enum(["is", "is_not"]),
        value: z.string().max(300),
      })
      .optional(),
    i18n: z.record(z.string(), FormBlockI18nSchema).optional(),
  })
  .openapi("FormBlock");

const FormI18nSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  submitLabel: z.string().max(80).optional(),
  successMessage: z.string().max(1000).optional(),
});

const FormSettingsSchema = z
  .object({
    description: z.string().max(1000).optional(),
    submitLabel: z.string().max(80).optional(),
    successMessage: z.string().max(1000).optional(),
    redirectUrl: z.string().url().max(2000).optional(),
    turnstile: z.boolean().optional(),
    theme: z.enum(["dark", "light"]).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    font: z.enum(["sans", "lexend", "mono", "system"]).optional(),
    languages: z.array(z.string().min(2).max(8)).max(12).optional(),
    i18n: z.record(z.string(), FormI18nSchema).optional(),
    /** Epoch ms. Before `opensAt` and from `closesAt` on, the public page
     *  renders `closedMessage` instead of the questions and submits are 410. */
    opensAt: z.number().int().nonnegative().optional(),
    closesAt: z.number().int().nonnegative().optional(),
    /** Stop accepting once this many submissions have been accepted. */
    maxResponses: z.number().int().positive().max(10_000_000).optional(),
    /** One answer per browser (a cookie, not an identity — see docs). */
    onePerBrowser: z.boolean().optional(),
    /** Only a visitor holding an unspent invite may answer. */
    inviteOnly: z.boolean().optional(),
    /** Keep half-filled answers so a visitor can come back to them. */
    saveProgress: z.boolean().optional(),
    closedMessage: z.string().max(1000).optional(),
  })
  .openapi("FormSettings");

const FormInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    collection: z.string().min(1),
    fields: z.array(FormBlockSchema).min(1).max(100),
    settings: FormSettingsSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .openapi("FormInput");

const FormPatchSchema = FormInputSchema.partial().openapi("FormPatch");

const FormRowSchema = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    collection: z.string(),
    fields: z.array(FormBlockSchema),
    settings: FormSettingsSchema.nullable(),
    active: z.boolean(),
    submissionCount: z.number(),
    blockedCount: z.number(),
    lastSubmissionAt: z.unknown().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("Form");

const CreatedForm = z
  .object({
    form: FormRowSchema,
    /** One-time plaintext token — never returned again. */
    token: z.string(),
    /** Relative public URLs; the client builds absolute ones from its origin. */
    url: z.string(),
    embedUrl: z.string(),
  })
  .openapi("CreatedForm");

const RotatedToken = z
  .object({ token: z.string(), url: z.string(), embedUrl: z.string() })
  .openapi("FormRotatedToken");

const EligibleField = z
  .object({
    name: z.string(),
    type: z.string(),
    label: z.string().nullable(),
    required: z.boolean(),
    /** Dropdown choice values, when the field defines them (canvas preview). */
    choices: z.array(z.string()).nullable(),
    /** email/url format hint from the field's validation rules. */
    format: z.string().nullable(),
  })
  .openapi("FormEligibleField");

const FormResultBlockSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    type: z.string(),
    kind: z.enum([
      "choice",
      "multi_choice",
      "scale",
      "boolean",
      "number",
      "text",
      "timestamp",
      "file",
    ]),
    answered: z.number(),
    buckets: z
      .array(z.object({ value: z.string(), label: z.string(), count: z.number() }))
      .nullable(),
    average: z.number().nullable(),
    nps: z
      .object({
        promoters: z.number(),
        passives: z.number(),
        detractors: z.number(),
        score: z.number(),
      })
      .nullable(),
    /** Set when the question is one row of a matrix — blocks sharing an `id`
     *  were asked under one heading. */
    matrix: z.object({ id: z.string(), label: z.string() }).nullable(),
  })
  .openapi("FormResultBlock");

const FormResultsSchema = z
  .object({
    formId: z.string(),
    collection: z.string(),
    rows: z.number(),
    submissionCount: z.number(),
    blockedCount: z.number(),
    /** Half-filled forms saved but not submitted (0 unless `saveProgress`). */
    inProgress: z.number(),
    lastSubmissionAt: z.unknown().nullable(),
    blocks: z.array(FormResultBlockSchema),
    truncated: z.number(),
  })
  .openapi("FormResults");

const InviteSchema = z
  .object({
    id: z.string(),
    formId: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    sentAt: z.unknown().nullable(),
    usedAt: z.unknown().nullable(),
    createdAt: z.unknown().nullable(),
  })
  .openapi("FormInvite");

const MintedInviteSchema = InviteSchema.extend({
  /** One-time plaintext token — never returned again. */
  token: z.string(),
  /** Relative link, empty when the caller didn't supply the form's own token
   *  (which is itself only held for a moment after create/rotate). */
  url: z.string(),
}).openapi("MintedFormInvite");

const InviteInput = z
  .object({
    recipients: z
      .array(
        z.object({
          email: z.string().email().max(320).optional(),
          name: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(MAX_INVITES_PER_CALL),
    /** The form's own plaintext token, so the response can carry ready-made
     *  links. Held by the caller from create/rotate; never stored. */
    formToken: z.string().max(120).optional(),
    /** Email each recipient their link. Needs an address and a configured
     *  transport; recipients without one are minted and simply not mailed. */
    send: z.boolean().optional(),
  })
  .openapi("FormInviteInput");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

/** Token never leaves list/detail responses — only create/rotate return it. */
const serializeForm = (row: FormRow) => ({
  id: row.id,
  tenantId: row.tenantId,
  name: row.name,
  collection: row.collection,
  fields: row.fields,
  settings: row.settings,
  active: row.active,
  submissionCount: row.submissionCount,
  blockedCount: row.blockedCount,
  lastSubmissionAt: row.lastSubmissionAt,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The invite shape every read surface hands out — no token, no hash. */
const serializeInvite = (row: FormInviteRow) => ({
  id: row.id,
  formId: row.formId,
  email: row.email,
  name: row.name,
  sentAt: row.sentAt,
  usedAt: row.usedAt,
  createdAt: row.createdAt,
});

/** …plus the one-time token, which only the mint response carries. */
const serializeMintedInvite = (row: MintedInvite) => ({
  ...serializeInvite(row),
  token: row.token,
  url: row.url,
});

const publicUrls = (token: string) => ({
  url: `/f/${token}`,
  embedUrl: `/embed/f/${token}`,
});

/**
 * Admin CRUD for public forms. Mounted at `/api/admin/forms`, admin-gated
 * (mirrors `routes/dashboards.ts`). The plaintext token is returned exactly
 * once (create / rotate); list and detail responses never expose it or its
 * hash.
 */
export const formsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List forms",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(FormRowSchema) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const rows = await listForms(ctx, auth.tenantId ?? null);
      return c.json({ data: rows.map(serializeForm) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/eligible-fields/{collection}",
      tags: TAGS,
      summary: "List a collection's form-eligible fields",
      description:
        "Only scalar, non-private, non-computed, non-localized fields can be exposed on a public form. The builder UI uses this to offer the field picker.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ collection: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(EligibleField) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const collection = await loadCollection(
        ctx,
        auth.tenantId,
        c.req.valid("param").collection,
      );
      const data = formEligibleFields(collection).map((f) => {
        const choices = getChoices(f).map((ch) => ch.value);
        return {
          name: f.name,
          type: f.type,
          label: f.label ?? null,
          required: Boolean(f.required),
          choices: choices.length > 0 ? choices : null,
          format: f.validation?.format ?? null,
        };
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create a form",
      description:
        "Returns the one-time plaintext token plus the public `/f/<token>` and `/embed/f/<token>` URLs.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: FormInputSchema } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: CreatedForm }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const input = c.req.valid("json");
      const { row, token } = await createForm(ctx, {
        ...input,
        tenantId: auth.tenantId ?? null,
        createdBy: auth.userId,
      });
      return c.json(
        { data: { form: serializeForm(row), token, ...publicUrls(token) } },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: TAGS,
      summary: "Get a form",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: FormRowSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const row = await getForm(ctx, auth.tenantId ?? null, c.req.valid("param").id);
      if (!row) throw new AppError("NOT_FOUND", "Form not found");
      return c.json({ data: serializeForm(row) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/invites",
      tags: TAGS,
      summary: "List a form's invites",
      description:
        "Who was invited, whether their mail went out, and whether they have answered. Tokens are never listed — a lost link is re-minted, not recovered.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(InviteSchema) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? null;
      const row = await getForm(ctx, tenantId, c.req.valid("param").id);
      if (!row) throw new AppError("NOT_FOUND", "Form not found");
      const data = await listFormInvites(ctx, tenantId, row.id);
      return c.json({ data: data.map(serializeInvite) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/invites",
      tags: TAGS,
      summary: "Invite people to answer a form",
      description:
        "Mints one single-use link per recipient. The plaintext tokens are in THIS response and nowhere else. Pass `formToken` (held from create/rotate) to get ready-made links back, and `send: true` to email them.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: InviteInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  invites: z.array(MintedInviteSchema),
                  /** How many were emailed — less than the count when a
                   *  recipient had no address or the transport refused. */
                  sent: z.number(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? null;
      const input = c.req.valid("json");
      const row = await getForm(ctx, tenantId, c.req.valid("param").id);
      if (!row) throw new AppError("NOT_FOUND", "Form not found");

      const minted = await createFormInvites(
        ctx,
        tenantId,
        row,
        input.formToken ?? null,
        input.recipients,
      );

      let sent = 0;
      if (input.send) {
        const origin = ctx.env.APP_URL?.replace(/\/$/, "") ?? "";
        for (const invite of minted) {
          if (!invite.email || !invite.url) continue;
          try {
            await sendTemplatedEmail(ctx, {
              to: invite.email,
              templateKey: "form_invite",
              tenantId,
              vars: {
                form: row.name,
                url: `${origin}${invite.url}`,
                recipient: { email: invite.email, name: invite.name ?? "" },
              },
              fallback: {
                subject: `You're invited: ${row.name}`,
                // Escaped: the form name and the recipient name are operator
                // input, and this body is delivered to a third party. Same
                // discipline as the approval mailer.
                html:
                  `<p>${escapeHtml(invite.name || invite.email)},</p>` +
                  `<p>You've been invited to answer <strong>${escapeHtml(row.name)}</strong>.</p>` +
                  `<p><a href="${escapeHtml(`${origin}${invite.url}`)}">Answer the form</a></p>` +
                  `<p>This link works once and is yours alone.</p>`,
              },
            });
            await markInviteSent(ctx, invite.id);
            sent++;
          } catch {
            // A transport that refuses one address must not lose the other
            // links — they were already minted and are in this response.
          }
        }
      }

      return c.json({ data: { invites: minted.map(serializeMintedInvite), sent } }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/invites/{inviteId}",
      tags: TAGS,
      summary: "Revoke an invite",
      description: "The link stops working immediately, answered or not.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ id: z.string(), inviteId: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? null;
      const { id, inviteId } = c.req.valid("param");
      const row = await getForm(ctx, tenantId, id);
      if (!row) throw new AppError("NOT_FOUND", "Form not found");
      await deleteFormInvite(ctx, tenantId, row.id, inviteId);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/results",
      tags: TAGS,
      summary: "Summarise a form's answers",
      description:
        "One distribution per exposed question — choice counts in the schema's own order, a scale's points with its mean, an NPS score, and how many rows answered at all. Free-text answers are counted, never quoted: read those through `/api/items/{collection}`, which applies the collection's own permissions. Counts cover the whole target collection, not only rows this form wrote.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: FormResultsSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const row = await getForm(ctx, auth.tenantId ?? null, c.req.valid("param").id);
      if (!row) throw new AppError("NOT_FOUND", "Form not found");
      // The aggregates are tenant-scoped SQL, so an active tenant is required
      // even though the form row itself may be a platform-level one.
      if (!auth.tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
      const data = await formResults(ctx, auth, auth.tenantId, row);
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: TAGS,
      summary: "Update a form",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: FormPatchSchema } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: FormRowSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const row = await updateForm(
        ctx,
        auth.tenantId ?? null,
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json({ data: serializeForm(row) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/rotate-token",
      tags: TAGS,
      summary: "Rotate a form's public token",
      description:
        "Invalidates the previous token immediately and returns the new one-time plaintext token.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Rotated",
          content: { "application/json": { schema: z.object({ data: RotatedToken }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { token } = await rotateFormToken(
        ctx,
        auth.tenantId ?? null,
        c.req.valid("param").id,
      );
      return c.json({ data: { token, ...publicUrls(token) } });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Delete a form",
      security: SECURITY,
      middleware: [requireUser, requireAdminMiddleware],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      await deleteForm(ctx, auth.tenantId ?? null, c.req.valid("param").id);
      return c.json({ ok: true });
    },
  );
