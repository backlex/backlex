/**
 * Google Calendar as a DESTINATION — a booking row becomes a calendar event.
 *
 * The whole design rests on one property: a destination's contract says a
 * re-sent batch must not duplicate, and a calendar has no natural key to upsert
 * on. Google is unusual in letting the caller choose an event id, so the id is
 * derived from (sync, row). Everything below is about that derivation holding —
 * the same row addressing the same event forever, two syncs never colliding —
 * plus the failure shapes that would otherwise be mistaken for each other: a
 * rate limit that reads as a permission problem sends an admin to re-authorize
 * a connection that was never broken.
 */
import { describe, expect, test } from "bun:test";
import { pushToDestination, DESTINATION_COLUMNS, DESTINATION_BATCH_SIZE } from "@backlex/integrations";

interface Call {
  url: string;
  method: string;
  body: any;
}

/** A fake Calendar that records every call and answers as told. */
const recorder = (responses: { status: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[i++] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  return { calls, fetchImpl };
};

const push = (
  rows: Record<string, unknown>[],
  opts: { fetchImpl: any; syncKey?: string; settings?: Record<string, unknown> },
) =>
  pushToDestination(
    "google-calendar",
    {
      config: { _oauthAccessToken: "tok" },
      settings: { calendarId: "primary", ...(opts.settings ?? {}) },
      rows,
      columns: { id: "text", summary: "text", start: "timestamp" },
      syncKey: opts.syncKey ?? "sync-a",
    },
    opts.fetchImpl,
  );

const ROW = { id: "bk_1", summary: "Haircut", start: "2026-08-03T14:00:00.000Z" };

describe("google-calendar destination", () => {
  test("declares a closed column set and a small batch", () => {
    expect(DESTINATION_COLUMNS["google-calendar"]?.map((c) => c.value)).toEqual([
      "summary",
      "description",
      "location",
      "start",
      "end",
      "attendees",
    ]);
    // One or two HTTP calls per row: the engine's 200-row default would be 400
    // subrequests, past what a Worker invocation is allowed.
    expect(DESTINATION_BATCH_SIZE["google-calendar"]).toBeLessThanOrEqual(25);
  });

  test("inserts with a caller-chosen id", async () => {
    const { calls, fetchImpl } = recorder();
    await push([ROW], { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/calendars/primary/events");
    expect(typeof calls[0]!.body.id).toBe("string");
    // base32hex — Google refuses anything else, and a raw UUID's hyphens alone
    // would fail.
    expect(calls[0]!.body.id).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  test("the same row always addresses the same event", async () => {
    const first = recorder();
    await push([ROW], { fetchImpl: first.fetchImpl });
    const second = recorder();
    await push([{ ...ROW, summary: "Haircut (moved)" }], { fetchImpl: second.fetchImpl });
    // This is the whole idempotency story: a re-sent batch updates rather than
    // books a second appointment.
    expect(second.calls[0]!.body.id).toBe(first.calls[0]!.body.id);
  });

  test("two syncs into one calendar never collide", async () => {
    const a = recorder();
    await push([ROW], { fetchImpl: a.fetchImpl, syncKey: "sync-a" });
    const b = recorder();
    await push([ROW], { fetchImpl: b.fetchImpl, syncKey: "sync-b" });
    // Two collections can hold the same primary key. Without the sync in the
    // hash each run would overwrite the other's events.
    expect(b.calls[0]!.body.id).not.toBe(a.calls[0]!.body.id);
  });

  test("a 409 falls through to an update of that same event", async () => {
    const { calls, fetchImpl } = recorder([{ status: 409 }, { status: 200 }]);
    await push([ROW], { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toContain(`/events/${calls[0]!.body.id}`);
    // The id is in the path on an update; repeating it in the body is noise.
    expect(calls[1]!.body.id).toBeUndefined();
  });

  test("defaults the end to an hour after the start", async () => {
    const { calls, fetchImpl } = recorder();
    await push([ROW], { fetchImpl });
    expect(calls[0]!.body.start).toEqual({ dateTime: "2026-08-03T14:00:00.000Z" });
    expect(calls[0]!.body.end).toEqual({ dateTime: "2026-08-03T15:00:00.000Z" });
  });

  test("a date-only column is an all-day event with an exclusive end", async () => {
    const { calls, fetchImpl } = recorder();
    await push([{ id: "b", summary: "Leave", start: "2026-08-03" }], { fetchImpl });
    expect(calls[0]!.body.start).toEqual({ date: "2026-08-03" });
    expect(calls[0]!.body.end).toEqual({ date: "2026-08-04" });
  });

  test("epoch milliseconds are accepted, because that is what SQLite stores", async () => {
    const { calls, fetchImpl } = recorder();
    await push([{ id: "b", summary: "x", start: Date.parse("2026-08-03T14:00:00Z") }], { fetchImpl });
    expect(calls[0]!.body.start.dateTime).toBe("2026-08-03T14:00:00.000Z");
  });

  test("carries the configured time zone", async () => {
    const { calls, fetchImpl } = recorder();
    await push([ROW], { fetchImpl, settings: { timeZone: "Europe/Istanbul" } });
    expect(calls[0]!.body.start.timeZone).toBe("Europe/Istanbul");
  });

  test("a row with no start is skipped, not failed", async () => {
    const { calls, fetchImpl } = recorder();
    // One empty date column should not stop the other 19 rows in the batch.
    await push([{ id: "b", summary: "x", start: null }, ROW], { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.summary).toBe("Haircut");
  });

  test("an empty title becomes something readable", async () => {
    const { calls, fetchImpl } = recorder();
    await push([{ id: "b", summary: "", start: ROW.start }], { fetchImpl });
    // Google renders an empty summary as "(No title)", which reads as a bug in
    // the sync rather than an empty column.
    expect(calls[0]!.body.summary).toBe("(untitled)");
  });

  describe("attendees", () => {
    const guests = async (value: unknown) => {
      const { calls, fetchImpl } = recorder();
      await push([{ ...ROW, attendees: value }], { fetchImpl });
      return calls[0]!.body.attendees;
    };

    test("splits a text column on commas and semicolons", async () => {
      expect(await guests("a@example.com, b@example.com; c@example.com")).toEqual([
        { email: "a@example.com" },
        { email: "b@example.com" },
        { email: "c@example.com" },
      ]);
    });

    test("takes a json array, of strings or of objects", async () => {
      expect(await guests(["a@example.com", { email: "b@example.com" }])).toEqual([
        { email: "a@example.com" },
        { email: "b@example.com" },
      ]);
    });

    test("drops non-addresses and duplicates", async () => {
      // A mis-mapped column holds names, not emails; every entry that survives
      // gets mailed by Google, so the filter is not cosmetic.
      expect(await guests("Ayşe Yılmaz, a@example.com, A@Example.com")).toEqual([
        { email: "a@example.com" },
      ]);
    });

    test("omits the field entirely when nothing survives", async () => {
      expect(await guests("")).toBeUndefined();
    });
  });

  describe("failures an operator has to tell apart", () => {
    test("a permission 403 says to reconnect", async () => {
      const { fetchImpl } = recorder([
        { status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }] } } },
      ]);
      await expect(push([ROW], { fetchImpl })).rejects.toThrow(/reconnect/i);
    });

    test("a rate-limit 403 does NOT", async () => {
      // Same status, opposite response. Told to reconnect, an admin re-does an
      // OAuth dance that fixes nothing while the breaker pauses the sync.
      const { fetchImpl } = recorder([
        { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      ]);
      await expect(push([ROW], { fetchImpl })).rejects.toThrow(/rate-limited/i);
    });

    test("any other failure throws so the batch is retried, not skipped", async () => {
      const { fetchImpl } = recorder([{ status: 500 }]);
      await expect(push([ROW], { fetchImpl })).rejects.toThrow(/500/);
    });

    test("a missing token fails before any call is made", async () => {
      const { calls, fetchImpl } = recorder();
      await expect(
        pushToDestination(
          "google-calendar",
          {
            config: {},
            settings: { calendarId: "primary" },
            rows: [ROW],
            columns: {},
            syncKey: "s",
          },
          fetchImpl,
        ),
      ).rejects.toThrow(/access token/);
      expect(calls).toHaveLength(0);
    });
  });

  test("does not notify guests unless asked", async () => {
    const quiet = recorder();
    await push([ROW], { fetchImpl: quiet.fetchImpl });
    expect(quiet.calls[0]!.url).toContain("sendUpdates=none");
    const loud = recorder();
    await push([ROW], { fetchImpl: loud.fetchImpl, settings: { notify: "all" } });
    expect(loud.calls[0]!.url).toContain("sendUpdates=all");
  });

  test("escapes a calendar id that is an email address", async () => {
    const { calls, fetchImpl } = recorder();
    await push([ROW], { fetchImpl, settings: { calendarId: "team@group.calendar.google.com" } });
    expect(calls[0]!.url).toContain("/calendars/team%40group.calendar.google.com/events");
  });
});
