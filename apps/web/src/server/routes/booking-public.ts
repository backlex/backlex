import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import {
  cancelBooking,
  createBooking,
  listSlots,
  rescheduleBooking,
  resolveManageToken,
  resolveResourceToken,
  toBookerView,
  type BookingResourceRow,
  type ResolvedBooking,
} from "../services/booking";

/**
 * The booker's side — public, unauthenticated, mounted at `/api/public/book`.
 *
 * The page token is the entire grant to see a calendar, and the manage token is
 * the entire grant to change one booking, exactly like a form token or a
 * signing link. So there is no `requireUser` here and nothing on these routes
 * takes an id: a caller holding a token is the person it was issued to, and a
 * caller without one cannot address anybody else's appointment.
 *
 * The `/api/public/` prefix inherits the framable CSP + XFO-strip in app.ts,
 * which a booking widget embedded in somebody's own site needs for the same
 * reason the form page does.
 */

const TAGS = ["booking"];

/** Browsing a calendar is cheap and people do flick between weeks. */
const SLOTS_MAX_PER_MINUTE = 60;
/** Booking is a once-per-visit act; the budget is for retries, not traffic. */
const BOOK_MAX_PER_MINUTE = 8;
const WINDOW_MS = 60_000;

const NOT_AVAILABLE = "This booking link is not valid";

/**
 * Resolve a token, or refuse identically for every reason.
 *
 * An unknown token, a deleted resource and a paused one all answer 404 with the
 * same sentence. Distinguishing them would turn this endpoint into an oracle
 * for which tokens ever existed.
 */
const requireResource = async (ctx: any, token: string): Promise<BookingResourceRow> => {
  const resource = await resolveResourceToken(ctx, token);
  if (!resource) throw new AppError("NOT_FOUND", NOT_AVAILABLE);
  return resource;
};

const requireBooking = async (ctx: any, token: string): Promise<ResolvedBooking> => {
  const resolved = await resolveManageToken(ctx, token);
  if (!resolved) throw new AppError("NOT_FOUND", NOT_AVAILABLE);
  return resolved;
};

const limit = async (c: any, bucket: string, max: number): Promise<void> => {
  const meta = requestMeta(c.req.raw);
  const ok = await rateLimitOk(c.get("ctx").env, `${bucket}:${meta.ip ?? "unknown"}`, max, WINDOW_MS);
  if (!ok) throw new AppError("RATE_LIMITED", "Too many requests — please wait a moment");
};

/* ─────────────────────────────── schemas ────────────────────────────────── */

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
  .openapi("PublicBookingSlots");

const BookerView = z
  .object({
    id: z.string(),
    resource: z.object({ key: z.string(), name: z.string(), timeZone: z.string() }),
    start: z.string(),
    end: z.string(),
    status: z.string(),
    customerName: z.string().nullable(),
    customerEmail: z.string().nullable(),
    answers: z.record(z.string(), z.unknown()),
    cancelReason: z.string().nullable(),
    canCancel: z.boolean(),
  })
  .openapi("BookerView");

/**
 * What a stranger may set.
 *
 * Deliberately NOT the admin body minus a field or two. `end` and `hold` are
 * absent because the grid decides both, and `notes` is absent because it is the
 * OPERATOR's column — `toBookerView` withholds it from the booker for the same
 * reason, and a mirror map can project it into a workspace collection. Anything
 * a booker should be able to say belongs in the resource's `questions`, which
 * go through `normalizeAnswers` and land in `answers`.
 */
const BookBody = z
  .object({
    start: z.union([z.string(), z.number()]),
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    phone: z.string().max(50).optional(),
    answers: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PublicBookInput");

const BookedView = z
  .object({
    booking: BookerView,
    /** The link the booker manages this appointment with. Returned once, here
     *  and in the confirmation email, and stored only as a hash. */
    manageUrl: z.string(),
    emailed: z.boolean(),
  })
  .openapi("PublicBookResult");

/* ──────────────────────────────── routes ────────────────────────────────── */

export const bookingPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{token}/slots",
      tags: TAGS,
      summary: "Open slots behind a booking link",
      description:
        "PUBLIC — no auth. Computes the offer from the resource's rules, its exceptions and what is already taken. The window defaults to a fortnight and is clamped to 62 days; `remaining` is the capacity left at that instant. Times are ISO instants — render them in the returned `timeZone`.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({ from: z.string().optional(), to: z.string().optional() }),
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: SlotsView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      await limit(c, "book-slots", SLOTS_MAX_PER_MINUTE);
      const ctx = c.get("ctx");
      const resource = await requireResource(ctx, c.req.valid("param").token);
      // No authenticated identity on this path, so the resource row is what
      // attributes the call to a workspace for usage metering.
      setMeterTenant(c, resource.tenantId);
      const q = c.req.valid("query");
      const window = {
        ...(q.from ? { from: Date.parse(q.from) } : {}),
        ...(q.to ? { to: Date.parse(q.to) } : {}),
      };
      return c.json({ data: await listSlots(ctx, resource, window) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{token}",
      tags: TAGS,
      summary: "Take a slot",
      description:
        "PUBLIC — no auth. Refuses anything that is not on the published grid, then inserts and settles the overlap: two people clicking the same slot produce one booking and one 409. The manage link comes back on this response and in the confirmation email, and nowhere else.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: { required: true, content: { "application/json": { schema: BookBody } } },
      },
      responses: {
        201: {
          description: "Booked",
          content: { "application/json": { schema: z.object({ data: BookedView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      await limit(c, "book-create", BOOK_MAX_PER_MINUTE);
      const ctx = c.get("ctx");
      const resource = await requireResource(ctx, c.req.valid("param").token);
      setMeterTenant(c, resource.tenantId);
      const result = await createBooking(
        ctx,
        resource.tenantId,
        resource,
        c.req.valid("json") as Parameters<typeof createBooking>[3],
        { source: "public" },
      );
      return c.json(
        {
          data: {
            booking: toBookerView(result.row, resource),
            manageUrl: result.manageUrl,
            emailed: result.emailed,
          },
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/manage/{token}",
      tags: TAGS,
      summary: "Look at one booking",
      description:
        "PUBLIC — no auth. A cancelled or past booking still resolves, so the page can say what happened rather than show a dead link; `canCancel` says whether it can still be acted on. Never exposes the operator's notes or the mirror target.",
      security: PUBLIC_SECURITY,
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookerView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      await limit(c, "book-manage", SLOTS_MAX_PER_MINUTE);
      const ctx = c.get("ctx");
      const resolved = await requireBooking(ctx, c.req.valid("param").token);
      setMeterTenant(c, resolved.booking.tenantId);
      return c.json({ data: toBookerView(resolved.booking, resolved.resource) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/manage/{token}/cancel",
      tags: TAGS,
      summary: "Cancel your own booking",
      description:
        "PUBLIC — no auth. Idempotent: a second click on the link in the confirmation email is a no-op, not an error.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: {
          required: false,
          content: { "application/json": { schema: z.object({ reason: z.string().max(500).optional() }) } },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookerView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      await limit(c, "book-cancel", BOOK_MAX_PER_MINUTE);
      const ctx = c.get("ctx");
      const resolved = await requireBooking(ctx, c.req.valid("param").token);
      setMeterTenant(c, resolved.booking.tenantId);
      const body = c.req.valid("json") ?? {};
      await cancelBooking(ctx, resolved, {
        ...(body.reason ? { reason: body.reason } : {}),
        // Null means the booker did it themselves, which the admin list shows
        // differently from an operator cancelling on their behalf.
        cancelledBy: null,
      });
      const after = await requireBooking(ctx, c.req.valid("param").token);
      return c.json({ data: toBookerView(after.booking, after.resource) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/manage/{token}/reschedule",
      tags: TAGS,
      summary: "Move your own booking",
      description:
        "PUBLIC — no auth. The new time has to be on the published grid, and it goes through the same overlap guard as a fresh booking. The old slot is released last, so a failed claim leaves the appointment where it was. Returns a NEW manage link — the old one is spent.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": { schema: z.object({ start: z.union([z.string(), z.number()]) }) },
          },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: BookedView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      await limit(c, "book-reschedule", BOOK_MAX_PER_MINUTE);
      const ctx = c.get("ctx");
      const resolved = await requireBooking(ctx, c.req.valid("param").token);
      setMeterTenant(c, resolved.booking.tenantId);
      const result = await rescheduleBooking(ctx, resolved, c.req.valid("json").start, {
        source: "public",
      });
      return c.json({
        data: {
          booking: toBookerView(result.row, resolved.resource),
          manageUrl: result.manageUrl,
          emailed: result.emailed,
        },
      });
    },
  );
