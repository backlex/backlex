/**
 * The calendar-invite file and the raw MIME that carries it.
 *
 * Both are formats where a mistake is invisible until a real mail client
 * refuses the message, so the assertions here are mostly about the rules that
 * are easy to get almost right: CRLF terminators, escaping the characters that
 * are a property's own separators, an all-day end date that is EXCLUSIVE, and
 * folding a long line by octets without cutting a multi-byte character in half.
 *
 * The MIME half exists only for Amazon SES, whose simple send has no attachment
 * field. Its tests are about header injection first — `to` and `subject` reach
 * it from flow interpolation, so a value carrying a newline must not be able to
 * append headers to a message the operator believes they wrote.
 */
import { describe, expect, test } from "bun:test";
import { buildIcs, icsAttachmentContent, icsContentType } from "@backlex/core";
import { buildRawMime } from "../src/server/lib/mime";

const AT = new Date("2026-08-01T09:00:00.000Z");

const base = {
  uid: "booking-1@backlex",
  dtstamp: AT,
  start: new Date("2026-08-03T14:00:00.000Z"),
  summary: "Haircut",
};

/** Unfold before asserting on content: a folded line is CRLF + one space, and
 *  a test that greps the raw text would miss a property that got wrapped. */
const unfold = (s: string): string => s.replace(/\r\n /g, "");
const lines = (s: string): string[] => unfold(s).split("\r\n");

describe("buildIcs", () => {
  test("terminates every line with CRLF", () => {
    const out = buildIcs(base);
    // Outlook rejects an LF-only file outright, so this is not cosmetic.
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.includes("\n")).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  test("wraps a single VEVENT in a VCALENDAR", () => {
    const l = lines(buildIcs(base));
    expect(l[0]).toBe("BEGIN:VCALENDAR");
    expect(l).toContain("BEGIN:VEVENT");
    expect(l).toContain("END:VEVENT");
    expect(l.at(-2)).toBe("END:VCALENDAR");
  });

  test("defaults the end to an hour after the start", () => {
    const l = lines(buildIcs(base));
    expect(l).toContain("DTSTART:20260803T140000Z");
    expect(l).toContain("DTEND:20260803T150000Z");
  });

  test("times are UTC, whatever the input offset", () => {
    // A floating local time means a different moment for every recipient —
    // for a booking that is the one unacceptable answer.
    const l = lines(buildIcs({ ...base, start: "2026-08-03T17:00:00+03:00" }));
    expect(l).toContain("DTSTART:20260803T140000Z");
  });

  test("a date-only start is an all-day event whose end is EXCLUSIVE", () => {
    const l = lines(buildIcs({ ...base, start: "2026-08-03" }));
    expect(l).toContain("DTSTART;VALUE=DATE:20260803");
    // Not 20260803: an all-day event that ends on its own date is zero-length
    // and some calendars hide it entirely.
    expect(l).toContain("DTEND;VALUE=DATE:20260804");
  });

  test("an explicit all-day end is kept as given", () => {
    const l = lines(buildIcs({ ...base, start: "2026-08-03", end: "2026-08-06" }));
    expect(l).toContain("DTEND;VALUE=DATE:20260806");
  });

  test("escapes the characters that are the property's own separators", () => {
    const l = lines(
      buildIcs({ ...base, summary: "Cut, colour; wash", description: "Line one\nLine two \\ end" }),
    );
    // Unescaped, the comma would turn the rest of SUMMARY into fields the
    // calendar drops on the floor.
    expect(l).toContain("SUMMARY:Cut\\, colour\\; wash");
    expect(l).toContain("DESCRIPTION:Line one\\nLine two \\\\ end");
  });

  test("folds a long line at 75 octets", () => {
    const raw = buildIcs({ ...base, summary: "x".repeat(300) });
    for (const line of raw.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(raw)).toContain(`SUMMARY:${"x".repeat(300)}`);
  });

  test("folding never splits a multi-byte character", () => {
    // Turkish text is the normal case for this codebase's users, and a cut
    // mid-sequence shows as a replacement character or fails the parse.
    const summary = "Şşğüöçİı".repeat(40);
    const raw = buildIcs({ ...base, summary });
    for (const line of raw.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(raw)).toContain(`SUMMARY:${summary}`);
  });

  test("an organizer makes it a REQUEST; without one it is a PUBLISH", () => {
    expect(lines(buildIcs(base))).toContain("METHOD:PUBLISH");
    const withOrg = lines(
      buildIcs({ ...base, organizer: { email: "salon@example.com", name: "Salon" } }),
    );
    expect(withOrg).toContain("METHOD:REQUEST");
    expect(withOrg).toContain("ORGANIZER;CN=Salon:mailto:salon@example.com");
  });

  test("attendees are asked to RSVP", () => {
    const l = lines(buildIcs({ ...base, attendees: [{ email: "a@example.com" }] }));
    expect(l).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:a@example.com");
  });

  test("an address carrying a line break cannot inject properties", () => {
    // The guest list reaches this from an interpolated column split on commas
    // alone, so it can hold whatever an app-plane user typed. Escaping is not
    // the answer here — an address containing a newline is not an address.
    const out = buildIcs({
      ...base,
      organizer: { email: "ok@example.com\nX-EVIL:1" },
      attendees: [
        { email: "good@example.com" },
        { email: "bad@example.com\r\nLOCATION:Pay here — https://attacker.example" },
      ],
    });
    expect(out).not.toContain("X-EVIL");
    expect(out).not.toContain("attacker.example");
    expect(out).not.toContain("ORGANIZER");
    // The honest entries still travel.
    expect(unfold(out)).toContain("mailto:good@example.com");
    // With the organizer dropped there is nobody to send a REQUEST from.
    expect(lines(out)).toContain("METHOD:PUBLISH");
  });

  test("a re-send carries the same uid and a higher sequence", () => {
    // This pair is what makes a calendar treat the second file as a reschedule
    // rather than booking the appointment twice.
    const first = lines(buildIcs(base));
    const second = lines(buildIcs({ ...base, sequence: 1 }));
    expect(first).toContain("SEQUENCE:0");
    expect(second).toContain("SEQUENCE:1");
    expect(second).toContain("UID:booking-1@backlex");
  });

  test("a CANCEL withdraws the event", () => {
    const l = lines(buildIcs({ ...base, method: "CANCEL", sequence: 2 }));
    expect(l).toContain("METHOD:CANCEL");
    expect(l).toContain("STATUS:CANCELLED");
  });

  test("the content type carries the method", () => {
    expect(icsContentType("REQUEST")).toBe("text/calendar; charset=utf-8; method=REQUEST");
  });
});

describe("buildRawMime", () => {
  const msg = {
    from: "no-reply@example.com",
    to: "guest@example.com",
    subject: "Booking confirmed",
    text: "See you Tuesday",
  };

  test("strips CRLF from addresses so a header cannot be injected", () => {
    const raw = buildRawMime({
      ...msg,
      to: "guest@example.com\r\nBcc: attacker@evil.example",
    });
    const headerBlock = raw.split("\r\n\r\n")[0] ?? "";
    expect(headerBlock).not.toMatch(/^Bcc:/im);
    expect(raw).toContain("To: guest@example.com Bcc: attacker@evil.example");
  });

  test("encodes a non-ASCII subject as an RFC 2047 word", () => {
    const raw = buildRawMime({ ...msg, subject: "Randevunuz onaylandı" });
    expect(raw).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(raw).not.toContain("onaylandı");
  });

  test("an ASCII subject is left alone", () => {
    expect(buildRawMime(msg)).toContain("Subject: Booking confirmed");
  });

  test("plain text comes before html in the alternative part", () => {
    const raw = buildRawMime({ ...msg, html: "<p>See you Tuesday</p>" });
    // multipart/alternative is least- to most-preferred; reversed, every
    // client shows the fallback.
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
  });

  test("attaches the file with its own content type and disposition", () => {
    const raw = buildRawMime({
      ...msg,
      attachments: [{ filename: "invite.ics", content: btoa("BEGIN:VCALENDAR"), contentType: "text/calendar" }],
    });
    expect(raw).toContain('Content-Disposition: attachment; filename="invite.ics"');
    expect(raw).toContain("Content-Type: text/calendar;");
    expect(raw).toContain(btoa("BEGIN:VCALENDAR"));
  });

  test("a quote in the filename cannot close the header parameter early", () => {
    // The filename reaches this from flow interpolation, not from the author's
    // literal, so it is not trusted to be well-formed.
    const raw = buildRawMime({
      ...msg,
      attachments: [{ filename: 'in"vite; x="y.ics', content: btoa("hi") }],
    });
    expect(raw).toContain('filename="invite; x=y.ics"');
  });

  test("the mixed boundary closes the message", () => {
    const raw = buildRawMime({ ...msg, attachments: [{ filename: "a.txt", content: btoa("hi") }] });
    const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * Packing the file for the wire.
 *
 * `EmailAttachment.content` is base64 and always was, but the rule lived only
 * in a docblock: booking passed `buildIcs()` straight through, so the invite
 * was raw text inside a field every transport decodes. Self-hosted transports
 * produced an unopenable file; the managed cloud gateway refused it and turned
 * every booking into a 500 — after the booking row was already committed.
 *
 * Every attachment case above this block builds its own `btoa(...)` in the
 * test, which is exactly why none of them could see it.
 * ───────────────────────────────────────────────────────────────────── */
describe("icsAttachmentContent", () => {
  const ics = buildIcs({ uid: "u1@example.com", dtstamp: AT, start: AT, summary: "Bayi görüşmesi" });

  const unpack = (packed: string) =>
    // `atob` yields a BINARY string — one char per byte — so a UTF-8 body has to
    // go back through TextDecoder. Comparing its output to the original string
    // directly is a test bug that reads as an encoding bug.
    new TextDecoder().decode(Uint8Array.from(atob(packed), (c) => c.charCodeAt(0)));

  test("it round-trips to the same bytes", () => {
    expect(unpack(icsAttachmentContent(ics))).toBe(ics);
  });

  test("it survives non-ASCII", () => {
    // `btoa` throws outright on a code point above 0xFF, so a Turkish summary is
    // not a nicety here — it is the difference between an invite and an
    // InvalidCharacterError on the send path.
    const packed = icsAttachmentContent(buildIcs({
      uid: "u2@example.com", dtstamp: AT, start: AT, summary: "Şubat görüşmesi — İzmir",
    }));
    expect(unpack(packed)).toContain("Şubat");
  });

  test("it emits no line breaks and no data: prefix", () => {
    const packed = icsAttachmentContent(ics);
    expect(packed).not.toContain("\n");
    expect(packed).not.toContain("\r");
    expect(packed.startsWith("data:")).toBe(false);
    expect(packed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("it does not choke on an invite larger than one spread call", () => {
    // The obvious spelling — `btoa(String.fromCharCode(...bytes))` — passes one
    // argument per byte and throws once the file is big enough.
    const big = buildIcs({ uid: "u3@example.com", dtstamp: AT, start: AT, summary: "x".repeat(200_000) });
    expect(atob(icsAttachmentContent(big)).length).toBe(big.length);
  });
});
