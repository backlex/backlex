/**
 * Build an iCalendar (RFC 5545) VEVENT.
 *
 * The counterpart to the Google Calendar write-back, and the cheaper half of
 * the same problem: a booking that exists only in backlex is a booking nobody
 * is reminded about. Write-back needs the operator to connect an account and
 * covers one vendor's calendar; a `.ics` on the confirmation email covers every
 * calendar application there is and needs no connection at all.
 *
 * Pure and dependency-free — no clock, no crypto, no env. `dtstamp` and `uid`
 * are parameters rather than generated here, both so the output is testable and
 * because the UID is load-bearing: sending a second file with the SAME uid and a
 * higher `sequence` is what makes a calendar treat it as a reschedule rather
 * than a second event.
 */

export interface IcsEvent {
  /**
   * Globally unique and STABLE for this booking. Derive it from the row
   * (`<id>@<host>`), never randomly: a fresh uid on an updated invite books the
   * meeting twice.
   */
  uid: string;
  /** When the file was produced. */
  dtstamp: Date;
  start: Date | string;
  /** Defaults to one hour after `start` (or the next day, for an all-day). */
  end?: Date | string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  /** Required for a real invitation — without one this is a PUBLISH, not a
   *  REQUEST, and calendars show it as an event rather than something to
   *  accept. */
  organizer?: { email: string; name?: string };
  attendees?: { email: string; name?: string }[];
  /** Bump on every re-send of the same `uid`. 0 is the original. */
  sequence?: number;
  /** `CANCELLED` withdraws a previously sent invite with the same uid. */
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  /** Overrides the method derived from `organizer`. `CANCEL` retracts. */
  method?: "REQUEST" | "PUBLISH" | "CANCEL";
}

/** `2026-08-01` — an all-day event rather than an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** RFC 5545 caps a content line at 75 OCTETS, not characters. */
const MAX_OCTETS = 75;

/**
 * What may appear after `mailto:`.
 *
 * Deliberately loose about what an address IS and strict about what it is not:
 * no whitespace, no line break, and none of the characters that separate a
 * property from its parameters. See the note at the call site.
 */
const ADDRESS = /^[^\s@,;:"]+@[^\s@,;:"]+\.[^\s@,;:"]+$/;

/**
 * Escape a TEXT value. The comma and semicolon matter most: they are the
 * property's own separators, so an unescaped one in a description silently
 * turns the rest of the line into structured fields the calendar then drops.
 */
const esc = (v: string): string =>
  v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/** `20260801T140000Z`, always UTC — a floating local time means a different
 *  moment for every recipient, which for a booking is the one unacceptable
 *  answer. */
const utcStamp = (d: Date): string => `${d.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

const dateStamp = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, "");

/**
 * Fold a long line, counting UTF-8 octets and never splitting a character.
 *
 * A naive `slice(0, 75)` on a description with any non-ASCII in it — which for
 * this codebase's users means most of them — cuts a multi-byte sequence in half
 * and the calendar shows a replacement character or refuses the file outright.
 */
const fold = (line: string): string => {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= MAX_OCTETS) return line;
  const out: string[] = [];
  let used = 0;
  let current = "";
  // A continuation line is prefixed with one space, which itself costs an
  // octet of the 75.
  let budget = MAX_OCTETS;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (used + size > budget) {
      out.push(current);
      current = "";
      used = 0;
      budget = MAX_OCTETS - 1;
    }
    current += ch;
    used += size;
  }
  if (current) out.push(current);
  return out.join("\r\n ");
};

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/**
 * Render one event as an iCalendar document.
 *
 * Lines are CRLF-terminated because RFC 5545 says so and, unlike most such
 * rules, this one is enforced: Outlook rejects an LF-only file.
 */
export function buildIcs(event: IcsEvent): string {
  const allDay = typeof event.start === "string" && DATE_ONLY.test(event.start);
  // Derived from the organizer that will actually be WRITTEN, not the one that
  // was passed: a REQUEST with no ORGANIZER line is a malformed invitation, and
  // downgrading to PUBLISH is the honest reading of "there is nobody to send it
  // from".
  const organizer = event.organizer && ADDRESS.test(event.organizer.email) ? event.organizer : null;
  const method = event.method ?? (organizer ? "REQUEST" : "PUBLISH");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//backlex//backlex//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${esc(event.uid)}`,
    `DTSTAMP:${utcStamp(event.dtstamp)}`,
  ];

  if (allDay) {
    const startDate = new Date(`${event.start as string}T00:00:00Z`);
    // An all-day DTEND is EXCLUSIVE: a one-day event ends on the following
    // date. Ending it on its own date produces a zero-length event that some
    // calendars hide entirely.
    const endDate =
      event.end && typeof event.end === "string" && DATE_ONLY.test(event.end)
        ? new Date(`${event.end}T00:00:00Z`)
        : new Date(startDate.getTime() + DAY_MS);
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${dateStamp(endDate)}`);
  } else {
    const start = toDate(event.start);
    const end = event.end ? toDate(event.end) : new Date(start.getTime() + HOUR_MS);
    lines.push(`DTSTART:${utcStamp(start)}`);
    lines.push(`DTEND:${utcStamp(end)}`);
  }

  lines.push(`SUMMARY:${esc(event.summary)}`);
  // Addresses are DROPPED rather than escaped when they don't look like
  // addresses. Everything else here is free text that only has to survive the
  // format, but a `mailto:` value goes in raw — and on the flow path the guest
  // list is an interpolated column split on commas alone, so it can hold
  // whatever an app-plane user typed. A newline there would append the
  // attacker's own properties to a file the recipient trusts because it arrived
  // from the business's domain. An address containing one is not an address.
  if (event.description) lines.push(`DESCRIPTION:${esc(event.description)}`);
  if (event.location) lines.push(`LOCATION:${esc(event.location)}`);
  if (event.url) lines.push(`URL:${esc(event.url)}`);
  if (organizer) {
    const cn = organizer.name ? `;CN=${esc(organizer.name)}` : "";
    lines.push(`ORGANIZER${cn}:mailto:${organizer.email}`);
  }
  for (const a of event.attendees ?? []) {
    if (!ADDRESS.test(a.email)) continue;
    const cn = a.name ? `;CN=${esc(a.name)}` : "";
    // RSVP asks the client to show accept/decline. Harmless on a PUBLISH,
    // where clients ignore it.
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a.email}`);
  }
  lines.push(`SEQUENCE:${event.sequence ?? 0}`);
  lines.push(`STATUS:${event.status ?? (method === "CANCEL" ? "CANCELLED" : "CONFIRMED")}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** The MIME type an `.ics` attachment must carry. The `method` parameter is
 *  what makes a mail client render accept/decline buttons rather than treat the
 *  file as an unknown download. */
export const icsContentType = (method: "REQUEST" | "PUBLISH" | "CANCEL" = "REQUEST"): string =>
  `text/calendar; charset=utf-8; method=${method}`;

/**
 * Pack an `.ics` body into the shape `EmailAttachment.content` requires.
 *
 * That field is documented as "base64, no line breaks, no `data:` prefix", and
 * it is not advisory: a transport hands the DECODED bytes to its provider, so
 * raw text either arrives as a corrupt attachment or is refused outright. The
 * managed cloud mail gateway refuses it, which turned every booking on a
 * managed tenant into a 500 — *after* the booking row was already written.
 *
 * It lives here rather than at either call site because there were two callers
 * and only one of them encoded. One export is the difference between "a rule
 * everyone must remember" and "a rule that is hard to get wrong".
 *
 * Chunked rather than `btoa(String.fromCharCode(...bytes))`: the spread form
 * passes one argument per byte, which throws on a large enough invite.
 */
export const icsAttachmentContent = (ics: string): string => {
  const bytes = new TextEncoder().encode(ics);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
