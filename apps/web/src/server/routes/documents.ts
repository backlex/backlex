import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  deleteTemplate,
  listTemplates,
  renderDocument,
  upsertTemplate,
} from "../services/documents";

/**
 * Document templates, and rendering one.
 *
 * Admin-only throughout. A template is executable content — it is interpolated
 * and handed to a browser — so authoring it is the same trust level as authoring
 * a flow, not a content-editor permission.
 */

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const PageOptions = z
  .object({
    format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).optional(),
    landscape: z.boolean().optional(),
    margin: z
      .union([
        z.string(),
        z.object({
          top: z.string().optional(),
          right: z.string().optional(),
          bottom: z.string().optional(),
          left: z.string().optional(),
        }),
      ])
      .optional(),
    printBackground: z.boolean().optional(),
  })
  .openapi("PdfPageOptions");

const TemplateInput = z
  .object({
    key: z.string().min(1).max(200),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullish(),
    bodyHtml: z.string().optional(),
    headerHtml: z.string().nullish(),
    footerHtml: z.string().nullish(),
    pageOptions: PageOptions.nullish(),
    filename: z.string().max(200).nullish(),
    variables: z.array(z.string()).nullish(),
  })
  .openapi("DocumentTemplateInput");

const TemplateView = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    bodyHtml: z.string(),
    headerHtml: z.string().nullable(),
    footerHtml: z.string().nullable(),
    pageOptions: z.unknown(),
    filename: z.string().nullable(),
    variables: z.array(z.string()),
    inherited: z.boolean(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("DocumentTemplate");

const RenderInput = z
  .object({
    templateKey: z.string().min(1).max(200).optional(),
    html: z.string().min(1).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    pageOptions: PageOptions.optional(),
    filename: z.string().max(200).optional(),
  })
  .refine((v) => (v.templateKey == null) !== (v.html == null), {
    message: "Provide exactly one of templateKey or html",
  })
  .openapi("DocumentRenderInput");

const tags = ["documents"];

const tenantOf = (c: { get: (k: string) => any }): string | null =>
  (c.get("auth")?.tenantId as string | undefined) ?? null;

export const documentsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/templates",
      tags,
      summary: "List document templates",
      description:
        "Admin-only. A workspace's own template hides the instance-wide default with the same key.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(TemplateView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listTemplates(c.get("ctx"), tenantOf(c)) }),
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/templates/{key}",
      tags,
      summary: "Create or update a document template",
      description:
        "Admin-only. Always writes a row scoped to the active workspace — editing an inherited default creates an override rather than changing what other workspaces render.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string() }),
        body: { content: { "application/json": { schema: TemplateInput.omit({ key: true }) } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: TemplateView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { key } = c.req.valid("param");
      const body = c.req.valid("json");
      const auth = c.get("auth");
      const data = await upsertTemplate(
        c.get("ctx"),
        tenantOf(c),
        { key, ...body, pageOptions: body.pageOptions ?? null },
        auth?.userId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/templates/{key}",
      tags,
      summary: "Delete a document template",
      description:
        "Admin-only. Removes the workspace's own row; an inherited default is not deletable from inside a workspace.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ key: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      await deleteTemplate(c.get("ctx"), tenantOf(c), c.req.valid("param").key);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/render",
      tags,
      summary: "Render a document to PDF",
      description:
        "Admin-only. Returns the PDF bytes. Refuses with 422 when no renderer is configured — there is deliberately no fallback that would produce a document with broken glyphs.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { content: { "application/json": { schema: RenderInput } } } },
      responses: {
        200: {
          description: "The rendered PDF",
          content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const out = await renderDocument(c.get("ctx"), tenantOf(c), body);
      return c.body(out.bytes as unknown as ArrayBuffer, 200, {
        "content-type": out.contentType,
        // `inline` so a preview opens in the browser rather than downloading;
        // the filename still applies if the viewer saves it.
        "content-disposition": `inline; filename="${out.filename}"`,
        "x-backlex-renderer": out.renderer,
      });
    },
  );
