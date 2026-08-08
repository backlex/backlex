import type { PublicAppearance } from "@/lib/public-theme";
import { api } from "@/lib/api";
import type { Envelope } from "./types";

/** One line of an opening pattern, or one exception to it. Minutes count from
 *  LOCAL midnight in the resource's own zone. */
export interface ApiBookingRule {
  id?: string;
  kind: "open" | "block";
  /** 0 = Sunday … 6 = Saturday, or null for every day in the date range. */
  weekday: number | null;
  startMinute: number;
  endMinute: number;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
}

/** What the booker is asked beyond name, email and phone. The stored `type` is
 *  advisory — a question carrying `options` is a choice whatever it says. */
export interface ApiBookingQuestion {
  name: string;
  label?: string;
  type?: "text" | "textarea" | "select" | "boolean";
  required?: boolean;
  options?: string[];
}

export interface ApiBookingResource {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** The zone the RULES are written in — not a display preference. */
  timeZone: string;
  slotMinutes: number;
  stepMinutes: number | null;
  capacity: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  leadMinutes: number;
  horizonDays: number;
  holdMinutes: number;
  questions: ApiBookingQuestion[];
  /** Public page appearance — `{ theme, accent, font }`, or null for ours. */
  settings: PublicAppearance | null;
  /** Whether bookings are recorded into a collection at all. */
  mirrorEnabled: boolean;
  /** Null means the provisioned default. */
  mirrorCollection: string | null;
  /** The slug bookings actually land in — null when recording is off. */
  recordCollection: string | null;
  mirrorFieldMap: Record<string, string> | null;
  active: boolean;
  confirmationMessage: string | null;
  notifyEmails: string[];
  rules: ApiBookingRule[];
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface ApiBooking {
  id: string;
  resourceId: string;
  /** ISO instants. Render them in the resource's `timeZone`. */
  start: string;
  end: string;
  /** Includes the DERIVED `completed` / `expired`. */
  status: "held" | "confirmed" | "cancelled" | "no_show" | "completed" | "expired";
  storedStatus: string;
  holdExpiresAt: number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  answers: Record<string, unknown>;
  notes: string | null;
  mirrorCollection: string | null;
  mirrorItemId: string | null;
  /** Why this booking is not in its collection yet, when it isn't. */
  mirrorError: string | null;
  source: string;
  cancelledAt: number | null;
  cancelReason: string | null;
  rescheduledToId: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface ApiBookingSlot {
  start: string;
  end: string;
  /** Capacity left. Never 0 — a full slot is not returned at all. */
  remaining: number;
}

/**
 * Availability & booking. Mirrors `/api/admin/booking`.
 *
 * `createResource` and `rotateToken` are the only two calls that ever see the
 * public page token, and each sees it once: only its hash is stored, so a page
 * that does not keep what it was handed cannot ask again.
 */
export const bookingApi = {
  listResources: () => api<Envelope<ApiBookingResource[]>>(`/api/admin/booking/resources`),
  getResource: (key: string) =>
    api<Envelope<ApiBookingResource>>(`/api/admin/booking/resources/${encodeURIComponent(key)}`),
  createResource: (body: Record<string, unknown>) =>
    api<Envelope<{ resource: ApiBookingResource; token: string; url: string }>>(
      `/api/admin/booking/resources`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  updateResource: (key: string, body: Record<string, unknown>) =>
    api<Envelope<ApiBookingResource>>(`/api/admin/booking/resources/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteResource: (key: string, force = false) =>
    api<Envelope<{ ok: boolean }>>(
      `/api/admin/booking/resources/${encodeURIComponent(key)}${force ? "?force=true" : ""}`,
      { method: "DELETE" },
    ),
  rotateToken: (key: string) =>
    api<Envelope<{ token: string; url: string }>>(
      `/api/admin/booking/resources/${encodeURIComponent(key)}/rotate-token`,
      { method: "POST" },
    ),
  slots: (key: string, window: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (window.from) q.set("from", window.from);
    if (window.to) q.set("to", window.to);
    const qs = q.toString();
    return api<
      Envelope<{
        resource: Record<string, unknown>;
        from: string;
        to: string;
        slots: ApiBookingSlot[];
      }>
    >(`/api/admin/booking/resources/${encodeURIComponent(key)}/slots${qs ? `?${qs}` : ""}`);
  },
  listBookings: (query: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    const qs = q.toString();
    return api<Envelope<ApiBooking[]> & { total: number }>(
      `/api/admin/booking/bookings${qs ? `?${qs}` : ""}`,
    );
  },
  book: (body: Record<string, unknown>) =>
    api<Envelope<{ booking: ApiBooking; manageToken: string; manageUrl: string; emailed: boolean }>>(
      `/api/admin/booking/bookings`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirm: (id: string) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
    }),
  cancel: (id: string, body: Record<string, unknown> = {}) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  reschedule: (id: string, start: string) =>
    api<Envelope<{ booking: ApiBooking; manageToken: string; manageUrl: string; emailed: boolean }>>(
      `/api/admin/booking/bookings/${encodeURIComponent(id)}/reschedule`,
      { method: "POST", body: JSON.stringify({ start }) },
    ),
  noShow: (id: string) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/no-show`, {
      method: "POST",
    }),
  /** Record it into its collection again. Answers 422 with the reason when it
   *  still cannot — the write path swallows that so a customer never meets an
   *  error over a bookkeeping problem, which is why the retry must not. */
  record: (id: string) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/record`, {
      method: "POST",
    }),
};

export interface ApiBookerView {
  id: string;
  resource: { key: string; name: string; timeZone: string; settings: PublicAppearance | null };
  start: string;
  end: string;
  status: string;
  customerName: string | null;
  customerEmail: string | null;
  answers: Record<string, unknown>;
  cancelReason: string | null;
  canCancel: boolean;
}

export interface ApiPublicSlots {
  resource: {
    key: string;
    name: string;
    description: string | null;
    timeZone: string;
    slotMinutes: number;
    capacity: number;
    questions: ApiBookingQuestion[];
    confirmationMessage: string | null;
    /** How the page paints itself. Null is the system light/dark default. */
    settings: PublicAppearance | null;
  };
  from: string;
  to: string;
  slots: ApiBookingSlot[];
}

/**
 * The booker's own endpoints. No credentials anywhere: the page token is the
 * grant to see a calendar and the manage token the grant to change one
 * appointment, so neither call carries a session.
 */
export const bookPublicApi = {
  slots: (token: string, window: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (window.from) q.set("from", window.from);
    if (window.to) q.set("to", window.to);
    const qs = q.toString();
    return api<Envelope<ApiPublicSlots>>(
      `/api/public/book/${encodeURIComponent(token)}/slots${qs ? `?${qs}` : ""}`,
    );
  },
  book: (token: string, body: Record<string, unknown>) =>
    api<Envelope<{ booking: ApiBookerView; manageUrl: string; emailed: boolean }>>(
      `/api/public/book/${encodeURIComponent(token)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  get: (token: string) =>
    api<Envelope<ApiBookerView>>(`/api/public/book/manage/${encodeURIComponent(token)}`),
  cancel: (token: string, reason?: string) =>
    api<Envelope<ApiBookerView>>(`/api/public/book/manage/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ ...(reason ? { reason } : {}) }),
    }),
  reschedule: (token: string, start: string) =>
    api<Envelope<{ booking: ApiBookerView; manageUrl: string; emailed: boolean }>>(
      `/api/public/book/manage/${encodeURIComponent(token)}/reschedule`,
      { method: "POST", body: JSON.stringify({ start }) },
    ),
};
