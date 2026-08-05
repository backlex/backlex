/**
 * Named KPI definitions — CRUD plus evaluation.
 *
 * The two halves are deliberately gated differently:
 *
 *   - Writing a definition is admin-only. A KPI decides what a number MEANS
 *     across every dashboard, report and AI answer in the workspace, so editing
 *     one is a schema-shaped act, not a reporting one.
 *   - Running a KPI only needs a session. The evaluation is clamped to the
 *     caller's own read permission inside `runKpiForCaller`, so the same
 *     definition returns each reader the total of the rows they could have
 *     listed for themselves — the tile on a page is not a way around a
 *     row-level condition.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  KPI_DIRECTIONS,
  KPI_FORMATS,
  createKpi,
  deleteKpi,
  listKpis,
  requireKpi,
  runKpiForCaller,
  updateKpi,
} from "../services/kpis";
import { ITEMS_AGG_FUNCS } from "../services/items/aggregate";

const KpiBase = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .describe("Stable handle panels and AI tool calls reference this KPI by"),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  collection: z.string().min(1).max(120),
  agg: z.enum(ITEMS_AGG_FUNCS),
  field: z.string().max(120).nullable().optional(),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  dateField: z
    .string()
    .max(120)
    .nullable()
    .optional()
    .describe("Timestamp column the period window applies to. Null = no period comparison."),
  groupBy: z.string().max(120).nullable().optional(),
  topN: z.number().int().positive().max(200).nullable().optional(),
  format: z.enum(KPI_FORMATS),
  unit: z.string().max(40).nullable().optional(),
  decimals: z.number().int().min(0).max(6).nullable().optional(),
  direction: z.enum(KPI_DIRECTIONS),
});

const KpiInput = KpiBase.extend({
  agg: z.enum(ITEMS_AGG_FUNCS).default("count"),
  format: z.enum(KPI_FORMATS).default("number"),
  direction: z.enum(KPI_DIRECTIONS).default("neutral"),
}).openapi("KpiInput");

// PATCH must NOT reuse KpiInput: `.default()` survives `.partial()`, so an
// update that omits `format`/`direction` would silently reset them to the
// create-time defaults. (The identical trap already cost `saved_panels` its
// `viz` values on a dashboard move — see routes/panels.ts.)
const KpiPatch = KpiBase.partial().openapi("KpiPatchInput");

const KpiRowSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    collection: z.string(),
    agg: z.string(),
    field: z.string().nullable(),
    filter: z.unknown().nullable(),
    dateField: z.string().nullable(),
    groupBy: z.string().nullable(),
    topN: z.number().nullable(),
    format: z.string(),
    unit: z.string().nullable(),
    decimals: z.number().nullable(),
    direction: z.string(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("Kpi");

const KpiPointSchema = z.object({
  label: z.string().optional(),
  value: z.number().nullable(),
  previousValue: z.number().nullable(),
  delta: z.number().nullable(),
  deltaPct: z.number().nullable(),
  currency: z.string().nullable().optional(),
});

const WindowSchema = z.object({ from: z.number(), to: z.number() });

const KpiResultSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    collection: z.string(),
    format: z.string(),
    unit: z.string().nullable(),
    decimals: z.number().nullable(),
    direction: z.string(),
    groupBy: z.string().nullable(),
    window: WindowSchema.nullable(),
    previousWindow: WindowSchema.nullable(),
    point: KpiPointSchema.nullable(),
    rows: z.array(KpiPointSchema).nullable(),
    computedAt: z.number(),
  })
  .openapi("KpiResult");

/** Window params shared by the single-run and batch-run endpoints. `from`/`to`
 *  are epoch ms; `rangeDays` is the friendlier form the admin UI sends. */
const RunQuery = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  rangeDays: z.coerce.number().int().positive().max(3650).optional(),
});

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

const TAGS = ["kpis"];
const ADMIN_GATE = [requireUser, requireAdminMiddleware];
const READ_GATE = [requireUser];

export const kpisRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List KPI definitions",
      description:
        "Every named KPI in the active workspace. Definitions only — call `/{ref}/run` to evaluate one.",
      security: SECURITY,
      middleware: READ_GATE,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(KpiRowSchema) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const rows = await listKpis(ctx, tenantId);
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create a KPI definition",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: KpiInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: KpiRowSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const row = await createKpi(ctx, auth, tenantId, c.req.valid("json"));
      return c.json({ data: row }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{ref}",
      tags: TAGS,
      summary: "Get a KPI definition",
      description: "`ref` is the KPI's slug or its id.",
      security: SECURITY,
      middleware: READ_GATE,
      request: { params: z.object({ ref: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: KpiRowSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const row = await requireKpi(ctx, tenantId, c.req.valid("param").ref);
      return c.json({ data: row });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: TAGS,
      summary: "Update a KPI definition",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: KpiPatch } } },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: KpiRowSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const row = await updateKpi(
        ctx,
        tenantId,
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json({ data: row });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Delete a KPI definition",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      await deleteKpi(ctx, tenantId, c.req.valid("param").id);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{ref}/run",
      tags: TAGS,
      summary: "Evaluate a KPI",
      description:
        "Runs the definition over the requested window and the window immediately before it. " +
        "Scoped to the caller's own read permission on the KPI's collection, so the figure " +
        "matches what that caller could list. A KPI with no `dateField` returns a running " +
        "total and a null `window`/`previousWindow` rather than a fabricated comparison.",
      security: SECURITY,
      middleware: READ_GATE,
      request: { params: z.object({ ref: z.string() }), query: RunQuery },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: KpiResultSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const kpi = await requireKpi(ctx, tenantId, c.req.valid("param").ref);
      const data = await runKpiForCaller(
        ctx,
        auth,
        tenantId,
        kpi,
        c.req.valid("query"),
      );
      return c.json({ data });
    },
  );
