import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * Google Calendar — mirror a calendar's events into a collection.
 *
 * The interesting part is the cursor. Calendar is one of the few APIs here with
 * a REAL incremental sync token: after the last page of a run it hands back a
 * `nextSyncToken`, and passing that on the next run returns only what changed —
 * including cancellations, which a page walk never sees.
 *
 * Two token kinds therefore share one cursor slot, and they are not
 * interchangeable: a page token continues the current run, a sync token starts
 * the next one. They are tagged rather than guessed, because handing a page
 * token to `syncToken` gets a 410 and silently restarts the whole calendar.
 */

/** Calendar's page cap. */
const PAGE = 250;

const PAGE_PREFIX = "p:";
const SYNC_PREFIX = "s:";

export const googleCalendar = defineProvider({
  id: "google-calendar",
  label: "Google Calendar",
  category: "productivity",
  capabilities: ["source"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "….apps.googleusercontent.com" },
    { key: "clientSecret", label: "OAuth client secret", placeholder: "GOCSPX-…", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
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
});

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
