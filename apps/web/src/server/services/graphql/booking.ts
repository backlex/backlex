import { AppError } from "@backlex/core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
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
  retryBookingRecord,
  rescheduleBooking,
  resolveBookingById,
  rotateResourceToken,
  updateResource,
  type BookingStatus,
} from "../booking";
import { recordActivity } from "../activity";

// ── Availability & booking ───────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/admin/booking`. Everything funnels through
// services/booking.ts, so the capacity guarantee, the derived statuses and the
// grid check are shared rather than restated — restating a guard per surface is
// how one of them ends up missing.
//
// There is deliberately no public booking mutation here. Taking a slot as a
// stranger is authenticated by a page token and nothing else; exposing it on an
// admin-authenticated API would only be an operator booking on somebody's
// behalf, which `book` already does and says so in `source`.

const RuleType = new GraphQLObjectType({
  name: "BookingRule",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    kind: { type: new GraphQLNonNull(GraphQLString) },
    /** 0 = Sunday … 6 = Saturday, or null for every day in the date range. */
    weekday: { type: GraphQLInt },
    startMinute: { type: new GraphQLNonNull(GraphQLInt) },
    endMinute: { type: new GraphQLNonNull(GraphQLInt) },
    startsOn: { type: GraphQLString },
    endsOn: { type: GraphQLString },
    reason: { type: GraphQLString },
  },
});

const RuleInputType = new GraphQLInputObjectType({
  name: "BookingRuleInput",
  fields: {
    kind: { type: GraphQLString },
    weekday: { type: GraphQLInt },
    startMinute: { type: new GraphQLNonNull(GraphQLInt) },
    endMinute: { type: new GraphQLNonNull(GraphQLInt) },
    startsOn: { type: GraphQLString },
    endsOn: { type: GraphQLString },
    reason: { type: GraphQLString },
  },
});

const ResourceType = new GraphQLObjectType({
  name: "BookingResource",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    key: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    /** The zone the rules are written in — not a display preference. */
    timeZone: { type: new GraphQLNonNull(GraphQLString) },
    slotMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    stepMinutes: { type: GraphQLInt },
    capacity: { type: new GraphQLNonNull(GraphQLInt) },
    bufferBeforeMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    bufferAfterMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    leadMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    horizonDays: { type: new GraphQLNonNull(GraphQLInt) },
    holdMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    questions: { type: JSONScalar },
    settings: { type: JSONScalar },
    mirrorEnabled: { type: GraphQLBoolean },
    mirrorCollection: { type: GraphQLString },
    recordCollection: { type: GraphQLString },
    mirrorFieldMap: { type: JSONScalar },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
    confirmationMessage: { type: GraphQLString },
    notifyEmails: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    rules: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RuleType))) },
    createdAt: { type: JSONScalar },
    updatedAt: { type: JSONScalar },
  },
});

const CreatedResourceType = new GraphQLObjectType({
  name: "CreatedBookingResource",
  fields: {
    resource: { type: new GraphQLNonNull(ResourceType) },
    /** Returned exactly once — only its hash is stored. */
    token: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const BookingType = new GraphQLObjectType({
  name: "Booking",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    resourceId: { type: new GraphQLNonNull(GraphQLID) },
    start: { type: new GraphQLNonNull(GraphQLString) },
    end: { type: new GraphQLNonNull(GraphQLString) },
    /** Includes `completed` and `expired`, both derived from the clock. */
    status: { type: new GraphQLNonNull(GraphQLString) },
    storedStatus: { type: new GraphQLNonNull(GraphQLString) },
    holdExpiresAt: { type: JSONScalar },
    customerName: { type: GraphQLString },
    customerEmail: { type: GraphQLString },
    customerPhone: { type: GraphQLString },
    answers: { type: JSONScalar },
    notes: { type: GraphQLString },
    mirrorCollection: { type: GraphQLString },
    mirrorItemId: { type: GraphQLString },
    mirrorError: { type: GraphQLString },
    source: { type: new GraphQLNonNull(GraphQLString) },
    cancelledAt: { type: JSONScalar },
    cancelReason: { type: GraphQLString },
    rescheduledToId: { type: GraphQLString },
    createdAt: { type: JSONScalar },
    updatedAt: { type: JSONScalar },
  },
});

const SlotType = new GraphQLObjectType({
  name: "BookingSlot",
  fields: {
    start: { type: new GraphQLNonNull(GraphQLString) },
    end: { type: new GraphQLNonNull(GraphQLString) },
    /** Capacity left. Never 0 — a full slot is not returned at all. */
    remaining: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const SlotsType = new GraphQLObjectType({
  name: "BookingSlots",
  fields: {
    resource: { type: new GraphQLNonNull(JSONScalar) },
    from: { type: new GraphQLNonNull(GraphQLString) },
    to: { type: new GraphQLNonNull(GraphQLString) },
    slots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SlotType))) },
  },
});

const BookingResultType = new GraphQLObjectType({
  name: "BookingResult",
  fields: {
    booking: { type: new GraphQLNonNull(BookingType) },
    /** Returned exactly once — only its hash is stored. */
    manageToken: { type: new GraphQLNonNull(GraphQLString) },
    manageUrl: { type: new GraphQLNonNull(GraphQLString) },
    emailed: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const RotatedTokenType = new GraphQLObjectType({
  name: "RotatedBookingToken",
  fields: {
    token: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** yoga masks non-GraphQLError throws — surface AppErrors with their code. */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/**
 * The knobs both `create` and `update` accept.
 *
 * `name` is NOT here: create requires it and update does not, and spreading an
 * optional one over a required declaration silently wins — which is how a
 * mutation ends up letting a resource be created with no name at all.
 */
const resourceArgs = {
  description: { type: GraphQLString },
  timeZone: { type: GraphQLString },
  slotMinutes: { type: GraphQLInt },
  stepMinutes: { type: GraphQLInt },
  capacity: { type: GraphQLInt },
  bufferBeforeMinutes: { type: GraphQLInt },
  bufferAfterMinutes: { type: GraphQLInt },
  leadMinutes: { type: GraphQLInt },
  horizonDays: { type: GraphQLInt },
  holdMinutes: { type: GraphQLInt },
  questions: { type: JSONScalar },
  settings: { type: JSONScalar },
  mirrorEnabled: { type: GraphQLBoolean },
  mirrorCollection: { type: GraphQLString },
  mirrorFieldMap: { type: JSONScalar },
  active: { type: GraphQLBoolean },
  confirmationMessage: { type: GraphQLString },
  notifyEmails: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  rules: { type: new GraphQLList(new GraphQLNonNull(RuleInputType)) },
};

export const bookingQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  bookingResources: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ResourceType))),
    description:
      "Every bookable resource in the active workspace (admin-only), each with its full rule set — an opening pattern means nothing without one.",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(() => listResources(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
  bookingResource: {
    type: new GraphQLNonNull(ResourceType),
    description: "One bookable resource by key or id (admin-only).",
    args: { key: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(() => getResource(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { key: string }).key)),
  },
  bookingSlots: {
    type: new GraphQLNonNull(SlotsType),
    description:
      "The open slots for a resource (admin-only) — the same computation the public page runs. The window defaults to a fortnight and is clamped to 62 days.",
    args: {
      key: { type: new GraphQLNonNull(GraphQLString) },
      from: { type: GraphQLString },
      to: { type: GraphQLString },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { key: string; from?: string; to?: string };
        const tenantId = requireFlowAdmin(gqlCtx);
        const resource = await loadResource(gqlCtx.ctx, tenantId, a.key);
        if (!resource) throw new AppError("NOT_FOUND", "Booking resource not found");
        return listSlots(gqlCtx.ctx, resource, {
          ...(a.from ? { from: Date.parse(a.from) } : {}),
          ...(a.to ? { to: Date.parse(a.to) } : {}),
        });
      }),
  },
  bookings: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BookingType))),
    description:
      "Bookings in the active workspace (admin-only). `completed` and `expired` are derived from the clock rather than stored, so filtering by them matches rows nothing has swept.",
    args: {
      resource: { type: GraphQLString },
      status: { type: GraphQLString },
      from: { type: GraphQLString },
      to: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as Record<string, string | number | undefined>;
        const out = await listBookings(gqlCtx.ctx, requireFlowAdmin(gqlCtx), {
          ...(a.resource ? { resource: String(a.resource) } : {}),
          ...(a.status ? { status: a.status as BookingStatus } : {}),
          ...(a.from ? { from: Date.parse(String(a.from)) } : {}),
          ...(a.to ? { to: Date.parse(String(a.to)) } : {}),
          ...(a.limit != null ? { limit: Number(a.limit) } : {}),
          ...(a.offset != null ? { offset: Number(a.offset) } : {}),
        });
        return out.data;
      }),
  },
  booking: {
    type: new GraphQLNonNull(BookingType),
    description: "One booking by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(() => getBooking(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id)),
  },
};

export const bookingMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createBookingResource: {
    type: new GraphQLNonNull(CreatedResourceType),
    description:
      "Create a bookable resource (admin-only). The public page token is returned on this response and nowhere else — only its hash is stored.",
    args: {
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: new GraphQLNonNull(GraphQLString) },
      ...resourceArgs,
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const created = await createResource(
          gqlCtx.ctx,
          tenantId,
          args as never,
          gqlCtx.auth.userId ?? null,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_booking_resources",
          itemId: created.resource.id,
        });
        return created;
      }),
  },
  updateBookingResource: {
    type: new GraphQLNonNull(ResourceType),
    description:
      "Update a resource (admin-only). Passing `rules` REPLACES the whole set — opening hours are edited as one thing, not row by row.",
    args: {
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      ...resourceArgs,
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const { key, ...patch } = args as { key: string } & Record<string, unknown>;
        return updateResource(gqlCtx.ctx, requireFlowAdmin(gqlCtx), key, patch as never);
      }),
  },
  deleteBookingResource: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      "Delete a resource (admin-only). Refuses while upcoming bookings reference it unless `force` is set.",
    args: {
      key: { type: new GraphQLNonNull(GraphQLString) },
      force: { type: GraphQLBoolean },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { key: string; force?: boolean };
        await deleteResource(gqlCtx.ctx, requireFlowAdmin(gqlCtx), a.key, {
          ...(a.force === undefined ? {} : { force: a.force }),
        });
        return true;
      }),
  },
  rotateBookingToken: {
    type: new GraphQLNonNull(RotatedTokenType),
    description:
      "Mint a new public page token (admin-only), invalidating the old booking URL. Existing bookings and their manage links are untouched.",
    args: { key: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(() =>
        rotateResourceToken(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { key: string }).key),
      ),
  },
  createBooking: {
    type: new GraphQLNonNull(BookingResultType),
    description:
      "Book a slot as an operator (admin-only). Unlike the public path this is NOT restricted to the published grid — taking a call is exactly the case a grid cannot describe — but the capacity guarantee applies either way. The manage link is returned once.",
    args: {
      resource: { type: new GraphQLNonNull(GraphQLString) },
      start: { type: new GraphQLNonNull(GraphQLString) },
      end: { type: GraphQLString },
      name: { type: GraphQLString },
      email: { type: GraphQLString },
      phone: { type: GraphQLString },
      answers: { type: JSONScalar },
      notes: { type: GraphQLString },
      hold: { type: GraphQLBoolean },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const { resource: key, ...input } = args as { resource: string } & Record<string, unknown>;
        const tenantId = requireFlowAdmin(gqlCtx);
        const resource = await loadResource(gqlCtx.ctx, tenantId, key);
        if (!resource) throw new AppError("NOT_FOUND", "Booking resource not found");
        const made = await createBooking(gqlCtx.ctx, tenantId, resource, input as never, {
          source: "admin",
          createdBy: gqlCtx.auth.userId ?? null,
        });
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "create",
          collection: "system_bookings",
          itemId: made.booking.id,
        });
        return made;
      }),
  },
  confirmBooking: {
    type: new GraphQLNonNull(BookingType),
    description:
      "Promote a held booking (admin-only) — what a paid deposit calls. The slot was never released, so nothing is re-checked, but a hold that already lapsed answers CONFLICT.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(() =>
        confirmBooking(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
  cancelBooking: {
    type: new GraphQLNonNull(BookingType),
    description:
      "Cancel a booking (admin-only). Idempotent — cancelling an already-cancelled booking is a no-op rather than an error.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      reason: { type: GraphQLString },
      notify: { type: GraphQLBoolean },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { id: string; reason?: string; notify?: boolean };
        const tenantId = requireFlowAdmin(gqlCtx);
        const resolved = await resolveBookingById(gqlCtx.ctx, tenantId, a.id);
        return cancelBooking(gqlCtx.ctx, resolved, {
          ...(a.reason ? { reason: a.reason } : {}),
          cancelledBy: gqlCtx.auth.userId ?? null,
          ...(a.notify === undefined ? {} : { notify: a.notify }),
        });
      }),
  },
  rescheduleBooking: {
    type: new GraphQLNonNull(BookingResultType),
    description:
      "Move a booking (admin-only). Cancel-then-book through the same guard; the old row keeps a pointer to the new one and is released LAST, so a failed claim leaves the customer with the appointment they had.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      start: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const a = args as { id: string; start: string };
        const tenantId = requireFlowAdmin(gqlCtx);
        const resolved = await resolveBookingById(gqlCtx.ctx, tenantId, a.id);
        return rescheduleBooking(gqlCtx.ctx, resolved, a.start, {
          source: "admin",
          createdBy: gqlCtx.auth.userId ?? null,
        });
      }),
  },
  markBookingNoShow: {
    type: new GraphQLNonNull(BookingType),
    description:
      "Mark a booking as a no-show (admin-only). Distinct from a cancellation: the slot was held and the time was spent, and a workspace that bills for it has to tell the two apart.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(() => markNoShow(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id)),
  },
  recordBooking: {
    type: new GraphQLNonNull(BookingType),
    description:
      "Record a booking into its collection again (admin-only). Recording is best-effort on the write path so a bookkeeping problem never reaches the customer as a 500; the reason is kept on `mirrorError` and this retries it, answering with that reason when it still cannot.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(() =>
        retryBookingRecord(gqlCtx.ctx, requireFlowAdmin(gqlCtx), (args as { id: string }).id),
      ),
  },
};
