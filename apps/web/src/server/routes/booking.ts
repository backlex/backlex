import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  BOOKING_STATUSES,
  MAX_QUESTIONS,
  MAX_RULES_PER_RESOURCE,
  cancelBooking,
  confirmBooking,
  createBooking,
  createResource,
  deleteResource,
  getBooking,
  getResource,
  listBookings,
  listResources,
  listSlots,
  loadResource,
  markNoShow,
  rescheduleBooking,
  resolveBookingById,
  rotateResourceToken,
  updateResource,
  type BookingStatus,
} from "../services/booking";

/**
 * Availability and bookings, from the operator's side.
 *
 * Admin-only: a resource carries a public, unauthenticated page token, and
 * everything on the row is policy about how much of the workspace's time the
 * outside world may take. The booker's side needs no account and lives in
 * `routes/booking-public.ts`.
 */

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const tags = ["booking"];

const tenantOf = (c: { get: (k: string) => any }): string | null =>
  (c.get("auth")?.tenantId as string | undefined) ?? null;

const requireResource = async (c: any, keyOrId: string) => {
  const row = await loadResource(c.get("ctx"), tenantOf(c), keyOrId);
  if (!row) throw new AppError("NOT_FOUND", "Booking resource not found");
  return row;
};

/* ─────────────────────────────── schemas ────────────────────────────────── */

const RuleView = z
  .object({
    id: z.string(),
    kind: z.enum(["open", "block"]),
    weekday: z.number().nullable(),
    startMinute: z.number(),
    endMinute: z.number(),
    startsOn: z.string().nullable(),
    endsOn: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("BookingRule");

const RuleInput = z
  .object({
    kind: z.enum(["open", "block"]).optional(),
    weekday: z.number().int().min(0).max(6).nullish(),
    // Bounded loosely on purpose. The real rule — `0 <= start < end <= 1440`,
    // and a span crossing midnight is two rules — belongs to the service, which
    // every surface goes through and which can say WHY. A tight `.max(1440)`
    // here would shadow that with "Too big: expected number to be <=1440".
    startMinute: z.number().int().min(0).max(100_000),
    endMinute: z.number().int().min(0).max(100_000),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    reason: z.string().max(200).nullish(),
  })
  .openapi("BookingRuleInput");

const QuestionInput = z
  .object({
    name: z.string().min(1).max(60),
    label: z.string().max(200).optional(),
    type: z.enum(["text", "textarea", "select", "boolean"]).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().max(200)).max(50).optional(),
  })
  .openapi("BookingQuestion");

const ResourceView = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    timeZone: z.string(),
    slotMinutes: z.number(),
    stepMinutes: z.number().nullable(),
    capacity: z.number(),
    bufferBeforeMinutes: z.number(),
    bufferAfterMinutes: z.number(),
    leadMinutes: z.number(),
    horizonDays: z.number(),
    holdMinutes: z.number(),
    questions: z.array(z.record(z.string(), z.unknown())),
    mirrorCollection: z.string().nullable(),
    mirrorFieldMap: z.record(z.string(), z.string()).nullable(),
    active: z.boolean(),
    confirmationMessage: z.string().nullable(),
    notifyEmails: z.array(z.string()),
    rules: z.array(RuleView),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("BookingResource");

const ResourceBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  timeZone: z.string().max(80).optional(),
  slotMinutes: z.number().int().optional(),
  stepMinutes: z.number().int().nullish(),
  capacity: z.number().int().optional(),
  bufferBeforeMinutes: z.number().int().optional(),
  bufferAfterMinutes: z.number().int().optional(),
  leadMinutes: z.number().int().optional(),
  horizonDays: z.number().int().optional(),
  holdMinutes: z.number().int().optional(),
  questions: z.array(QuestionInput).max(MAX_QUESTIONS).optional(),
  mirrorCollection: z.string().max(100).nullish(),
  mirrorFieldMap: z.record(z.string(), z.string()).nullish(),
  active: z.boolean().optional(),
  confirmationMessage: z.string().max(2000).nullish(),
  notifyEmails: z.array(z.string()).max(20).optional(),
  rules: z.array(RuleInput).max(MAX_RULES_PER_RESOURCE).optional(),
});

const CreateResourceBody = ResourceBody.extend({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
}).openapi("CreateBookingResourceInput");

const UpdateResourceBody = ResourceBody.openapi("UpdateBookingResourceInput");

const BookingView = z
  .object({
    id: z.string(),
    resourceId: z.string(),
    start: z.string(),
    end: z.string(),
    status: z.string(),
    storedStatus: z.string(),
    holdExpiresAt: z.number().nullable(),
    customerName: z.string().nullable(),
    customerEmail: z.string().nullable(),
    customerPhone: z.string().nullable(),
    answers: z.record(z.string(), z.unknown()),
    notes: z.string().nullable(),
    mirrorCollection: z.string().nullable(),
    mirrorItemId: z.string().nullable(),
    source: z.string(),
    cancelledAt: z.number().nullable(),
    cancelReason: z.string().nullable(),
    rescheduledToId: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("Booking");

const SlotsView = z
  .object({
    resource: z.object({
      key: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      timeZone: z.string(),
      slotMinutes: z.number(),
      capacity: z.number(),
      questions: z.array(z.record(z.string(), z.unknown())),
      confirmationMessage: z.string().nullable(),
    }),
    from: z.string(),
    to: z.string(),
    slots: z.array(z.object({ start: z.string(), end: z.string(), remaining: z.number() })),
  })
  .openapi("BookingSlots");

const BookBody = z
  .object({
    start: z.union([z.string(), z.number()]),
    end: z.union([z.string(), z.number()]).optional(),
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    phone: z.string().max(50).optional(),
    answers: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(2000).optional(),
    hold: z.boolean().optional(),
  })
  .openapi("CreateBookingInput");

const BookResultView = z
  .object({
    booking: BookingView,
    /** Returned exactly once — only the hash is stored. */
    manageToken: z.string().nullable(),
    manageUrl: z.string().nullable(),
    emailed: z.boolean(),
  })
  .openapi("CreateBookingResult");

/* ──────────────────────────────── routes ────────────────────────────────── */

export const bookingRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/resources",
      tags,
      summary: "List bookable resources",
      description: "Admin-only. Each resource comes with its full rule set — an opening pattern is meaningless without it.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(ResourceView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listResources(c.get("ctx"), tenantOf(c)) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/resources",
      tags,
      summary: "Create a bookable resource",
      description:
        "Admin-only. Mints the public page token and returns it ONCE — only its hash is stored, so this response is the only place the booking URL can be produced.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: CreateResourceBody } } },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  resource: ResourceView,
                  token: z.string(),
                  url: z.string(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const data = await createResource(
        c.get("ctx"),
        tenantOf(c),
        body as Parameters<typeof createResource>[2],
        c.get("auth")?.userId ?? null,
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/resources/{key}",
      tags,
      summary: "Get one resource",
      description: "Admin-only. `key` accepts the resource key or its id.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ key: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: ResourceView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await getResource(c.get("ctx"), tenantOf(c), c.req.valid("param").key) }),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/resources/{key}",
      tags,
      summary: "Update a resource",
      description:
        "Admin-only. Passing `rules` REPLACES the whole rule set — the opening hours are edited as one thing, not row by row.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string() }),
        body: { required: true, content: { "application/json": { schema: UpdateResourceBody } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: ResourceView }) } } },
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({
        data: await updateResource(
          c.get("ctx"),
          tenantOf(c),
          c.req.valid("param").key,
          c.req.valid("json") as Parameters<typeof updateResource>[3],
        ),
      }),
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/resources/{key}",
      tags,
      summary: "Delete a resource",
      description:
        "Admin-only. Refuses while upcoming bookings still reference it — the people in those rows are expecting to be seen. `?force=true` deletes them with it.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string() }),
        query: z.object({ force: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: z.object({ data: z.object({ ok: z.boolean() }) } ) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      await deleteResource(c.get("ctx"), tenantOf(c), c.req.valid("param").key, {
        force: c.req.valid("query").force === "true",
      });
      return c.json({ data: { ok: true } });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/resources/{key}/rotate-token",
      tags,
      summary: "Rotate the public page token",
      description:
        "Admin-only. Invalidates the old booking-page URL and returns the new one once. Existing bookings and their manage links are untouched.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ key: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ token: z.string(), url: z.string() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({ data: await rotateResourceToken(c.get("ctx"), tenantOf(c), c.req.valid("param").key) }),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/resources/{key}/slots",
      tags,
      summary: "Open slots for a resource",
      description:
        "Admin-only view of the same computation the public page runs. The window is clamped to 62 days; `remaining` is the capacity left at that instant.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string() }),
        query: z.object({ from: z.string().optional(), to: z.string().optional() }),
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: SlotsView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const resource = await requireResource(c, c.req.valid("param").key);
      const window = {
        ...(q.from ? { from: Date.parse(q.from) } : {}),
        ...(q.to ? { to: Date.parse(q.to) } : {}),
      };
      return c.json({ data: await listSlots(c.get("ctx"), resource, window) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/bookings",
      tags,
      summary: "List bookings",
      description:
        "Admin-only. `completed` and `expired` are derived from the clock rather than stored, so filtering by them matches rows nothing has swept.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          resource: z.string().optional(),
          status: z.enum(BOOKING_STATUSES as [string, ...string[]]).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(BookingView), total: z.number() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const out = await listBookings(c.get("ctx"), tenantOf(c), {
        ...(q.resource ? { resource: q.resource } : {}),
        ...(q.status ? { status: q.status as BookingStatus } : {}),
        ...(q.from ? { from: Date.parse(q.from) } : {}),
        ...(q.to ? { to: Date.parse(q.to) } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.offset ? { offset: q.offset } : {}),
      });
      return c.json(out);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bookings",
      tags,
      summary: "Book a slot as an operator",
      description:
        "Admin-only. Unlike the public path this is NOT restricted to the published grid — an operator taking a booking over the phone can put it wherever the caller needs. The overlap guard still applies.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: BookBody.extend({ resource: z.string().min(1) }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: BookResultView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { resource: key, ...body } = c.req.valid("json");
      const resource = await requireResource(c, key);
      const data = await createBooking(
        c.get("ctx"),
        tenantOf(c),
        resource,
        body as Parameters<typeof createBooking>[3],
        { source: "admin", createdBy: c.get("auth")?.userId ?? null },
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/bookings/{id}",
      tags,
      summary: "Get one booking",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookingView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await getBooking(c.get("ctx"), tenantOf(c), c.req.valid("param").id) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bookings/{id}/confirm",
      tags,
      summary: "Confirm a held booking",
      description:
        "Admin-only. What a paid deposit or a completed intake form calls. The slot was never released, so nothing is re-checked — but a hold that already lapsed answers 409.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookingView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await confirmBooking(c.get("ctx"), tenantOf(c), c.req.valid("param").id) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bookings/{id}/cancel",
      tags,
      summary: "Cancel a booking",
      description:
        "Admin-only. Idempotent: cancelling an already-cancelled booking is a no-op rather than an error. Set `notify:false` to skip the customer's email.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                reason: z.string().max(500).optional(),
                notify: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookingView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = tenantOf(c);
      const body = c.req.valid("json") ?? {};
      // Every mutation works from a resolved (booking, resource) pair, so the
      // operator path and the booker's own link check the same things.
      const resolved = await resolveBookingById(ctx, tenantId, c.req.valid("param").id);
      const data = await cancelBooking(ctx, resolved, {
        ...(body.reason ? { reason: body.reason } : {}),
        cancelledBy: c.get("auth")?.userId ?? null,
        ...(body.notify === undefined ? {} : { notify: body.notify }),
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bookings/{id}/reschedule",
      tags,
      summary: "Move a booking",
      description:
        "Admin-only. Cancel-then-book: the new row goes through the same overlap guard as any other booking and the old one keeps a pointer to it, so the trail survives. The old slot is released LAST, so a failed claim leaves the customer with the appointment they had.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": { schema: z.object({ start: z.union([z.string(), z.number()]) }) },
          },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookResultView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = tenantOf(c);
      const resolved = await resolveBookingById(ctx, tenantId, c.req.valid("param").id);
      const data = await rescheduleBooking(ctx, resolved, c.req.valid("json").start, {
        source: "admin",
        createdBy: c.get("auth")?.userId ?? null,
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bookings/{id}/no-show",
      tags,
      summary: "Mark a booking as a no-show",
      description:
        "Admin-only. Distinct from a cancellation: the slot was held, the time was spent, and a workspace that bills for it needs to tell the two apart.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookingView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await markNoShow(c.get("ctx"), tenantOf(c), c.req.valid("param").id) }),
  );

