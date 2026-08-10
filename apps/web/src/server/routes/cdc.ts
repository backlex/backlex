/**
 * CDC sinks — admin CRUD. Mounted at `/api/admin/cdc-sinks`.
 *
 * `run` exists so an operator can see a sink work without waiting for a tick,
 * and it goes through the SAME code the cron does — a "test" path that
 * delivered differently would be testing something else.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  CDC_DESTINATIONS,
  createCdcSink,
  deleteCdcSink,
  listCdcSinks,
  runCdcSinkNow,
  updateCdcSink,
  type CdcSinkInput,
} from "../services/cdc";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const View = z
  .object({
    id: z.string(),
    name: z.string(),
    collection: z.string(),
    destination: z.enum(CDC_DESTINATIONS),
    config: z.record(z.string(), z.unknown()),
    shape: z.string().nullable(),
    fields: z.string().nullable(),
    batchSize: z.number(),
    enabled: z.boolean(),
    cursor: z.string().nullable(),
    lastRunAt: z.number().nullable(),
    lastError: z.string().nullable(),
    consecutiveFailures: z.number(),
    disabledReason: z.string().nullable(),
  })
  .openapi("CdcSink");

const Input = z
  .object({
    name: z.string().min(1).max(120),
    collection: z.string().min(1),
    destination: z.enum(CDC_DESTINATIONS).openapi({
      description:
        "`webhook` — POST each batch to a URL, signed with Standard Webhooks when a secret is set. " +
        "`storage` — write NDJSON objects into this workspace's own bucket, where the S3 endpoint " +
        "can read them.",
    }),
    config: z.record(z.string(), z.unknown()).openapi({
      description: "`{ url, secret?, headers? }` for a webhook; `{ prefix? }` for storage.",
    }),
    shape: z.string().nullish().openapi({
      description:
        "A flat filter naming the subset to replicate — the same grammar the changefeed takes. " +
        "This is the only narrowing knob: a sink reads unconditionally, so what it replicates is " +
        "a property of the sink rather than of whoever created it.",
    }),
    fields: z.string().nullish(),
    batchSize: z.number().int().min(1).max(500).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("CdcSinkInput");

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

const tags = ["cdc"];

export const cdcRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List CDC sinks",
      description: "Signing secrets are reported as present, never returned.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(View) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listCdcSinks(c.get("ctx"), requireTenant(c)) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create a CDC sink",
      description:
        "Starts from the beginning of the collection and catches up one page per tick. Delivery is " +
        "at-least-once: the cursor advances only after a batch is acknowledged, so a retry re-sends " +
        "the batch — every record carries a stable `key` for the destination to deduplicate on.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: Input } } } },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const data = await createCdcSink(
        c.get("ctx"),
        requireTenant(c),
        c.req.valid("json") as CdcSinkInput,
      );
      await logActivity(c, {
        action: "create",
        collection: "system_cdc_sinks",
        itemId: data.id,
        payload: { collection: data.collection, destination: data.destination },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update a CDC sink",
      description:
        "Omit `config.secret` to keep the stored one. Re-enabling clears the failure counter, or " +
        "the breaker would trip again immediately. `resetCursor` replays the collection from the " +
        "beginning — the one operation here that can flood a destination, so it is explicit.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: Input.partial().extend({ resetCursor: z.boolean().optional() }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = await updateCdcSink(
        c.get("ctx"),
        requireTenant(c),
        id,
        c.req.valid("json") as never,
      );
      await logActivity(c, { action: "update", collection: "system_cdc_sinks", itemId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/run",
      tags,
      summary: "Advance a sink by one page now",
      description:
        "The same code the cron tick runs. Reports what it delivered, or the delivery error — " +
        "which is how a misconfigured destination is found here rather than by a silent failure " +
        "counter climbing overnight.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Ran",
          content: {
            "application/json": {
              schema: z.object({
                delivered: z.number(),
                cursor: z.string().nullable(),
                hasMore: z.boolean(),
                error: z.string().optional(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await runCdcSinkNow(c.get("ctx"), requireTenant(c), id));
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete a CDC sink",
      description: "The destination keeps whatever it already received.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await deleteCdcSink(c.get("ctx"), requireTenant(c), id);
      await logActivity(c, { action: "delete", collection: "system_cdc_sinks", itemId: id });
      return c.json({ ok: true });
    },
  );
