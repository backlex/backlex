/**
 * Availability and booking — a stranger picks a time that is actually free.
 *
 * Ten of the twenty-six schema templates carry a slot-shaped collection, and
 * the `appointments` one goes as far as modelling `availability_rules` and
 * `bookings` itself. What none of them could express is when the thing behind
 * the row is free, so that — not the storage of a booking — is what this adds.
 * The slot arithmetic is pure and lives in `@backlex/core`; this file is the
 * part that has a database, a clock and two people clicking at once.
 *
 * The design turns on four decisions:
 *
 * 1. **The ledger is authoritative for the SLOT; the recorded row is
 *    authoritative for everything else.** A collection holds a booking
 *    perfectly well, and every booking is recorded in one — with permissions,
 *    flows, realtime and exports all applying to it as usual. What a collection
 *    cannot do is refuse the second write for one instant. That needs one
 *    table, one index and one ordering rule every writer agrees on, so the
 *    ledger keeps it. Recording is on by default and its target is provisioned
 *    for the workspace (see ./booking-collection); a resource may point at a
 *    collection of its own instead, and only then supplies a field map.
 * 2. **The guard is insert-then-verify, not check-then-insert.** There is no
 *    row lock to take on D1, and a check before an insert is a race with a
 *    window rather than a guard. So the row goes in, the overlap is counted,
 *    and a loser withdraws its own row. See {@link claimSlot} for why two
 *    racers always agree on which of them lost.
 * 3. **`held` occupies the slot; expiry is derived.** A hold is what a deposit
 *    or a longer form is paid/filled during. Nothing sweeps it: a lapsed hold
 *    stops counting because the clock passed it, so a wedged cron cannot keep
 *    a slot closed. `completed` is derived the same way.
 * 4. **The manage token is the whole grant.** Only its SHA-256 is stored, and
 *    every failure to resolve one answers identically — an endpoint that
 *    distinguished "unknown" from "cancelled" would be an oracle for whether a
 *    given booking exists.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
// The pure subpath, not the package root — see `packages/db/src/email.ts`.
import { tryParseEmail } from "@backlex/db/email";
import {
  AppError,
  MAX_RANGE_DAYS,
  availableSlots,
  bookingsConflict,
  buildIcs,
  civilDateIn,
  icsAttachmentContent,
  slotIsOffered,
  type AvailabilityRule,
  type BusyInterval,
  type Slot,
  type SlotPolicy,
  type Weekday,
} from "@backlex/core";
import { sql } from "drizzle-orm";
import type { Ctx } from "../context";
import { hashToken } from "./shared-links";
import {
  BOOKING_COLLECTION_SLUG,
  DEFAULT_BOOKING_FIELD_MAP,
  ensureBookingCollection,
} from "./booking-collection";
import { createItem, updateItem } from "./items-helpers";
import { sendTemplatedEmail } from "./email";
import { dispatchEventHandlers } from "./events";
import { loadCollection } from "./items/collection-loader";
import { isUniqueViolation, queryAll } from "./items/sql-helpers";

type AnyDb = any;

const resourcesTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.bookingResources
    : sqlite.schema.bookingResources) as typeof pg.schema.bookingResources;

const rulesTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.bookingRules
    : sqlite.schema.bookingRules) as typeof pg.schema.bookingRules;

const bookingsTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.bookings : sqlite.schema.bookings) as typeof pg.schema.bookings;

/* ─────────────────────────────── constants ──────────────────────────────── */

const RESOURCE_TOKEN_PREFIX = "bkg";
const MANAGE_TOKEN_PREFIX = "bkm";
const TOKEN_BYTES = 24;

export const MAX_RULES_PER_RESOURCE = 200;

/**
 * How many rules one INSERT statement carries.
 *
 * SQLite binds one parameter per column per row and refuses past 100 of them
 * ("too many SQL variables"); a rule row is eleven columns wide, so a tenth
 * rule is where a single statement crosses the line. Eight leaves room for a
 * column to be added without this becoming a bug again.
 */
export const RULES_PER_INSERT = 8;

/** What SQLite will bind in one statement. D1 ships the stock 100; bun:sqlite
 *  is compiled far higher, which is exactly why the local suite cannot catch a
 *  breach by running one — `booking.test.ts` checks the budget arithmetic
 *  instead of hoping the driver complains. */
export const SQLITE_MAX_VARIABLES = 100;
export const MAX_QUESTIONS = 20;
export const MAX_ANSWER_LENGTH = 2000;
export const MAX_NOTES = 2000;
export const MAX_NAME = 200;
export const MAX_CANCEL_REASON = 500;

/** A resource may not be configured into a state that makes the slot walk
 *  unbounded or the offers meaningless. */
export const MIN_SLOT_MINUTES = 5;
export const MAX_SLOT_MINUTES = 24 * 60;
export const MAX_CAPACITY = 1000;
export const MAX_HORIZON_DAYS = 730;
export const MAX_BUFFER_MINUTES = 24 * 60;
export const MAX_HOLD_MINUTES = 24 * 60;

export type BookingStatus =
  | "held"
  | "confirmed"
  | "cancelled"
  | "no_show"
  | "completed"
  | "expired";

/** The statuses that actually occupy a slot, before the clock is consulted. */
const OCCUPYING: string[] = ["held", "confirmed"];

/**
 * How the public page looks.
 *
 * Deliberately the same three keys `forms.settings` stores, because they are
 * the same three decisions and the two pages are rendered by one client
 * module. A booking widget sits on the operator's own site — that is why both
 * public routes ship under the framable CSP — and a widget that cannot take
 * the host site's colour always looks borrowed.
 *
 * Presentation only. Nothing here is ever filtered, joined or authorised on,
 * which is why it is one JSON column rather than three typed ones.
 */
export interface BookingSettings {
  theme?: "dark" | "light";
  /** `#rrggbb`. Anything else is ignored by the page's own reader. */
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
}

const THEMES = new Set(["dark", "light"]);
const FONTS = new Set(["sans", "lexend", "mono", "system"]);

/**
 * Keep only what the page can actually render.
 *
 * The accent is pasted into a style declaration by the client, so a value that
 * is not a plain hex colour is dropped here rather than trusted to the reader —
 * defence on both sides of the wire, since the same blob also reaches the SDK,
 * GraphQL and anything else that reads a resource.
 */
export const normalizeBookingSettings = (
  raw: Record<string, unknown> | null | undefined,
): BookingSettings | null => {
  if (!raw || typeof raw !== "object") return null;
  const out: BookingSettings = {};
  if (typeof raw.theme === "string" && THEMES.has(raw.theme)) out.theme = raw.theme as "dark" | "light";
  if (typeof raw.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.accent)) out.accent = raw.accent;
  if (typeof raw.font === "string" && FONTS.has(raw.font)) out.font = raw.font as BookingSettings["font"];
  return Object.keys(out).length > 0 ? out : null;
};

/* ──────────────────────────────── row types ─────────────────────────────── */

export interface BookingResourceRow {
  id: string;
  tenantId: string | null;
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
  questions: Array<Record<string, unknown>> | null;
  settings: BookingSettings | null;
  mirrorEnabled: boolean;
  mirrorCollection: string | null;
  mirrorFieldMap: Record<string, string> | null;
  tokenHash: string;
  active: boolean;
  confirmationMessage: string | null;
  notifyEmails: string[] | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface BookingRuleRow {
  id: string;
  resourceId: string;
  kind: string;
  weekday: number | null;
  startMinute: number;
  endMinute: number;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface BookingRow {
  id: string;
  tenantId: string | null;
  resourceId: string;
  startAt: Date | number;
  endAt: Date | number;
  status: string;
  holdExpiresAt: Date | number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  answers: Record<string, unknown> | null;
  notes: string | null;
  tokenHash: string;
  mirrorCollection: string | null;
  mirrorItemId: string | null;
  mirrorError: string | null;
  source: string;
  cancelledAt: Date | number | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  rescheduledToId: string | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

const asMs = (v: Date | number | null | undefined): number =>
  v == null ? 0 : v instanceof Date ? v.getTime() : Number(v);

const asMsOrNull = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

/**
 * Every instant crosses the driver boundary as a `Date`, in BOTH dialects.
 *
 * The SQLite columns are `integer({ mode: "timestamp_ms" })`, which looks like
 * an invitation to pass epoch milliseconds straight through — and writing does
 * appear to work if you do. Comparisons do not: a raw number handed to `lt()`
 * skips the column's driver mapping, so the predicate silently matches nothing
 * and the overlap guard reads an empty conflict set. That failure is invisible
 * until two people book the same slot and both succeed. Reading still goes
 * through {@link asMs}, which accepts either shape.
 */
const instant = (_dialect: "pg" | "sqlite", ms: number): Date => new Date(ms);

/** The write-time `updated_at` / `created_at` stamp, same rule as above. */
const stampAt = (_dialect: "pg" | "sqlite", ms: number): Date => new Date(ms);

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * The address a booking is confirmed to, canonical.
 *
 * Was one of three identical hand-written regexes that disagreed with the
 * field-level validator — see the note on `services/signatures.ts`. Folding here
 * also means a customer who books twice, once as `Ada@` and once as `ada@`, is
 * one customer to every query that looks them up afterwards.
 */
export const normalizeEmail = (raw: unknown, what = "customer"): string => {
  const parsed = tryParseEmail(String(raw ?? "").trim());
  if (!parsed) {
    throw new AppError("VALIDATION", `"${String(raw ?? "").trim()}" is not a valid ${what} email`);
  }
  return parsed.email;
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

const trimmed = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return s.slice(0, max);
};

/**
 * Is a booking still occupying its slot?
 *
 * A hold whose lifetime has run out stops counting the instant it does — no
 * job runs, nothing is rewritten. This is the single place that decides it, so
 * the slot listing and the write guard can never disagree about whether a
 * particular row is in the way.
 */
export const stillOccupies = (row: Pick<BookingRow, "status" | "holdExpiresAt">, now: number): boolean => {
  if (!OCCUPYING.includes(row.status)) return false;
  if (row.status !== "held") return true;
  const expires = asMsOrNull(row.holdExpiresAt);
  return expires == null || expires > now;
};

/**
 * The status a caller should be shown.
 *
 * `completed` and `expired` are never written: a confirmed booking becomes
 * completed because its end time passed, and a hold expires because its
 * lifetime did. Deriving both means nothing has to run for yesterday's
 * appointments to stop looking upcoming, and a deployment whose cron is wedged
 * cannot hand out a slot that a dead hold is still sitting on.
 */
export const effectiveBookingStatus = (row: BookingRow, now = Date.now()): BookingStatus => {
  const status = row.status as BookingStatus;
  if (status === "held") {
    const expires = asMsOrNull(row.holdExpiresAt);
    return expires != null && expires <= now ? "expired" : "held";
  }
  if (status === "confirmed" && asMs(row.endAt) <= now) return "completed";
  return status;
};

/** The policy half of a resource, in the shape the pure slot math wants. */
export const policyOf = (r: BookingResourceRow): SlotPolicy => ({
  timeZone: r.timeZone,
  slotMinutes: r.slotMinutes,
  stepMinutes: r.stepMinutes ?? undefined,
  capacity: r.capacity,
  bufferBeforeMinutes: r.bufferBeforeMinutes,
  bufferAfterMinutes: r.bufferAfterMinutes,
  leadMinutes: r.leadMinutes,
  horizonDays: r.horizonDays,
});

const ruleOf = (row: BookingRuleRow): AvailabilityRule => ({
  kind: row.kind === "block" ? "block" : "open",
  weekday: (row.weekday ?? null) as Weekday | null,
  startMinute: row.startMinute,
  endMinute: row.endMinute,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
});

/* ────────────────────────────── serialisation ───────────────────────────── */

export const toPublicRule = (row: BookingRuleRow) => ({
  id: row.id,
  kind: row.kind as "open" | "block",
  weekday: row.weekday,
  startMinute: row.startMinute,
  endMinute: row.endMinute,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  reason: row.reason,
});

export const toPublicResource = (row: BookingResourceRow, rules: BookingRuleRow[] = []) => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  timeZone: row.timeZone,
  slotMinutes: row.slotMinutes,
  stepMinutes: row.stepMinutes,
  capacity: row.capacity,
  bufferBeforeMinutes: row.bufferBeforeMinutes,
  bufferAfterMinutes: row.bufferAfterMinutes,
  leadMinutes: row.leadMinutes,
  horizonDays: row.horizonDays,
  holdMinutes: row.holdMinutes,
  questions: row.questions ?? [],
  settings: row.settings ?? null,
  mirrorEnabled: row.mirrorEnabled,
  /** Null means the provisioned default. `recordCollection` is the slug that
   *  answer resolves to, so a caller never has to know which case it is in. */
  mirrorCollection: row.mirrorCollection,
  recordCollection: row.mirrorEnabled
    ? (row.mirrorCollection ?? BOOKING_COLLECTION_SLUG)
    : null,
  mirrorFieldMap: row.mirrorFieldMap,
  active: row.active,
  confirmationMessage: row.confirmationMessage,
  notifyEmails: row.notifyEmails ?? [],
  rules: rules.map(toPublicRule),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toPublicBooking = (row: BookingRow, now = Date.now()) => ({
  id: row.id,
  resourceId: row.resourceId,
  start: new Date(asMs(row.startAt)).toISOString(),
  end: new Date(asMs(row.endAt)).toISOString(),
  status: effectiveBookingStatus(row, now),
  /** The raw column, for a caller that needs to tell a stored `cancelled` from
   *  a derived `completed`. */
  storedStatus: row.status,
  holdExpiresAt: asMsOrNull(row.holdExpiresAt),
  customerName: row.customerName,
  customerEmail: row.customerEmail,
  customerPhone: row.customerPhone,
  answers: row.answers ?? {},
  notes: row.notes,
  mirrorCollection: row.mirrorCollection,
  mirrorItemId: row.mirrorItemId,
  /** Why this booking is not in the collection yet, when it isn't. Null on a
   *  booking that recorded cleanly AND on one whose resource records nowhere —
   *  the two are told apart by the resource, not by the booking. */
  mirrorError: row.mirrorError,
  source: row.source,
  cancelledAt: asMsOrNull(row.cancelledAt),
  cancelReason: row.cancelReason,
  rescheduledToId: row.rescheduledToId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type PublicBooking = ReturnType<typeof toPublicBooking>;
export type PublicResource = ReturnType<typeof toPublicResource>;

/**
 * What the booker's own page is allowed to see.
 *
 * Deliberately not {@link toPublicBooking}: the operator's view carries notes,
 * the mirror target and the source, none of which are the customer's business
 * and one of which names a collection.
 */
export const toBookerView = (row: BookingRow, resource: BookingResourceRow, now = Date.now()) => ({
  id: row.id,
  // Appearance travels with the booking: the page a customer follows from
  // their confirmation email to move or cancel is the same calendar they
  // booked on, and it would be an odd calendar that changed colour on the way.
  resource: {
    key: resource.key,
    name: resource.name,
    timeZone: resource.timeZone,
    settings: resource.settings ?? null,
  },
  start: new Date(asMs(row.startAt)).toISOString(),
  end: new Date(asMs(row.endAt)).toISOString(),
  status: effectiveBookingStatus(row, now),
  customerName: row.customerName,
  customerEmail: row.customerEmail,
  answers: row.answers ?? {},
  cancelReason: row.cancelReason,
  /** A cancelled or past booking still resolves, so the page can say so rather
   *  than show a dead link — but it cannot be acted on. */
  canCancel: effectiveBookingStatus(row, now) === "confirmed" || effectiveBookingStatus(row, now) === "held",
});

/* ─────────────────────────────── loading ────────────────────────────────── */

const tenantWhere = (t: any, tenantId: string | null) =>
  tenantId === null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);

export const loadResourceById = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<BookingResourceRow | null> => {
  const t = resourcesTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantWhere(t, tenantId)))
    .limit(1)) as BookingResourceRow[];
  return rows[0] ?? null;
};

/** Resources are addressed by `key` on every surface a human types into, and by
 *  id everywhere the admin links. Both resolve here so no caller has to guess. */
export const loadResource = async (
  ctx: Ctx,
  tenantId: string | null,
  keyOrId: string,
): Promise<BookingResourceRow | null> => {
  const t = resourcesTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.key, keyOrId), tenantWhere(t, tenantId)))
    .limit(1)) as BookingResourceRow[];
  if (rows[0]) return rows[0];
  return loadResourceById(ctx, tenantId, keyOrId);
};

export const loadRules = async (ctx: Ctx, resourceId: string): Promise<BookingRuleRow[]> => {
  const t = rulesTable(ctx.dialect);
  return (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.resourceId, resourceId))
    .orderBy(asc(t.weekday), asc(t.startMinute))) as BookingRuleRow[];
};

/**
 * Every booking that could possibly matter to a window, widened by the buffers.
 *
 * The widening is what makes an edge case correct rather than nearly correct: a
 * booking that ENDS just before the window can still block the window's first
 * slot through its trailing buffer, and one that starts just after can block
 * the last.
 */
const loadBusy = async (
  ctx: Ctx,
  resource: BookingResourceRow,
  fromMs: number,
  toMs: number,
  opts: { excludeId?: string } = {},
): Promise<BookingRow[]> => {
  const t = bookingsTable(ctx.dialect);
  const pad =
    (resource.bufferBeforeMinutes + resource.bufferAfterMinutes + resource.slotMinutes) * 60_000;
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(
      and(
        eq(t.resourceId, resource.id),
        inArray(t.status, OCCUPYING),
        lt(t.startAt, instant(ctx.dialect, toMs + pad)),
        gt(t.endAt, instant(ctx.dialect, fromMs - pad)),
      ),
    )) as BookingRow[];
  return opts.excludeId ? rows.filter((r) => r.id !== opts.excludeId) : rows;
};

const busyIntervals = (rows: BookingRow[], now: number): BusyInterval[] =>
  rows
    .filter((r) => stillOccupies(r, now))
    .map((r) => ({ start: asMs(r.startAt), end: asMs(r.endAt) }));

/* ──────────────────────────────── slots ─────────────────────────────────── */

export interface SlotsResult {
  resource: {
    key: string;
    name: string;
    description: string | null;
    timeZone: string;
    slotMinutes: number;
    capacity: number;
    questions: Array<Record<string, unknown>>;
    confirmationMessage: string | null;
    /** How the page paints itself. Null is "our defaults". */
    settings: BookingSettings | null;
  };
  from: string;
  to: string;
  slots: Array<{ start: string; end: string; remaining: number }>;
}

/**
 * The open slots for a resource in a window.
 *
 * `from`/`to` arrive from a public endpoint, so the window is clamped to
 * {@link MAX_RANGE_DAYS} before any walking happens — a request for the year
 * 3000 must cost a bounded amount of work rather than a bounded amount of
 * patience.
 */
export const listSlots = async (
  ctx: Ctx,
  resource: BookingResourceRow,
  window: { from?: number; to?: number },
  now = Date.now(),
): Promise<SlotsResult> => {
  const from = Math.max(window.from ?? now, now);
  const requested = window.to ?? from + 14 * 86_400_000;
  const to = Math.min(requested, from + MAX_RANGE_DAYS * 86_400_000);

  const rules = await loadRules(ctx, resource.id);
  const busyRows = await loadBusy(ctx, resource, from, to);
  const slots: Slot[] = availableSlots({
    policy: policyOf(resource),
    rules: rules.map(ruleOf),
    busy: busyIntervals(busyRows, now),
    from,
    to,
    now,
  });

  return {
    resource: {
      key: resource.key,
      name: resource.name,
      description: resource.description,
      timeZone: resource.timeZone,
      slotMinutes: resource.slotMinutes,
      capacity: resource.capacity,
      questions: resource.questions ?? [],
      confirmationMessage: resource.confirmationMessage,
      settings: resource.settings ?? null,
    },
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    slots: slots.map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      remaining: s.remaining,
    })),
  };
};

/* ─────────────────────────────── the guard ──────────────────────────────── */

/**
 * Does this error mean a unique index refused the row?
 *
 * The implementation moved to `services/items/sql-helpers.ts` and is re-exported
 * here so the booking capacity guard and the collection write path cannot drift
 * — which they had. This file grew a chain-walking version after a lost race
 * answered 500 on D1 instead of "that time was taken"; its twin over on the item
 * write path kept reading only the top link, so every unique violation on a
 * collection write went on answering 500 until 2026-08-04. Two hand-written
 * copies of one guard is the bug, not the specific miss.
 */
export { isUniqueViolation };

/**
 * Give back the seats held by bookings that are only still holding them
 * because nobody has said so out loud.
 *
 * Expiry is derived on every READ — a lapsed hold stops occupying its slot the
 * moment the clock passes it, with nothing having to run. The partial unique
 * index cannot see that: it reads a column. So the one writer who actually
 * needs the seat materialises the status, at the moment it needs it. This is
 * lazy on purpose. A cron that swept holds would be a second source of truth
 * about when a hold ends, and the wrong one whenever it was behind.
 */
const releaseLapsedHolds = async (
  ctx: Ctx,
  resourceId: string,
  start: number,
  now: number,
): Promise<number> => {
  const t = bookingsTable(ctx.dialect);
  const released = (await (ctx.db as AnyDb)
    .update(t)
    .set({ status: "expired", updatedAt: stampAt(ctx.dialect, now) })
    .where(
      and(
        eq(t.resourceId, resourceId),
        eq(t.startAt, instant(ctx.dialect, start)),
        eq(t.status, "held"),
        lt(t.holdExpiresAt, instant(ctx.dialect, now)),
      ),
    )
    .returning()) as BookingRow[];
  return released.length;
};

/**
 * Insert the booking into one of the resource's numbered places.
 *
 * This is where "no more than `capacity` at one instant" is actually decided,
 * and it is decided by the DATABASE. Read-then-write cannot do it: there is no
 * row lock on D1, so another writer fits between the count and the insert.
 * Insert-then-sort-and-withdraw cannot do it either, which is subtler and was
 * the first thing tried here — a booking that arrives late can sort ahead of
 * one that already checked and passed, and nothing goes back to re-check the
 * earlier one, so both keep their rows.
 *
 * The partial unique index on `(resource, start, seat)` settles it instead: the
 * writer walks the places in order and takes the first one that inserts. Losing
 * a place is a unique violation, which is an atomic answer rather than an
 * opinion. Running out of places is a full slot.
 */
const insertIntoSeat = async (
  ctx: Ctx,
  resource: BookingResourceRow,
  values: Record<string, unknown>,
  start: number,
  now: number,
): Promise<void> => {
  const t = bookingsTable(ctx.dialect);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let seat = 0; seat < resource.capacity; seat++) {
      try {
        await (ctx.db as AnyDb).insert(t).values({ ...values, seat });
        return;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Somebody else has this place. Try the next one.
      }
    }
    // Every place is taken by a row the index can see. Some of them may be
    // holds that have already lapsed, so say so and walk the places once more.
    if (attempt === 0) {
      const released = await releaseLapsedHolds(ctx, resource.id, start, now);
      if (released === 0) break;
    }
  }
  throw new AppError("CONFLICT", "That time was taken while you were booking it");
};

/**
 * The soft half of the guard: overlaps the seat index cannot see.
 *
 * The index keys on the exact start instant, which covers the published grid —
 * where every booking of a resource begins at one of the same instants. It does
 * NOT cover a booking that merely overlaps: an operator's irregular entry, a
 * differing duration, or two slots that only collide through the buffers.
 *
 * For those the contenders are re-read and sorted by `(createdAt, id)`, and a
 * row that is not among the first `capacity` withdraws. That ordering is only
 * as good as its agreement with insertion order, which is why this can no
 * longer be the only line of defence — but as a second one, over the cases the
 * index does not reach, it is the right shape. {@link bookingsConflict} being
 * SYMMETRIC is what stops two racers reaching opposite verdicts here.
 */
const claimSlot = async (
  ctx: Ctx,
  resource: BookingResourceRow,
  bookingId: string,
  start: number,
  end: number,
  now: number,
): Promise<void> => {
  const t = bookingsTable(ctx.dialect);
  const contenders = await loadBusy(ctx, resource, start, end);
  const policy = policyOf(resource);
  const mine = { start, end };

  const conflicting = contenders
    .filter((r) => stillOccupies(r, now))
    .filter((r) => bookingsConflict(mine, { start: asMs(r.startAt), end: asMs(r.endAt) }, policy))
    .sort((a, b) => asMs(a.createdAt) - asMs(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const position = conflicting.findIndex((r) => r.id === bookingId);
  // Not finding ourselves means our own row was already withdrawn or lapsed
  // between the insert and this read — treat it as a loss rather than as
  // permission, which is the safe direction.
  if (position === -1 || position >= resource.capacity) {
    await (ctx.db as AnyDb).delete(t).where(eq(t.id, bookingId));
    throw new AppError("CONFLICT", "That time was taken while you were booking it");
  }
};

/* ─────────────────────────────── recording ──────────────────────────────── */

/**
 * Where this resource's bookings are recorded, and under which column names.
 *
 * Two shapes, and the difference is who owns the schema. NULL `mirrorCollection`
 * means the collection WE provision, so the map is derived from the fields we
 * created rather than stored — there is nothing to keep in sync and nothing to
 * get wrong. A value means the workspace pointed us at its own collection, and
 * only then is the hand-authored `mirrorFieldMap` the answer.
 */
const resolveTarget = async (
  ctx: Ctx,
  resource: BookingResourceRow,
  tenantId: string | null,
): Promise<{ slug: string; map: Record<string, string> } | { error: string } | null> => {
  if (!tenantId || !resource.mirrorEnabled) return null;
  if (resource.mirrorCollection) {
    const map = resource.mirrorFieldMap ?? {};
    // A custom target with no map records nothing. That used to be silent and
    // was the whole reason this was rebuilt, so it is now said out loud.
    if (Object.values(map).filter(Boolean).length === 0) {
      return { error: `No field map for collection "${resource.mirrorCollection}"` };
    }
    return { slug: resource.mirrorCollection, map };
  }
  const ensured = await ensureBookingCollection(ctx, tenantId);
  if (ensured.conflict) {
    return {
      error:
        `Collection "${ensured.slug}" already exists but isn't a booking record target. ` +
        `Rename it, or point this resource at a collection of your own.`,
    };
  }
  return { slug: ensured.slug, map: DEFAULT_BOOKING_FIELD_MAP };
};

/**
 * The ledger values a map may name.
 *
 * `status` is the STORED status, not the derived one. `completed` and `expired`
 * are facts about the clock — writing one here would be a snapshot that is
 * wrong an hour later with nothing scheduled to correct it, whereas `ends_at`
 * lets any reader derive the same thing at the moment it asks.
 *
 * A key not listed here is looked up among the intake answers, which is what
 * lets a custom map point a column at a question. The precedence matters for a
 * question whose name collides with one of these: the ledger wins.
 */
const recordSource = (
  resource: BookingResourceRow,
  booking: BookingRow,
): Record<string, unknown> => ({
  booking: booking.id,
  start: new Date(asMs(booking.startAt)).toISOString(),
  end: new Date(asMs(booking.endAt)).toISOString(),
  name: booking.customerName,
  email: booking.customerEmail,
  phone: booking.customerPhone,
  status: booking.status,
  resource: resource.key,
  source: booking.source,
  notes: booking.notes,
  answers: booking.answers ?? {},
});

/** Find a record written for this booking when the pointer to it was lost —
 *  the first attempt failed after the row landed, or an older mirror never
 *  stored one. Only possible on a target carrying the `booking` column, which
 *  is every collection we provision and any custom map that names one. */
const findRecordId = async (
  ctx: Ctx,
  slug: string,
  tenantId: string,
  column: string,
  bookingId: string,
): Promise<string | null> => {
  const collection = await loadCollection(ctx, tenantId, slug);
  const rows = await queryAll<{ id: unknown }>(
    ctx,
    sql`SELECT ${sql.identifier(collection.pkColumn)} AS id
        FROM ${sql.identifier(collection.physicalTable)}
        WHERE ${sql.identifier(column)} = ${bookingId}
        LIMIT 1`,
  );
  const found = rows[0]?.id;
  return found == null ? null : String(found);
};

/**
 * Record a booking, or bring its record up to date. Called after every state
 * change — created, confirmed, cancelled, moved, marked absent.
 *
 * One function for both directions on purpose. The previous split (a create
 * that wrote every column, and a status push that wrote exactly one) is why a
 * reschedule left a record sitting at the old time still reading `confirmed`:
 * the move is a new booking, and nothing carried the new instant back to the
 * row the customer's own history is read from. Writing the whole row every time
 * costs one statement and cannot drift.
 *
 * Best-effort, and that is a deliberate asymmetry: the slot is already claimed
 * and the customer already has their confirmation, so a renamed collection must
 * not turn a booking into a 500. What changed is that the failure is now
 * WRITTEN — `mirrorError` on the ledger row — instead of being inferred from an
 * absent `mirrorItemId`, which reads identically to "recording is switched off".
 */
const recordBooking = async (
  ctx: Ctx,
  resource: BookingResourceRow,
  tenantId: string | null,
  booking: BookingRow,
): Promise<void> => {
  const target = await resolveTarget(ctx, resource, tenantId).catch((e: unknown) => ({
    error: (e as Error).message,
  }));
  if (!target) return;

  const t = bookingsTable(ctx.dialect);
  const stamp = (patch: Record<string, unknown>) =>
    (ctx.db as AnyDb).update(t).set(patch).where(eq(t.id, booking.id));

  if ("error" in target) {
    booking.mirrorError = target.error;
    await stamp({ mirrorError: target.error }).catch(() => {});
    return;
  }

  const values = recordSource(resource, booking);
  const data: Record<string, unknown> = {};
  for (const [from, column] of Object.entries(target.map)) {
    if (!column) continue;
    const value = from in values ? values[from] : (booking.answers ?? {})[from];
    if (value !== undefined) data[column] = value;
  }
  if (Object.keys(data).length === 0) return;

  try {
    let itemId = booking.mirrorItemId;
    if (!itemId && target.map.booking && tenantId) {
      itemId = await findRecordId(ctx, target.slug, tenantId, target.map.booking, booking.id);
    }
    if (itemId) {
      await updateItem(ctx, { slug: target.slug, tenantId: tenantId as string, id: itemId, data });
    } else {
      const created = await createItem(ctx, {
        slug: target.slug,
        tenantId: tenantId as string,
        data,
      });
      itemId = created.id;
    }
    booking.mirrorCollection = target.slug;
    booking.mirrorItemId = itemId;
    booking.mirrorError = null;
    await stamp({ mirrorCollection: target.slug, mirrorItemId: itemId, mirrorError: null });
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    booking.mirrorError = message;
    // The ledger is still right; a record that lagged is not worth a 500. But
    // it IS worth saying, so the admin can retry it rather than find out later.
    await stamp({ mirrorError: message }).catch(() => {});
  }
};

/**
 * Re-run the recording for one booking, on request.
 *
 * The counterpart to writing `mirrorError` down: a failure an operator can see
 * and cannot act on is only half an improvement. Reloads the resource because
 * the fix is usually there — a collection renamed back, a map corrected.
 */
export const retryBookingRecord = async (
  ctx: Ctx,
  tenantId: string | null,
  bookingId: string,
): Promise<PublicBooking> => {
  const t = bookingsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, bookingId), tenantWhere(t, tenantId)))
    .limit(1)) as BookingRow[];
  const booking = rows[0];
  if (!booking) throw new AppError("NOT_FOUND", "Booking not found");
  const resource = await loadResourceById(ctx, tenantId, booking.resourceId);
  if (!resource) throw new AppError("NOT_FOUND", "Booking not found");
  await recordBooking(ctx, resource, booking.tenantId, booking);
  // The retry is a request to fix something, so unlike the write path it is
  // allowed to fail loudly — an operator pressing "try again" is owed the
  // reason it did not work rather than a row that looks unchanged.
  if (booking.mirrorError) throw new AppError("VALIDATION", booking.mirrorError);
  return toPublicBooking(booking);
};

/* ──────────────────────────────── events ───────────────────────────────── */

/**
 * Announce a booking to the handlers that act on one — flows, webhooks, event
 * functions, extension hooks.
 *
 * `dispatchEventHandlers`, NOT `publishEvent`, and the difference is the whole
 * point. `publishEvent` also puts the payload on the realtime bus, where two
 * things are true at once: an unrecognised channel name is open to any
 * subscriber (`gateForChannel` falls through to "no auth, no filter"), and a
 * payload that is not item-shaped gets no per-subscriber permission filter. A
 * booking carries a customer's name, email address and telephone number. Those
 * belong to the operator who took the booking and to nobody who happens to open
 * an SSE stream, so this event reaches its handlers without ever being
 * broadcast.
 *
 * The channel is `booking`, singular, and not `bookings` — item events publish
 * on `items:<slug>`, but three of the schema templates own a collection called
 * `bookings`, and a trigger pattern that matched both a template's rows and the
 * system's own events would fire a workspace's reminder flow twice.
 *
 * Fire-and-forget: a flow that throws must not fail the customer's booking.
 */
const announce = (
  ctx: Ctx,
  tenantId: string | null,
  event: "created" | "confirmed" | "cancelled" | "rescheduled" | "no_show",
  booking: PublicBooking,
  resource: BookingResourceRow,
): void => {
  dispatchEventHandlers(
    ctx.env,
    "booking",
    { event, data: { ...booking, resourceKey: resource.key, resourceName: resource.name } },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId },
  );
};

/* ──────────────────────────────── emails ───────────────────────────────── */

export const bookingPageUrl = (ctx: Ctx, token: string): string =>
  `${(ctx.env.APP_URL ?? "").replace(/\/+$/, "")}/book/${token}`;

/**
 * `/b/`, not `/booking/`. The admin SPA reads the second path segment as a
 * sub-route under a nav id, so a future `/booking/<id>` detail view would be
 * captured by the public manage page instead. A short prefix is also kinder in
 * an email.
 */
export const manageUrl = (ctx: Ctx, token: string): string =>
  `${(ctx.env.APP_URL ?? "").replace(/\/+$/, "")}/b/${token}`;

const localTime = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(ms));

/**
 * Confirmation mail, with the calendar invite attached.
 *
 * The `.ics` uid is the BOOKING ID rather than a fresh value, which is what
 * lets a reschedule replace the event in the customer's calendar instead of
 * adding a second one — the same reason `packages/core/src/ics.ts` refuses to
 * generate one.
 */
const sendBookingEmail = async (
  ctx: Ctx,
  tenantId: string | null,
  resource: BookingResourceRow,
  booking: BookingRow,
  kind: "confirmed" | "cancelled" | "rescheduled",
  manageToken: string | null,
  sequence = 0,
): Promise<boolean> => {
  const to = booking.customerEmail;
  if (!to) return false;

  const start = asMs(booking.startAt);
  const when = localTime(start, resource.timeZone);
  const host = (ctx.env.APP_URL ?? "https://backlex.local").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const link = manageToken ? manageUrl(ctx, manageToken) : null;

  const subject =
    kind === "cancelled"
      ? `Cancelled: ${resource.name} — ${when}`
      : kind === "rescheduled"
        ? `Moved: ${resource.name} — ${when}`
        : `Confirmed: ${resource.name} — ${when}`;

  const ics = buildIcs({
    uid: `${booking.id}@${host}`,
    dtstamp: new Date(),
    start: new Date(start),
    end: new Date(asMs(booking.endAt)),
    summary: resource.name,
    description: resource.description ?? undefined,
    url: link ?? undefined,
    sequence,
    status: kind === "cancelled" ? "CANCELLED" : "CONFIRMED",
    method: kind === "cancelled" ? "CANCEL" : "PUBLISH",
  });

  const body =
    kind === "cancelled"
      ? `<p>Your booking for <strong>${resource.name}</strong> on ${when} has been cancelled.</p>`
      : `<p>Your booking for <strong>${resource.name}</strong> is confirmed for <strong>${when}</strong>.</p>${
          resource.confirmationMessage ? `<p>${resource.confirmationMessage}</p>` : ""
        }${link ? `<p><a href="${link}">Change or cancel this booking</a></p>` : ""}`;

  const result = await sendTemplatedEmail(ctx, {
    to,
    templateKey: `booking.${kind}`,
    tenantId,
    vars: {
      resource: resource.name,
      when,
      manageUrl: link ?? "",
      customerName: booking.customerName ?? "",
    },
    fallback: { subject, html: body },
    attachments: [
      {
        filename: "invite.ics",
        // base64, per `EmailAttachment.content` — raw text is refused by the
        // managed mail gateway and corrupts the file on the transports that
        // accept it.
        content: icsAttachmentContent(ics),
        contentType: "text/calendar; charset=utf-8; method=REQUEST",
      },
    ],
  });
  return result.sent;
};

/* ────────────────────────── resource administration ─────────────────────── */

export interface ResourceInput {
  key?: string;
  name?: string;
  description?: string | null;
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
  /** Whether bookings are recorded in a collection at all. Defaults to true. */
  mirrorEnabled?: boolean;
  /** Null/absent records into the provisioned default (`booking_records`); a
   *  value points at a collection of your own, which then needs a field map. */
  mirrorCollection?: string | null;
  mirrorFieldMap?: Record<string, string> | null;
  active?: boolean;
  confirmationMessage?: string | null;
  notifyEmails?: string[];
  rules?: Array<Omit<AvailabilityRule, "kind"> & { kind?: "open" | "block"; reason?: string | null }>;
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const validateTimeZone = (tz: string): string => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new AppError("VALIDATION", `"${tz}" is not a known IANA time zone`);
  }
};

/**
 * Normalise the numeric policy.
 *
 * Every one of these is clamped rather than rejected, except where a value
 * would make the resource nonsensical rather than merely extreme: a slot has
 * to have a length and a capacity has to be at least one. The clamps exist so a
 * horizon of a million days cannot turn a public slot listing into a denial of
 * service against the workspace that configured it.
 */
const normalizePolicy = (input: ResourceInput, base?: BookingResourceRow) => {
  const slotMinutes = clamp(
    Math.round(input.slotMinutes ?? base?.slotMinutes ?? 30),
    MIN_SLOT_MINUTES,
    MAX_SLOT_MINUTES,
  );
  const rawStep = input.stepMinutes === undefined ? base?.stepMinutes ?? null : input.stepMinutes;
  return {
    slotMinutes,
    stepMinutes:
      rawStep == null ? null : clamp(Math.round(rawStep), MIN_SLOT_MINUTES, MAX_SLOT_MINUTES),
    capacity: clamp(Math.round(input.capacity ?? base?.capacity ?? 1), 1, MAX_CAPACITY),
    bufferBeforeMinutes: clamp(
      Math.round(input.bufferBeforeMinutes ?? base?.bufferBeforeMinutes ?? 0),
      0,
      MAX_BUFFER_MINUTES,
    ),
    bufferAfterMinutes: clamp(
      Math.round(input.bufferAfterMinutes ?? base?.bufferAfterMinutes ?? 0),
      0,
      MAX_BUFFER_MINUTES,
    ),
    leadMinutes: clamp(Math.round(input.leadMinutes ?? base?.leadMinutes ?? 0), 0, 365 * 24 * 60),
    horizonDays: clamp(Math.round(input.horizonDays ?? base?.horizonDays ?? 60), 1, MAX_HORIZON_DAYS),
    holdMinutes: clamp(Math.round(input.holdMinutes ?? base?.holdMinutes ?? 10), 1, MAX_HOLD_MINUTES),
  };
};

const normalizeRules = (
  input: NonNullable<ResourceInput["rules"]>,
): Array<Omit<BookingRuleRow, "id" | "resourceId" | "createdAt" | "updatedAt">> => {
  if (input.length > MAX_RULES_PER_RESOURCE) {
    throw new AppError("VALIDATION", `A resource takes at most ${MAX_RULES_PER_RESOURCE} rules`);
  }
  return input.map((r) => {
    const startMinute = Math.round(r.startMinute);
    const endMinute = Math.round(r.endMinute);
    if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) {
      throw new AppError("VALIDATION", "A rule needs a numeric startMinute and endMinute");
    }
    if (startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
      // The upper bound is what keeps "wraps around midnight" out of the whole
      // system: a night shift is two rules, and every interval anywhere can
      // then be read as a plain [start, end).
      throw new AppError(
        "VALIDATION",
        "A rule must satisfy 0 <= startMinute < endMinute <= 1440 — a span crossing midnight is two rules",
      );
    }
    if (r.weekday != null && (r.weekday < 0 || r.weekday > 6)) {
      throw new AppError("VALIDATION", "weekday must be 0 (Sunday) … 6 (Saturday)");
    }
    for (const bound of [r.startsOn, r.endsOn]) {
      if (bound != null && !/^\d{4}-\d{2}-\d{2}$/.test(bound)) {
        throw new AppError("VALIDATION", "startsOn / endsOn must be YYYY-MM-DD dates");
      }
    }
    if (r.startsOn && r.endsOn && r.startsOn > r.endsOn) {
      throw new AppError("VALIDATION", "startsOn must not be after endsOn");
    }
    if (r.weekday == null && !r.startsOn && !r.endsOn) {
      // A dateless, weekdayless rule applies to every day forever. As a block
      // that closes the resource permanently, which reads as "booking is
      // broken" rather than as a configuration choice.
      throw new AppError(
        "VALIDATION",
        "A rule with no weekday needs a startsOn / endsOn range — otherwise it applies to every day forever",
      );
    }
    return {
      kind: r.kind === "block" ? "block" : "open",
      weekday: r.weekday ?? null,
      startMinute,
      endMinute,
      startsOn: r.startsOn ?? null,
      endsOn: r.endsOn ?? null,
      reason: trimmed(r.reason, 200),
    };
  });
};

const writeRules = async (
  ctx: Ctx,
  resourceId: string,
  rules: NonNullable<ResourceInput["rules"]>,
): Promise<void> => {
  const normalized = normalizeRules(rules);
  const t = rulesTable(ctx.dialect);
  // The rule set is REPLACED rather than merged. A partial update would need
  // stable ids the admin does not have while the operator is dragging a week
  // around, and "these are my opening hours" is the shape every caller means.
  await (ctx.db as AnyDb).delete(t).where(eq(t.resourceId, resourceId));
  if (normalized.length === 0) return;
  const now = stampAt(ctx.dialect, Date.now());
  const rows = normalized.map((r) => ({
    id: crypto.randomUUID(),
    resourceId,
    ...r,
    createdAt: now,
    updatedAt: now,
  }));
  // One statement per batch, because a multi-row insert binds a parameter per
  // COLUMN per row and SQLite stops at 100 of them: eleven columns made ten
  // rules the point where "save my opening hours" answered 500. The rules are
  // already deleted by now, so that 500 did not leave the old hours in place —
  // it left the resource with none, which is a calendar that silently stopped
  // taking bookings. The cap is deliberately well under the ceiling; the win
  // from packing rows tighter is not worth being one column away from it again.
  for (let i = 0; i < rows.length; i += RULES_PER_INSERT) {
    await (ctx.db as AnyDb).insert(t).values(rows.slice(i, i + RULES_PER_INSERT));
  }
};

export interface CreatedResource {
  resource: PublicResource;
  /** Shown ONCE. Only its hash is stored, so this is the only time the public
   *  page URL can be produced. */
  token: string;
  url: string;
}

export const createResource = async (
  ctx: Ctx,
  tenantId: string | null,
  input: ResourceInput,
  createdBy: string | null,
): Promise<CreatedResource> => {
  const key = String(input.key ?? "").trim().toLowerCase();
  if (!KEY_RE.test(key)) {
    throw new AppError("VALIDATION", "key must be lowercase letters, digits, dash or underscore");
  }
  const name = trimmed(input.name, MAX_NAME);
  if (!name) throw new AppError("VALIDATION", "A resource needs a name");

  const existing = await loadResource(ctx, tenantId, key);
  if (existing) throw new AppError("CONFLICT", `A booking resource with key "${key}" already exists`);

  if ((input.questions?.length ?? 0) > MAX_QUESTIONS) {
    throw new AppError("VALIDATION", `A resource takes at most ${MAX_QUESTIONS} questions`);
  }
  // Same rule as `updateResource`: a custom target with no map records nothing,
  // and being told at the moment of saving beats finding out per booking.
  const customTarget = trimmed(input.mirrorCollection, 100);
  if (
    (input.mirrorEnabled ?? true) &&
    customTarget &&
    Object.values(input.mirrorFieldMap ?? {}).filter(Boolean).length === 0
  ) {
    throw new AppError(
      "VALIDATION",
      `Collection "${customTarget}" needs a field map saying which column each booking field goes to — ` +
        `or omit it to record into the default collection instead`,
    );
  }

  const token = `${RESOURCE_TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const id = crypto.randomUUID();
  const now = stampAt(ctx.dialect, Date.now());
  const t = resourcesTable(ctx.dialect);

  await (ctx.db as AnyDb).insert(t).values({
    id,
    tenantId,
    key,
    name,
    description: trimmed(input.description, 2000),
    timeZone: validateTimeZone(input.timeZone?.trim() || "UTC"),
    ...normalizePolicy(input),
    questions: input.questions ?? [],
    settings: normalizeBookingSettings(input.settings),
    mirrorEnabled: input.mirrorEnabled ?? true,
    mirrorCollection: trimmed(input.mirrorCollection, 100),
    mirrorFieldMap: input.mirrorFieldMap ?? null,
    tokenHash: await hashToken(token),
    active: input.active ?? true,
    confirmationMessage: trimmed(input.confirmationMessage, 2000),
    notifyEmails: (input.notifyEmails ?? []).map((e) => normalizeEmail(e, "notify")),
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (input.rules) await writeRules(ctx, id, input.rules);

  // Provision the collection now rather than on the first booking, so an
  // operator setting a resource up sees where its bookings will land while they
  // are still thinking about it. The write path ensures it too — this is the
  // early call, not the only one — because a resource created before this
  // existed never came through here.
  if (tenantId && (input.mirrorEnabled ?? true) && !trimmed(input.mirrorCollection, 100)) {
    await ensureBookingCollection(ctx, tenantId).catch(() => {
      /* a resource that could not provision its collection is still a resource;
         the write path reports the failure per booking. */
    });
  }

  const row = (await loadResourceById(ctx, tenantId, id))!;
  const rules = await loadRules(ctx, id);
  return { resource: toPublicResource(row, rules), token, url: bookingPageUrl(ctx, token) };
};

export const updateResource = async (
  ctx: Ctx,
  tenantId: string | null,
  keyOrId: string,
  input: ResourceInput,
): Promise<PublicResource> => {
  const row = await loadResource(ctx, tenantId, keyOrId);
  if (!row) throw new AppError("NOT_FOUND", "Booking resource not found");

  const patch: Record<string, unknown> = {
    updatedAt: stampAt(ctx.dialect, Date.now()),
    ...normalizePolicy(input, row),
  };
  if (input.name !== undefined) {
    const name = trimmed(input.name, MAX_NAME);
    if (!name) throw new AppError("VALIDATION", "A resource needs a name");
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = trimmed(input.description, 2000);
  if (input.timeZone !== undefined) patch.timeZone = validateTimeZone(input.timeZone.trim());
  if (input.questions !== undefined) {
    if (input.questions.length > MAX_QUESTIONS) {
      throw new AppError("VALIDATION", `A resource takes at most ${MAX_QUESTIONS} questions`);
    }
    patch.questions = input.questions;
  }
  // Appearance is replaced wholesale rather than merged: the admin sends the
  // panel it just rendered, and a merge would make "back to the default accent"
  // impossible to say. `null` clears it.
  if (input.settings !== undefined) patch.settings = normalizeBookingSettings(input.settings);
  if (input.mirrorEnabled !== undefined) patch.mirrorEnabled = input.mirrorEnabled;
  if (input.mirrorCollection !== undefined) {
    patch.mirrorCollection = trimmed(input.mirrorCollection, 100);
  }
  if (input.mirrorFieldMap !== undefined) patch.mirrorFieldMap = input.mirrorFieldMap;
  // Pointing a resource at your own collection means the map is yours to
  // supply, and a target with no map records nothing. That silence is the bug
  // this feature was rebuilt around, so it is refused at the point of saving
  // rather than discovered one uncollected booking at a time.
  {
    const nextCollection =
      patch.mirrorCollection !== undefined
        ? (patch.mirrorCollection as string | null)
        : row.mirrorCollection;
    const nextMap = (
      patch.mirrorFieldMap !== undefined ? patch.mirrorFieldMap : row.mirrorFieldMap
    ) as Record<string, string> | null;
    const enabled =
      patch.mirrorEnabled !== undefined ? (patch.mirrorEnabled as boolean) : row.mirrorEnabled;
    if (enabled && nextCollection && Object.values(nextMap ?? {}).filter(Boolean).length === 0) {
      throw new AppError(
        "VALIDATION",
        `Collection "${nextCollection}" needs a field map saying which column each booking field goes to — ` +
          `or clear it to record into the default collection instead`,
      );
    }
  }
  if (input.active !== undefined) patch.active = input.active;
  if (input.confirmationMessage !== undefined) {
    patch.confirmationMessage = trimmed(input.confirmationMessage, 2000);
  }
  if (input.notifyEmails !== undefined) {
    patch.notifyEmails = input.notifyEmails.map((e) => normalizeEmail(e, "notify"));
  }

  const t = resourcesTable(ctx.dialect);
  await (ctx.db as AnyDb).update(t).set(patch).where(eq(t.id, row.id));
  if (input.rules !== undefined) await writeRules(ctx, row.id, input.rules);

  const updated = (await loadResourceById(ctx, tenantId, row.id))!;
  return toPublicResource(updated, await loadRules(ctx, row.id));
};

export const listResources = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<PublicResource[]> => {
  const t = resourcesTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(tenantWhere(t, tenantId))
    .orderBy(asc(t.name))) as BookingResourceRow[];
  if (rows.length === 0) return [];
  const rt = rulesTable(ctx.dialect);
  const allRules = (await (ctx.db as AnyDb)
    .select()
    .from(rt)
    .where(
      inArray(
        rt.resourceId,
        rows.map((r) => r.id),
      ),
    )) as BookingRuleRow[];
  return rows.map((r) => toPublicResource(r, allRules.filter((x) => x.resourceId === r.id)));
};

export const getResource = async (
  ctx: Ctx,
  tenantId: string | null,
  keyOrId: string,
): Promise<PublicResource> => {
  const row = await loadResource(ctx, tenantId, keyOrId);
  if (!row) throw new AppError("NOT_FOUND", "Booking resource not found");
  return toPublicResource(row, await loadRules(ctx, row.id));
};

/**
 * Delete a resource and everything hanging off it.
 *
 * Refuses while upcoming bookings exist unless the caller says otherwise: the
 * rows would be orphaned and the people in them are expecting to be seen.
 */
export const deleteResource = async (
  ctx: Ctx,
  tenantId: string | null,
  keyOrId: string,
  opts: { force?: boolean } = {},
): Promise<void> => {
  const row = await loadResource(ctx, tenantId, keyOrId);
  if (!row) throw new AppError("NOT_FOUND", "Booking resource not found");

  const now = Date.now();
  const bt = bookingsTable(ctx.dialect);
  const upcoming = (await (ctx.db as AnyDb)
    .select()
    .from(bt)
    .where(
      and(
        eq(bt.resourceId, row.id),
        inArray(bt.status, OCCUPYING),
        gt(bt.startAt, instant(ctx.dialect, now)),
      ),
    )) as BookingRow[];
  const live = upcoming.filter((b) => stillOccupies(b, now));
  if (live.length > 0 && !opts.force) {
    throw new AppError(
      "CONFLICT",
      `${live.length} upcoming booking(s) still reference this resource — cancel them first or pass force`,
    );
  }

  await (ctx.db as AnyDb).delete(rulesTable(ctx.dialect)).where(eq(rulesTable(ctx.dialect).resourceId, row.id));
  await (ctx.db as AnyDb).delete(bt).where(eq(bt.resourceId, row.id));
  await (ctx.db as AnyDb).delete(resourcesTable(ctx.dialect)).where(eq(resourcesTable(ctx.dialect).id, row.id));
};

/** Mint a new public token, invalidating the old page link. */
export const rotateResourceToken = async (
  ctx: Ctx,
  tenantId: string | null,
  keyOrId: string,
): Promise<{ token: string; url: string }> => {
  const row = await loadResource(ctx, tenantId, keyOrId);
  if (!row) throw new AppError("NOT_FOUND", "Booking resource not found");
  const token = `${RESOURCE_TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const t = resourcesTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      tokenHash: await hashToken(token),
      updatedAt: stampAt(ctx.dialect, Date.now()),
    })
    .where(eq(t.id, row.id));
  return { token, url: bookingPageUrl(ctx, token) };
};

/* ────────────────────────────── token resolution ────────────────────────── */

/**
 * Resolve a public page token. Paused and unknown both answer `null`, so the
 * route can refuse identically and the endpoint cannot be used to discover
 * which tokens ever existed.
 */
export const resolveResourceToken = async (
  ctx: Ctx,
  token: string,
): Promise<BookingResourceRow | null> => {
  const t = resourcesTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tokenHash, await hashToken(token)))
    .limit(1)) as BookingResourceRow[];
  const row = rows[0];
  if (!row || !row.active) return null;
  return row;
};

export interface ResolvedBooking {
  booking: BookingRow;
  resource: BookingResourceRow;
}

/**
 * The same (booking, resource) pair, reached by id instead of by token.
 *
 * Every mutation works from a resolved pair so the public and the operator
 * paths cannot drift apart in what they check. The operator has an id and a
 * workspace; the booker has a token and nothing else. Both arrive here.
 */
export const resolveBookingById = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<ResolvedBooking> => {
  const t = bookingsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), tenantWhere(t, tenantId)))
    .limit(1)) as BookingRow[];
  const booking = rows[0];
  if (!booking) throw new AppError("NOT_FOUND", "Booking not found");
  const resource = await loadResourceById(ctx, tenantId, booking.resourceId);
  if (!resource) throw new AppError("NOT_FOUND", "Booking resource not found");
  return { booking, resource };
};

export const resolveManageToken = async (
  ctx: Ctx,
  token: string,
): Promise<ResolvedBooking | null> => {
  const t = bookingsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tokenHash, await hashToken(token)))
    .limit(1)) as BookingRow[];
  const booking = rows[0];
  if (!booking) return null;
  const resource = await loadResourceById(ctx, booking.tenantId, booking.resourceId);
  if (!resource) return null;
  return { booking, resource };
};

/* ─────────────────────────────── booking ────────────────────────────────── */

export interface BookInput {
  start: string | number;
  /** Optional; the resource's `slotMinutes` decides it when absent, which is
   *  the only shape the public page ever sends. */
  end?: string | number;
  name?: string;
  email?: string;
  phone?: string;
  answers?: Record<string, unknown>;
  notes?: string;
  /** `held` parks the slot while a deposit is taken; the default confirms. */
  hold?: boolean;
}

export interface BookResult {
  booking: PublicBooking;
  /** The stored row, so a caller that needs a different projection of it — the
   *  booker's own view, say — does not have to read it back. */
  row: BookingRow;
  /** Shown ONCE. Only its hash is stored, so this response and the confirmation
   *  email are the only places the manage link exists. */
  manageToken: string;
  manageUrl: string;
  emailed: boolean;
}

const parseInstant = (value: string | number, what: string): number => {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new AppError("VALIDATION", `${what} is not a valid date`);
  return ms;
};

/**
 * Validate the booker's answers against the resource's questions.
 *
 * Unknown keys are DROPPED rather than rejected: the answers land in a JSON
 * column and, when a mirror map names them, in a collection column. Accepting
 * whatever a public form posts would let anybody grow that column without an
 * operator ever having asked a question.
 *
 * `required` binds the PUBLIC page only, for the same reason the published grid
 * does: the intake questions are that page's contract with the person filling
 * it in. An operator writing down a booking taken over the telephone may not
 * have asked them yet, and refusing the booking loses the appointment rather
 * than gaining the answer. What is supplied is still validated either way — a
 * choice outside its options is a mistake on any path.
 */
const normalizeAnswers = (
  resource: BookingResourceRow,
  raw: Record<string, unknown> | undefined,
  enforceRequired: boolean,
): Record<string, unknown> => {
  const questions = resource.questions ?? [];
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    const name = String(q.name ?? "");
    if (!name) continue;
    const value = raw?.[name];
    const required = q.required === true && enforceRequired;
    if (value === undefined || value === null || value === "") {
      if (required) throw new AppError("VALIDATION", `"${q.label ?? name}" is required`);
      continue;
    }
    const options = Array.isArray(q.options) ? (q.options as unknown[]).map(String) : null;
    const asText = typeof value === "boolean" ? value : String(value).slice(0, MAX_ANSWER_LENGTH);
    if (options && options.length > 0 && !options.includes(String(value))) {
      throw new AppError("VALIDATION", `"${q.label ?? name}" must be one of: ${options.join(", ")}`);
    }
    out[name] = asText;
  }
  return out;
};

/**
 * Take a slot.
 *
 * The order is deliberate and each step depends on the one before:
 *
 *   1. The instant is checked against the RULES (`slotIsOffered`) — is this a
 *      time the resource ever publishes? That is a pure question and answering
 *      it first means a nonsense request never touches the bookings table.
 *   2. The row is inserted.
 *   3. {@link claimSlot} decides whether it may keep its place.
 *
 * The mirror, the email and the event all happen AFTER the claim is settled.
 * Mirroring a booking that is about to be withdrawn would leave a row in the
 * workspace's own collection for an appointment that never existed.
 */
export const createBooking = async (
  ctx: Ctx,
  tenantId: string | null,
  resource: BookingResourceRow,
  input: BookInput,
  meta: { source: "public" | "admin" | "api"; createdBy?: string | null } = { source: "api" },
  now = Date.now(),
): Promise<BookResult> => {
  if (!resource.active && meta.source === "public") {
    throw new AppError("NOT_FOUND", "This booking page is not available");
  }

  const start = parseInstant(input.start, "start");
  const end = input.end !== undefined
    ? parseInstant(input.end, "end")
    : start + resource.slotMinutes * 60_000;

  const rules = await loadRules(ctx, resource.id);
  const policy = policyOf(resource);

  // An operator entering a booking for somebody who rang up is allowed outside
  // the published grid — that is what the phone call was for. A public booker
  // is not: the grid is the offer, and anything else was never on it.
  if (meta.source === "public") {
    const offered = slotIsOffered({ policy, rules: rules.map(ruleOf), start, end, now });
    if (!offered.ok) {
      const message =
        offered.reason === "past" || offered.reason === "lead"
          ? "That time is no longer available"
          : offered.reason === "horizon"
            ? "That date is further ahead than this calendar goes"
            : "That is not a time this resource offers";
      throw new AppError("VALIDATION", message);
    }
  } else if (end <= start) {
    throw new AppError("VALIDATION", "end must be after start");
  }

  const email = input.email === undefined || input.email === null || input.email === ""
    ? null
    : normalizeEmail(input.email);
  const answers = normalizeAnswers(resource, input.answers, meta.source === "public");

  const id = crypto.randomUUID();
  const manageToken = `${MANAGE_TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const status = input.hold ? "held" : "confirmed";
  const stamp = stampAt(ctx.dialect, now);
  const t = bookingsTable(ctx.dialect);

  // The seat walk is the hard guarantee; `claimSlot` then catches the overlaps
  // an index keyed on the exact start instant cannot see.
  await insertIntoSeat(
    ctx,
    resource,
    {
      id,
      tenantId,
      resourceId: resource.id,
      startAt: instant(ctx.dialect, start),
      endAt: instant(ctx.dialect, end),
      status,
      holdExpiresAt: input.hold ? instant(ctx.dialect, now + resource.holdMinutes * 60_000) : null,
      customerName: trimmed(input.name, MAX_NAME),
      customerEmail: email,
      customerPhone: trimmed(input.phone, 50),
      answers,
      notes: trimmed(input.notes, MAX_NOTES),
      tokenHash: await hashToken(manageToken),
      mirrorCollection: resource.mirrorCollection,
      source: meta.source,
      createdBy: meta.createdBy ?? null,
      createdAt: stamp,
      updatedAt: stamp,
    },
    start,
    now,
  );

  await claimSlot(ctx, resource, id, start, end, now);

  const rows = (await (ctx.db as AnyDb).select().from(t).where(eq(t.id, id)).limit(1)) as BookingRow[];
  const booking = rows[0]!;

  await recordBooking(ctx, resource, tenantId, booking);

  let emailed = false;
  if (email && status === "confirmed") {
    emailed = await sendBookingEmail(ctx, tenantId, resource, booking, "confirmed", manageToken);
  }

  const view = toPublicBooking(booking, now);
  announce(ctx, tenantId, "created", view, resource);

  return { booking: view, row: booking, manageToken, manageUrl: manageUrl(ctx, manageToken), emailed };
};

/** Promote a hold to a confirmation — what a paid deposit or a completed form
 *  calls. Re-checking the slot is unnecessary: the hold has occupied it the
 *  whole time. */
export const confirmBooking = async (
  ctx: Ctx,
  tenantId: string | null,
  bookingId: string,
  now = Date.now(),
): Promise<PublicBooking> => {
  const t = bookingsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, bookingId), tenantWhere(t, tenantId)))
    .limit(1)) as BookingRow[];
  const booking = rows[0];
  if (!booking) throw new AppError("NOT_FOUND", "Booking not found");
  if (booking.status !== "held") {
    throw new AppError("VALIDATION", `Only a held booking can be confirmed (this one is ${booking.status})`);
  }
  if (!stillOccupies(booking, now)) {
    // The hold lapsed and the slot may already have gone to somebody else.
    throw new AppError("CONFLICT", "That hold expired");
  }

  await (ctx.db as AnyDb)
    .update(t)
    .set({
      status: "confirmed",
      holdExpiresAt: null,
      updatedAt: stampAt(ctx.dialect, now),
    })
    .where(eq(t.id, bookingId));

  const resource = (await loadResourceById(ctx, tenantId, booking.resourceId))!;
  booking.status = "confirmed";
  booking.holdExpiresAt = null;
  await recordBooking(ctx, resource, tenantId, booking);

  const view = toPublicBooking(booking, now);
  announce(ctx, tenantId, "confirmed", view, resource);
  return view;
};

export const cancelBooking = async (
  ctx: Ctx,
  resolved: ResolvedBooking,
  opts: { reason?: string; cancelledBy?: string | null; notify?: boolean } = {},
  now = Date.now(),
): Promise<PublicBooking> => {
  const { booking, resource } = resolved;
  const status = effectiveBookingStatus(booking, now);
  if (status === "cancelled") {
    // Idempotent rather than an error: a customer double-clicking the link in
    // their confirmation mail has not done anything wrong.
    return toPublicBooking(booking, now);
  }
  if (status !== "confirmed" && status !== "held") {
    throw new AppError("VALIDATION", `A ${status} booking cannot be cancelled`);
  }

  const t = bookingsTable(ctx.dialect);
  const stamp = stampAt(ctx.dialect, now);
  // Guarded on the CURRENT status and confirmed by the returned row, so two
  // cancellations racing produce one cancellation and one no-op.
  const updated = (await (ctx.db as AnyDb)
    .update(t)
    .set({
      status: "cancelled",
      cancelledAt: stamp,
      cancelReason: trimmed(opts.reason, MAX_CANCEL_REASON),
      cancelledBy: opts.cancelledBy ?? null,
      updatedAt: stamp,
    })
    .where(and(eq(t.id, booking.id), eq(t.status, booking.status)))
    .returning()) as BookingRow[];
  if (updated.length === 0) return toPublicBooking(booking, now);

  const row = updated[0]!;
  await recordBooking(ctx, resource, booking.tenantId, row);
  if (opts.notify !== false && row.customerEmail) {
    await sendBookingEmail(ctx, booking.tenantId, resource, row, "cancelled", null, 1);
  }

  const view = toPublicBooking(row, now);
  announce(ctx, booking.tenantId, "cancelled", view, resource);
  return view;
};

/**
 * Move a booking to another time.
 *
 * Implemented as cancel-then-book rather than as an UPDATE, and the new row
 * goes through the same {@link claimSlot} every other booking does. An in-place
 * update would have to re-run the guard against a row that is already sitting
 * in the destination window — conflicting with ITSELF — and the trail of where
 * the appointment used to be would be gone.
 */
export const rescheduleBooking = async (
  ctx: Ctx,
  resolved: ResolvedBooking,
  start: string | number,
  meta: { source: "public" | "admin" | "api"; createdBy?: string | null },
  now = Date.now(),
): Promise<BookResult> => {
  const { booking, resource } = resolved;
  const status = effectiveBookingStatus(booking, now);
  if (status !== "confirmed" && status !== "held") {
    throw new AppError("VALIDATION", `A ${status} booking cannot be moved`);
  }

  const next = await createBooking(
    ctx,
    booking.tenantId,
    resource,
    {
      start,
      name: booking.customerName ?? undefined,
      email: booking.customerEmail ?? undefined,
      phone: booking.customerPhone ?? undefined,
      answers: (booking.answers ?? {}) as Record<string, unknown>,
      notes: booking.notes ?? undefined,
      hold: booking.status === "held",
    },
    meta,
    now,
  );

  const t = bookingsTable(ctx.dialect);
  const stamp = stampAt(ctx.dialect, now);
  // Only once the new slot is secured. The old row is released last so a failed
  // claim leaves the customer with the appointment they already had.
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      status: "cancelled",
      cancelledAt: stamp,
      cancelReason: "Rescheduled",
      rescheduledToId: next.booking.id,
      updatedAt: stamp,
    })
    .where(eq(t.id, booking.id));

  // The in-memory row still says `confirmed` — the UPDATE above went straight
  // to the database. Recording reads this object, so the release has to be
  // reflected here too or the record keeps the moved-from booking alive.
  booking.status = "cancelled";
  await recordBooking(ctx, resource, booking.tenantId, booking);
  announce(ctx, booking.tenantId, "rescheduled", next.booking, resource);
  return next;
};

export const markNoShow = async (
  ctx: Ctx,
  tenantId: string | null,
  bookingId: string,
  now = Date.now(),
): Promise<PublicBooking> => {
  const t = bookingsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, bookingId), tenantWhere(t, tenantId)))
    .limit(1)) as BookingRow[];
  const booking = rows[0];
  if (!booking) throw new AppError("NOT_FOUND", "Booking not found");
  if (booking.status !== "confirmed") {
    throw new AppError("VALIDATION", "Only a confirmed booking can be marked as a no-show");
  }

  const stamp = stampAt(ctx.dialect, now);
  await (ctx.db as AnyDb).update(t).set({ status: "no_show", updatedAt: stamp }).where(eq(t.id, bookingId));
  booking.status = "no_show";

  const resource = (await loadResourceById(ctx, tenantId, booking.resourceId))!;
  await recordBooking(ctx, resource, tenantId, booking);
  const view = toPublicBooking(booking, now);
  announce(ctx, tenantId, "no_show", view, resource);
  return view;
};

/* ───────────────────────────── listing ──────────────────────────────────── */

export interface ListBookingsQuery {
  resource?: string;
  status?: BookingStatus;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  /** By start time. `desc` (the default) answers "what came in last"; `asc`
   *  answers "who is coming next", which is what a day of work is read in. */
  order?: "asc" | "desc";
  /** Only bookings that still stand. "Who is coming on Thursday" is not
   *  answered by a list that includes the two people who cancelled. */
  live?: boolean;
}

/** A booking that still stands: not cancelled, not a no-show, and not a hold
 *  the clock let go. `completed` belongs here — it happened. */
const STANDING: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  "held",
  "confirmed",
  "completed",
]);

export const listBookings = async (
  ctx: Ctx,
  tenantId: string | null,
  query: ListBookingsQuery = {},
  now = Date.now(),
): Promise<{ data: PublicBooking[]; total: number }> => {
  const t = bookingsTable(ctx.dialect);
  const conditions: unknown[] = [tenantWhere(t, tenantId)];

  if (query.resource) {
    const resource = await loadResource(ctx, tenantId, query.resource);
    if (!resource) return { data: [], total: 0 };
    conditions.push(eq(t.resourceId, resource.id));
  }
  if (query.from !== undefined) conditions.push(gt(t.endAt, instant(ctx.dialect, query.from)));
  if (query.to !== undefined) conditions.push(lt(t.startAt, instant(ctx.dialect, query.to)));

  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(...(conditions as any[])))
    .orderBy(query.order === "asc" ? asc(t.startAt) : desc(t.startAt))) as BookingRow[];

  // `completed` and `expired` exist only once the clock has been consulted, so
  // a status filter cannot be pushed into SQL without the derived ones going
  // missing from every query that asks for them. `live` is the same problem:
  // an expired hold is a row that still says `held`.
  const filtered =
    query.status || query.live
      ? rows.filter((r) => {
          const status = effectiveBookingStatus(r, now);
          if (query.status && status !== query.status) return false;
          if (query.live && !STANDING.has(status)) return false;
          return true;
        })
      : rows;

  const limit = clamp(query.limit ?? 50, 1, 200);
  const offset = Math.max(query.offset ?? 0, 0);
  return {
    data: filtered.slice(offset, offset + limit).map((r) => toPublicBooking(r, now)),
    total: filtered.length,
  };
};

export const getBooking = async (
  ctx: Ctx,
  tenantId: string | null,
  bookingId: string,
  now = Date.now(),
): Promise<PublicBooking> => {
  const t = bookingsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, bookingId), tenantWhere(t, tenantId)))
    .limit(1)) as BookingRow[];
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Booking not found");
  return toPublicBooking(row, now);
};

/** Which day, in the resource's own zone, a booking falls on — the grouping the
 *  admin list and the CLI both want, and neither should re-derive. */
export const bookingLocalDate = (booking: BookingRow, resource: BookingResourceRow): string => {
  const d = civilDateIn(asMs(booking.startAt), resource.timeZone);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
};

export const BOOKING_STATUSES: BookingStatus[] = [
  "held",
  "confirmed",
  "cancelled",
  "no_show",
  "completed",
  "expired",
];
