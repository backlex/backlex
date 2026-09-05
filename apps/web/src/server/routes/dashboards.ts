import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  revokeDashboardEmbed,
  runDashboard,
  shareDashboard,
  updateDashboard,
} from "../services/dashboards";
import { deliverReport } from "../services/reports";

const DashboardInput = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().optional(),
    layout: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("DashboardInput");

const DashboardRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    layout: z.unknown().nullable(),
    embedEnabled: z.boolean(),
    embedRoleId: z.string().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("Dashboard");

const ShareInput = z
  .object({ roleId: z.string().nullable().optional() })
  .openapi("DashboardShareInput");

const ShareResult = z
  .object({ token: z.string(), url: z.string() })
  .openapi("DashboardShareResult");

const RunResult = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  ms: z.number().int().nonnegative(),
});

const ReportInput = z
  .object({
    filename: z.string().max(200).optional(),
    pageOptions: z
      .object({
        format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).optional(),
        landscape: z.boolean().optional(),
        printBackground: z.boolean().optional(),
      })
      .optional(),
    email: z
      .object({
        /** One address or a comma-separated list. Validated in the service. */
        to: z.string().min(1).max(2000),
        subject: z.string().min(1).max(300).optional(),
        templateKey: z.string().min(1).max(200).optional(),
      })
      .optional(),
    /** Stream the PDF back instead of the metadata — the admin's own button. */
    download: z.boolean().optional(),
  })
  .openapi("DashboardReportInput");

const ReportResult = z
  .object({
    key: z.string(),
    filename: z.string(),
    size: z.number().int().nonnegative(),
    renderer: z.string(),
    dashboard: z.object({ id: z.string(), name: z.string() }),
    panels: z.number().int().nonnegative(),
    failedPanels: z.number().int().nonnegative(),
    sentTo: z.array(z.string()),
    attachmentsDropped: z.boolean().optional(),
  })
  .openapi("DashboardReport");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

/** Strip the token hash off a row before returning it to the admin client. */
const publicRow = (row: any) => ({
  id: row.id,
  tenantId: row.tenantId,
  name: row.name,
  description: row.description,
  layout: row.layout ?? null,
  embedEnabled: Boolean(row.embedEnabled),
  embedRoleId: row.embedRoleId ?? null,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const TAGS = ["dashboards"];
const ADMIN_GATE = [requireUser, requireAdminMiddleware];

export const dashboardsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List dashboards",
      description:
        "Dashboards for the active workspace plus the system-global (`tenantId IS NULL`) ones.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(DashboardRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const rows = await listDashboards(ctx, tenantId);
      return c.json({ data: rows.map(publicRow) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create dashboard",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: DashboardInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: DashboardRow }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const row = await createDashboard(ctx, auth, tenantId, body);
      return c.json({ data: publicRow(row) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: TAGS,
      summary: "Get dashboard",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: DashboardRow }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const row = await getDashboard(ctx, tenantId, id);
      if (!row) throw new AppError("NOT_FOUND", "Dashboard not found");
      return c.json({ data: publicRow(row) });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: TAGS,
      summary: "Update dashboard",
      description: "Partial update.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: DashboardInput.partial() } },
        },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await updateDashboard(ctx, auth, tenantId, id, body);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Delete dashboard",
      description: "Idempotent. Panels are un-grouped, not deleted.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await deleteDashboard(ctx, auth, tenantId, id);
      return c.json({ ok: true });
    },
  )
  /** Publish the dashboard to a public embed URL — returns the one-time token. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/share",
      tags: TAGS,
      summary: "Enable the public embed",
      description:
        "Mints a fresh embed token (rotating any prior one). Optionally scope panel data to a role via `roleId`.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: false, content: { "application/json": { schema: ShareInput } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: ShareResult } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = (c.req.valid("json") ?? {}) as { roleId?: string | null };
      const out = await shareDashboard(ctx, auth, tenantId, id, { roleId: body.roleId ?? null });
      return c.json(out);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/share",
      tags: TAGS,
      summary: "Disable the public embed",
      description: "Idempotent — forgets the token.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Revoked", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await revokeDashboardEmbed(ctx, auth, tenantId, id);
      return c.json({ ok: true });
    },
  )
  /** Run every panel in the dashboard with the caller's identity. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/run",
      tags: TAGS,
      summary: "Run a dashboard",
      description: "Executes every panel and returns their results.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: RunResult } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const dash = await getDashboard(ctx, tenantId, id);
      if (!dash) throw new AppError("NOT_FOUND", "Dashboard not found");
      const t0 = Date.now();
      const data = await runDashboard(ctx, auth, tenantId, id);
      return c.json({ data, ms: Date.now() - t0 });
    },
  )
  /**
   * Print the dashboard, and optionally mail it.
   *
   * Two response shapes off one service call. `download` streams the PDF back
   * for the admin's own button; the default returns the stored key + what
   * happened, which is what a script or a scheduled caller needs. Mailing is
   * refused on the download shape rather than silently ignored — a request that
   * asked for both has one of the two intents wrong.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/report",
      tags: TAGS,
      summary: "Render a dashboard as a PDF report",
      description:
        "Runs every panel, prints the dashboard to a PDF and stores it. With `email` the PDF is also " +
        "mailed, one message per recipient. With `download` the bytes come back instead of the metadata. " +
        "Refuses with 422 when no PDF renderer is configured.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: ReportInput } } },
      },
      responses: {
        200: {
          description: "The stored report, or the PDF bytes when `download` is set",
          content: {
            "application/json": { schema: ReportResult },
            "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.download && body.email) {
        throw new AppError("VALIDATION", "A report is either downloaded or mailed, not both");
      }
      const out = await deliverReport(ctx, auth, tenantId, {
        dashboardId: id,
        ...(body.filename ? { filename: body.filename } : {}),
        ...(body.pageOptions ? { pageOptions: body.pageOptions } : {}),
        ...(body.email ? { email: body.email } : {}),
      });
      if (!body.download) return c.json(out);
      const object = await ctx.storage.get(out.key);
      if (!object) throw new AppError("INTERNAL", "The report was rendered but is not in storage");
      return c.body(object.body as unknown as ReadableStream, 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${out.filename}"`,
        "x-backlex-renderer": out.renderer,
      });
    },
  );
