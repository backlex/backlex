import { OAUTH_ACCESS_TOKEN_KEY, defineProvider, type DestinationRow } from "../provider";

/**
 * Google Calendar — a calendar's events into a collection, and rows back out
 * as events.
 *
 * **Pulling in.** The interesting part is the cursor. Calendar is one of the few
 * APIs here with a REAL incremental sync token: after the last page of a run it
 * hands back a `nextSyncToken`, and passing that on the next run returns only
 * what changed — including cancellations, which a page walk never sees.
 *
 * Two token kinds therefore share one cursor slot, and they are not
 * interchangeable: a page token continues the current run, a sync token starts
 * the next one. They are tagged rather than guessed, because handing a page
 * token to `syncToken` gets a 410 and silently restarts the whole calendar.
 *
 * **Pushing out.** Eight of the schema templates model a scheduled thing —
 * appointments, bookings, sessions, visits — and a booking that exists only in
 * backlex is a booking nobody's phone reminds them about. The write-back is a
 * destination rather than a flow op because the engine already solves the hard
 * half: a watermark walk that re-sends an edited row, and a breaker that pauses
 * a sync pointed at a calendar that has been deleted.
 *
 * That leaves ONE hard problem — idempotency. A destination's contract is that
 * a re-sent batch must not duplicate, and a calendar has no natural key to
 * upsert on. Google is unusual in letting the caller CHOOSE an event id, so the
 * id is derived from (sync, row) and the same row always addresses the same
 * event. Everything else here follows from that choice.
 */

/** Calendar's page cap. */
const PAGE = 250;

const PAGE_PREFIX = "p:";
const SYNC_PREFIX = "s:";

/**
 * Rows per push call.
 *
 * There is no bulk insert — Google retired the batch endpoint — so this is one
 * or two HTTP calls per row, and the engine's 20-page budget multiplies it.
 * 20 rows × 2 calls × 20 pages = 800 subrequests, inside a Worker's 1000.
 */
const PUSH_BATCH = 20;

/** Fallback event length when the collection carries a start but no end. */
const DEFAULT_DURATION_MINUTES = 60;

/** `2026-08-01` — an all-day event, not an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Deliberately loose. Google does the real validation; this only stops obvious
 *  non-addresses (a name, an empty cell) becoming a 400 for the whole batch. */
const EMAIL_LIKE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Attendees per event. Google's own cap is far higher, but a mis-mapped JSON
 *  column can hold thousands of strings and every one of them gets emailed. */
const MAX_ATTENDEES = 50;

export const googleCalendar = defineProvider({
  id: "google-calendar",
  label: "Google Calendar",
  category: "productivity",
  capabilities: ["source", "destination"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "….apps.googleusercontent.com" },
    { key: "clientSecret", label: "OAuth client secret", placeholder: "GOCSPX-…", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // `calendar.events` is read AND write on events, so it would cover the pull
    // on its own. `calendar.readonly` stays alongside it because Google shows
    // the consent screen per scope, and an admin connecting this only to mirror
    // a calendar in should see a read grant listed rather than a bare "manage
    // your events". A connection authorised before write existed keeps working
    // for pulls and gets a reconnect message on its first push.
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    authorizeParams: { access_type: "offline", prompt: "consent" },
    pkce: true,
    tokenAuth: "body",
  },
  source: {
    settingFields: [
      {
        key: "calendarId",
        label: "Calendar ID",
        placeholder: "primary, or the address from Calendar settings",
      },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const calendarId = ctx.setting("calendarId") ?? "primary";
      if (!token) throw new Error("Google Calendar sync has no access token");

      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      url.searchParams.set("maxResults", String(Math.min(ctx.limit, PAGE)));
      // Recurring events expand into instances; without this a weekly meeting
      // is one row with a rule nobody downstream can evaluate.
      url.searchParams.set("singleEvents", "true");

      const cursor = ctx.cursor ?? "";
      if (cursor.startsWith(PAGE_PREFIX)) {
        url.searchParams.set("pageToken", cursor.slice(PAGE_PREFIX.length));
      } else if (cursor.startsWith(SYNC_PREFIX)) {
        url.searchParams.set("syncToken", cursor.slice(SYNC_PREFIX.length));
      }

      const res = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 410) {
        // Google expires a sync token that has gone stale. The only recovery is
        // a full re-read, and saying so beats a 410 the operator has to decode.
        throw new Error(
          "Google Calendar sync token expired — clear the sync's settings to start a fresh full read",
        );
      }
      if (!res.ok) throw new Error(`Google Calendar responded ${res.status}`);
      const body = (await res.json()) as {
        items?: Record<string, unknown>[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };

      const records = (body.items ?? [])
        .filter((e): e is { id: string } & Record<string, unknown> => typeof e.id === "string")
        .map((e) => ({
          externalId: e.id,
          data: {
            ...e,
            // `start`/`end` are `{dateTime}` or `{date}` for all-day events;
            // flattened so a timestamp column can take them.
            start: pickDate(e.start),
            end: pickDate(e.end),
            organizer: pickEmail(e.organizer),
            // `cancelled` only ever arrives through the sync token, and it is
            // the whole reason for using one.
            status: e.status ?? null,
          },
        }));

      // A sync token means the run is finished, so it is stored for the NEXT
      // one. A page token means this run continues.
      const next = body.nextPageToken
        ? `${PAGE_PREFIX}${body.nextPageToken}`
        : body.nextSyncToken
          ? `${SYNC_PREFIX}${body.nextSyncToken}`
          : null;

      // A sync token is NOT a cursor: returning it as one would leave the
      // engine believing there is another page and loop. It goes on
      // `resumeToken`, which the engine stores only once the run is finished.
      return {
        records,
        cursor: body.nextPageToken ? next : null,
        ...(body.nextPageToken ? {} : next ? { resumeToken: next } : {}),
      };
    },
  },
  destination: {
    batchSize: PUSH_BATCH,
    columns: [
      { value: "summary", label: "Title" },
      { value: "description", label: "Description" },
      { value: "location", label: "Location" },
      { value: "start", label: "Starts at" },
      { value: "end", label: "Ends at" },
      { value: "attendees", label: "Attendee emails" },
    ],
    settingFields: [
      {
        key: "calendarId",
        label: "Calendar ID",
        placeholder: "primary, or the address from Calendar settings",
      },
      {
        key: "timeZone",
        label: "Time zone (optional)",
        placeholder: "Europe/Istanbul — defaults to the calendar's own",
      },
      {
        key: "notify",
        label: "Notify attendees (optional)",
        options: [
          { value: "none", label: "No emails" },
          { value: "externalOnly", label: "Only guests outside the organisation" },
          { value: "all", label: "Every guest" },
        ],
      },
    ],
    async push(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      if (!token) throw new Error("Google Calendar write-back has no access token");
      const calendarId = ctx.setting("calendarId") ?? "primary";
      const timeZone = ctx.setting("timeZone");
      // Google's own default, restated: an event created by an automation
      // should not mail every guest unless someone chose that.
      const notify = ctx.setting("notify") ?? "none";
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const query = `?sendUpdates=${encodeURIComponent(notify)}`;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      for (const row of ctx.rows) {
        const rowId = String(row.id ?? "");
        if (!rowId) continue;
        const eventId = await eventIdFor(ctx.syncKey, rowId);
        const event = buildEvent(row, timeZone);
        if (!event) continue;

        // Insert first, then update on conflict. The alternative — update
        // first, insert on 404 — costs the same two calls in the steady state
        // and loses the property that a brand-new row is one request.
        let res = await ctx.fetch(`${base}${query}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...event, id: eventId }),
        });
        if (res.status === 409) {
          res = await ctx.fetch(`${base}/${eventId}${query}`, {
            method: "PUT",
            headers,
            body: JSON.stringify(event),
          });
        }
        if (!res.ok) throw await pushError(res, rowId);
      }
    },
  },
});

/**
 * The event id a row addresses.
 *
 * Google accepts a caller-chosen id in base32hex, so plain lowercase hex is
 * valid. Hashed rather than derived from the row id directly for two reasons:
 * an arbitrary primary key is not base32hex (a UUID's hyphens alone would be
 * refused), and the id is visible to everyone the event is shared with.
 *
 * The sync is part of the input — see {@link DestinationPushContext.syncKey}.
 */
const eventIdFor = async (syncKey: string, rowId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${syncKey} ${rowId}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
};

/** Map one mapped row onto an event body, or `null` when it has no start —
 *  Google refuses those, and skipping is better than failing the whole batch on
 *  a row whose date column is simply empty. */
const buildEvent = (row: DestinationRow, timeZone: string | null): Record<string, unknown> | null => {
  const start = toEventTime(row.start, timeZone);
  if (!start) return null;
  const end = toEventTime(row.end, timeZone) ?? defaultEnd(start, timeZone);

  const event: Record<string, unknown> = {
    // Google shows "(No title)" for an empty summary, which reads as a bug in
    // the sync rather than an empty column.
    summary: text(row.summary) ?? "(untitled)",
    start,
    end,
  };
  const description = text(row.description);
  if (description) event.description = description;
  const location = text(row.location);
  if (location) event.location = location;
  const attendees = toAttendees(row.attendees);
  if (attendees.length > 0) event.attendees = attendees;
  return event;
};

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/**
 * A column value → Calendar's `{date}` or `{dateTime, timeZone}`.
 *
 * The two are not interchangeable: `{date}` is an all-day event and `{dateTime}`
 * is an instant, and a start given as one with an end given as the other is a
 * 400. `defaultEnd` therefore matches whichever shape the start took.
 *
 * Timestamps arrive as epoch milliseconds on SQLite and as a `Date` on Postgres,
 * so both are accepted rather than assuming the dialect.
 */
const toEventTime = (
  v: unknown,
  timeZone: string | null,
): { date: string } | { dateTime: string; timeZone?: string } | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && DATE_ONLY.test(v)) return { date: v };
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  return { dateTime: new Date(ms).toISOString(), ...(timeZone ? { timeZone } : {}) };
};

const defaultEnd = (
  start: { date: string } | { dateTime: string; timeZone?: string },
  timeZone: string | null,
): { date: string } | { dateTime: string; timeZone?: string } => {
  if ("date" in start) {
    // An all-day event's end date is EXCLUSIVE, so a one-day event ends on the
    // following day. Ending it on its own date is a zero-length event Google
    // rejects.
    const next = new Date(`${start.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { date: next.toISOString().slice(0, 10) };
  }
  const at = new Date(Date.parse(start.dateTime) + DEFAULT_DURATION_MINUTES * 60_000);
  return { dateTime: at.toISOString(), ...(timeZone ? { timeZone } : {}) };
};

/** A `json`/`relation_many` column arrives as an array, a `text` one as a
 *  comma- or semicolon-separated list. Both are ordinary ways to hold guests. */
const toAttendees = (v: unknown): { email: string }[] => {
  const raw: unknown[] = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(/[,;]/)
      : v === null || v === undefined
        ? []
        : [v];
  const seen = new Set<string>();
  const out: { email: string }[] = [];
  for (const entry of raw) {
    // A relation column may hold objects rather than bare strings.
    const email =
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object" && typeof (entry as { email?: unknown }).email === "string"
          ? (entry as { email: string }).email.trim()
          : "";
    const lower = email.toLowerCase();
    if (!EMAIL_LIKE.test(email) || seen.has(lower)) continue;
    seen.add(lower);
    out.push({ email });
    if (out.length >= MAX_ATTENDEES) break;
  }
  return out;
};

/**
 * Turn a failed write into a message an operator can act on.
 *
 * A 403 is the one that matters: Google uses it for BOTH "this token cannot
 * write" and "you are going too fast", and those want opposite responses. The
 * breaker pauses a sync after five consecutive failures, so a rate limit
 * reported as a permission problem sends an admin to re-authorize a connection
 * that was never broken.
 */
const pushError = async (res: Response, rowId: string): Promise<Error> => {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  };
  const reason = body.error?.errors?.[0]?.reason ?? "";
  if (res.status === 403) {
    if (reason.includes("ateLimit") || reason === "quotaExceeded") {
      return new Error(`Google Calendar rate-limited the write (${reason || "rateLimitExceeded"})`);
    }
    return new Error(
      "Google Calendar refused the write — reconnect this integration so it also grants calendar write access",
    );
  }
  const detail = body.error?.message ?? "";
  return new Error(
    `Google Calendar responded ${res.status} for row ${rowId}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
  );
};

const pickDate = (v: unknown): string | null => {
  if (!v || typeof v !== "object") return null;
  const d = v as { dateTime?: unknown; date?: unknown };
  if (typeof d.dateTime === "string") return d.dateTime;
  return typeof d.date === "string" ? d.date : null;
};

const pickEmail = (v: unknown): string | null => {
  if (!v || typeof v !== "object") return null;
  const o = (v as { email?: unknown }).email;
  return typeof o === "string" ? o : null;
};
