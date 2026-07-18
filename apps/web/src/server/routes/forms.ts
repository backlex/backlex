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
  rotateFormToken,
  updateForm,
  type FormRow,
} from "../services/forms";

const TAGS = ["forms"];

const FormBlockI18nSchema = z.object({
  label: z.string().max(300).optional(),
  placeholder: z.string().max(300).optional(),
  help: z.string().max(500).optional(),
});

const FormBlockSchema = z
  .object({
    id: z.string().max(40).optional(),
    /** "field" (default) or the "step" page break. */
    kind: z.enum(["field", "step"]).optional(),
    name: z.string().min(1).optional(),
    label: z.string().max(300).optional(),
    placeholder: z.string().max(300).optional(),
    help: z.string().max(500).optional(),
    rating: z.boolean().optional(),
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
