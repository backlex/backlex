import type { ClientCore } from "../core";

export type BookingStatus =
  | "held"
  | "confirmed"
  | "cancelled"
  | "no_show"
  | "completed"
  | "expired";

/** One line of an opening pattern, or one exception to it. Minutes are counted
 *  from LOCAL midnight in the resource's own zone; a span crossing midnight is
 *  two rules. */
export interface BookingRule {
  id?: string;
  kind?: "open" | "block";
  /** 0 = Sunday … 6 = Saturday, or null for every day in the date range. */
  weekday?: number | null;
  startMinute: number;
  endMinute: number;
  /** `YYYY-MM-DD`, inclusive. */
  startsOn?: string | null;
  endsOn?: string | null;
  reason?: string | null;
}

export interface BookingResource {
  id: string;
  key: string;
  name: string;
  description: string | null;
  timeZone: string;
  slotMinutes: number;
  stepMinutes: number | null;
  capacity: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  leadMinutes: number;
  horizonDays: number;
  holdMinutes: number;
  questions: Array<Record<string, unknown>>;
  /** Public page appearance: `{ theme, accent, font }`. Null is the default. */
  settings: Record<string, unknown> | null;
  /** Whether bookings are recorded into a collection at all. On by default. */
  mirrorEnabled: boolean;
  /** Null means the provisioned default (`booking_records`). */
  mirrorCollection: string | null;
  /** The slug bookings actually land in, resolved — null when recording is off. */
  recordCollection: string | null;
  mirrorFieldMap: Record<string, string> | null;
  active: boolean;
  confirmationMessage: string | null;
  notifyEmails: string[];
  rules: BookingRule[];
}

export interface BookingResourceInput {
  key?: string;
  name?: string;
  description?: string | null;
  /** IANA zone the rules are written in. */
  timeZone?: string;
  slotMinutes?: number;
  stepMinutes?: number | null;
  capacity?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  leadMinutes?: number;
  horizonDays?: number;
  holdMinutes?: number;
  questions?: Array<Record<string, unknown>>;
  /** `{ theme, accent, font }`. Replaced wholesale; `null` clears it. */
  settings?: Record<string, unknown> | null;
  /** Defaults to true — every resource records its bookings somewhere. */
  mirrorEnabled?: boolean;
  /** Omit for the provisioned default; a value points at a collection of your
   *  own, which then REQUIRES `mirrorFieldMap` (a target with no map records
   *  nothing, so it is refused rather than accepted silently). */
  mirrorCollection?: string | null;
  mirrorFieldMap?: Record<string, string> | null;
  active?: boolean;
  confirmationMessage?: string | null;
  notifyEmails?: string[];
  /** REPLACES the whole rule set — opening hours are edited as one thing. */
  rules?: BookingRule[];
}

export interface Booking {
  id: string;
  resourceId: string;
  /** ISO instants. Render them in the resource's `timeZone`. */
  start: string;
  end: string;
  /** Includes the DERIVED `completed` / `expired`. */
  status: BookingStatus;
  /** The raw column, for telling a stored `cancelled` from a derived one. */
  storedStatus: string;
  holdExpiresAt: number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  answers: Record<string, unknown>;
  notes: string | null;
  mirrorCollection: string | null;
  mirrorItemId: string | null;
  /** Why this booking is not in its collection yet, when it isn't. Retry with
   *  `booking.record(id)` once the cause is fixed. */
  mirrorError: string | null;
  source: string;
  cancelledAt: number | null;
  cancelReason: string | null;
  rescheduledToId: string | null;
}

export interface BookingSlot {
  start: string;
  end: string;
  /** Capacity left at that instant. Never 0 — a full slot is not returned. */
  remaining: number;
}

export interface CreateBookingInput {
  start: string | number;
  end?: string | number;
  name?: string;
  email?: string;
  phone?: string;
  answers?: Record<string, unknown>;
  notes?: string;
  /** Park the slot instead of confirming it — what a deposit is taken during. */
  hold?: boolean;
}

export interface BookingResult {
  booking: Booking;
  /** Returned ONCE. Only its hash is stored. */
  manageToken: string;
  manageUrl: string;
  emailed: boolean;
}

/**
 * Availability & booking (admin-scoped). Mirrors `/api/admin/booking`.
 *
 * The operator's side. A booking made here is NOT restricted to the published
 * grid — that is the difference between taking a call and offering a calendar —
 * but the capacity guarantee applies to both. The booker's own side needs no
 * credentials at all and lives under `/api/public/book/<token>`.
 */
export interface BookingClient {
  /** Every bookable resource, each with its full rule set. */
  listResources(): Promise<{ data: BookingResource[] }>;
  /** One resource, by key or id. */
  getResource(key: string): Promise<{ data: BookingResource }>;
  /** Create one. The public page token comes back HERE and nowhere else. */
  createResource(
    input: BookingResourceInput & { key: string; name: string },
  ): Promise<{ data: { resource: BookingResource; token: string; url: string } }>;
  updateResource(key: string, patch: BookingResourceInput): Promise<{ data: BookingResource }>;
  /** Refuses while upcoming bookings reference it unless `force`. */
  deleteResource(key: string, opts?: { force?: boolean }): Promise<{ data: { ok: boolean } }>;
  /** Mint a new page token, invalidating the old URL. Manage links survive. */
  rotateToken(key: string): Promise<{ data: { token: string; url: string } }>;
  /** The open slots, computed from the rules, the exceptions and what is taken. */
  slots(
    key: string,
    window?: { from?: string; to?: string },
  ): Promise<{ data: { resource: Record<string, unknown>; from: string; to: string; slots: BookingSlot[] } }>;
  listBookings(opts?: {
    resource?: string;
    status?: BookingStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    /** By start time. `desc` (the default) is what came in last; `asc` is who
     *  is coming next. */
    order?: "asc" | "desc";
    /** Only bookings that still stand — drops cancelled, no-show and lapsed
     *  holds. "Who is coming on Thursday" wants this. */
    live?: boolean;
  }): Promise<{ data: Booking[]; total: number }>;
  getBooking(id: string): Promise<{ data: Booking }>;
  /** Book as an operator — off-grid times allowed. */
  book(resource: string, input: CreateBookingInput): Promise<{ data: BookingResult }>;
  /** Promote a hold. A hold that already lapsed answers 409. */
  confirm(id: string): Promise<{ data: Booking }>;
  /** Idempotent. `notify:false` spares the customer the email. */
  cancel(id: string, opts?: { reason?: string; notify?: boolean }): Promise<{ data: Booking }>;
  /** Cancel-then-book, through the same guard. Returns a NEW manage link. */
  reschedule(id: string, start: string | number): Promise<{ data: BookingResult }>;
  /** Distinct from a cancellation: the time was held and spent. */
  noShow(id: string): Promise<{ data: Booking }>;
  /** Record this booking into its collection again after a failure. Answers
   *  with the reason when it still cannot — unlike the write path, which
   *  swallows it so a customer never meets a 500 over a bookkeeping problem. */
  record(id: string): Promise<{ data: Booking }>;
}

export const makeBooking = (core: ClientCore): BookingClient => {
  // Availability & booking. Every method here goes through the one service the
  // REST, GraphQL, MCP and CLI surfaces share, so the capacity guarantee and
  // the grid check cannot drift between them.
  const bookRes = (key: string) => `/api/admin/booking/resources/${encodeURIComponent(key)}`;
  const bookOne = (id: string) => `/api/admin/booking/bookings/${encodeURIComponent(id)}`;
  const booking: BookingClient = {
    listResources: () =>
      core.request<{ data: BookingResource[] }>("GET", "/api/admin/booking/resources"),
    getResource: (key) => core.request<{ data: BookingResource }>("GET", bookRes(key)),
    createResource: (input) =>
      core.request<{ data: { resource: BookingResource; token: string; url: string } }>(
        "POST",
        "/api/admin/booking/resources",
        input,
      ),
    updateResource: (key, patch) =>
      core.request<{ data: BookingResource }>("PATCH", bookRes(key), patch),
    deleteResource: (key, opts) =>
      core.request<{ data: { ok: boolean } }>(
        "DELETE",
        `${bookRes(key)}${opts?.force ? "?force=true" : ""}`,
      ),
    rotateToken: (key) =>
      core.request<{ data: { token: string; url: string } }>("POST", `${bookRes(key)}/rotate-token`),
    slots: (key, window) => {
      const q = new URLSearchParams();
      if (window?.from) q.set("from", window.from);
      if (window?.to) q.set("to", window.to);
      const qs = q.toString();
      return core.request<{
        data: { resource: Record<string, unknown>; from: string; to: string; slots: BookingSlot[] };
      }>("GET", `${bookRes(key)}/slots${qs ? `?${qs}` : ""}`);
    },
    listBookings: (opts) => {
      const q = new URLSearchParams();
      if (opts?.resource) q.set("resource", opts.resource);
      if (opts?.status) q.set("status", opts.status);
      if (opts?.from) q.set("from", opts.from);
      if (opts?.to) q.set("to", opts.to);
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      if (opts?.offset != null) q.set("offset", String(opts.offset));
      if (opts?.order) q.set("order", opts.order);
      if (opts?.live) q.set("live", "true");
      const qs = q.toString();
      return core.request<{ data: Booking[]; total: number }>(
        "GET",
        `/api/admin/booking/bookings${qs ? `?${qs}` : ""}`,
      );
    },
    getBooking: (id) => core.request<{ data: Booking }>("GET", bookOne(id)),
    book: (resource, input) =>
      core.request<{ data: BookingResult }>("POST", "/api/admin/booking/bookings", {
        resource,
        ...input,
      }),
    confirm: (id) => core.request<{ data: Booking }>("POST", `${bookOne(id)}/confirm`),
    cancel: (id, opts) => core.request<{ data: Booking }>("POST", `${bookOne(id)}/cancel`, opts ?? {}),
    reschedule: (id, start) =>
      core.request<{ data: BookingResult }>("POST", `${bookOne(id)}/reschedule`, { start }),
    noShow: (id) => core.request<{ data: Booking }>("POST", `${bookOne(id)}/no-show`),
    record: (id) => core.request<{ data: Booking }>("POST", `${bookOne(id)}/record`),
  };

  return booking;
};
