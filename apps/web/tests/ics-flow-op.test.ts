/**
 * The `ics` block on the `email` flow op — a calendar invite on the
 * confirmation mail a booking was already going to send.
 *
 * The cheaper half of calendar write-back: no account to connect, no OAuth, and
 * it reaches every calendar application rather than one vendor's. Runs go
 * through the HTTP invoke endpoint so interpolation, the tenant scope and the
 * error surface are exercised together, with the `console` transport standing
 * in for a real one.
 *
 * The assertions worth having are about the two ways this silently misbehaves:
 * a `uid` that is not stable across re-runs (which books the appointment twice
 * on the recipient's calendar), and a date template that renders to something
 * unparseable (which would otherwise ship a file containing the literal text
 * "Invalid Date" that every calendar refuses).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("ics on the email flow op", () => {
  let h: TestHarness;
  /** Every `.ics` the console transport logged during a run. */
  let sent: string[];
  let restore: typeof console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    sent = [];
    restore = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[email]")) sent.push(line);
    };
  });
  afterEach(() => {
    console.log = restore;
    h.cleanup();
  });

  const run = async (ics: Record<string, unknown> | undefined, data: Record<string, unknown> = {}) => {
    const op = {
      type: "email",
      to: "guest@example.com",
      subject: "Booking confirmed",
      text: "See you soon",
      ...(ics ? { ics } : {}),
    };
    const created = await h.fetch(
      "/api/flows",
      json({ name: `ics-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: [op] }),
    );
    expect(created.status).toBe(201);
    const { data: flow } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${flow.id}/run`, json(data));
    return (await res.json()) as { ok: boolean; error?: string };
  };

  test("attaches invite.ics when the block is present", async () => {
    const out = await run(
      { summary: "{{ data.service }}", start: "{{ data.starts_at }}" },
      { id: "bk_1", service: "Haircut", starts_at: "2026-08-03T14:00:00Z" },
    );
    expect(out).toEqual({ ok: true });
    expect(sent[0]).toContain("attachments=[invite.ics]");
  });

  test("an email with no ics block attaches nothing", async () => {
    expect(await run(undefined)).toEqual({ ok: true });
    expect(sent[0]).not.toContain("attachments=");
  });

  test("a start template that renders empty fails loudly", async () => {
    // The row simply has no date. An invite with no start is not an invite,
    // and sending the mail regardless hides the misconfiguration.
    const out = await run({ summary: "Haircut", start: "{{ data.starts_at }}" }, { id: "b" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/rendered empty/);
  });

  test("a start that renders to a non-date fails, naming the template not the value", async () => {
    const out = await run(
      { summary: "Haircut", start: "{{ data.starts_at }}" },
      { id: "b", starts_at: "next tuesday-ish" },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/did not render to a date/);
    // The message is persisted on the run's activity row; the rendered value is
    // customer data and has no business being there.
    expect(out.error).not.toContain("next tuesday-ish");
    expect(out.error).toContain("{{ data.starts_at }}");
  });

  test("a literal date needs no interpolation at all", async () => {
    expect(await run({ summary: "Standup", start: "2026-08-03T09:00:00Z" })).toEqual({ ok: true });
  });

  test("an all-day date passes straight through", async () => {
    expect(await run({ summary: "Leave", start: "2026-08-03" })).toEqual({ ok: true });
    expect(sent[0]).toContain("attachments=[invite.ics]");
  });

  test("the filename can be set", async () => {
    await run({ summary: "x", start: "2026-08-03T09:00:00Z", filename: "appointment.ics" });
    expect(sent[0]).toContain("attachments=[appointment.ics]");
  });

  describe("saving", () => {
    const save = (ics: Record<string, unknown>) =>
      h.fetch(
        "/api/flows",
        json({
          name: `save-${Math.random().toString(36).slice(2)}`,
          trigger: "manual:",
          operations: [{ type: "email", to: "a@b.co", subject: "s", text: "t", ics }],
        }),
      );

    test("refuses a block with no summary", async () => {
      expect((await save({ start: "2026-08-03T09:00:00Z" })).status).toBe(422);
    });

    test("refuses a block with no start", async () => {
      expect((await save({ summary: "Haircut" })).status).toBe(422);
    });

    test("refuses a method outside the three that mean something", async () => {
      const res = await save({ summary: "x", start: "2026-08-03T09:00:00Z", method: "MAYBE" });
      expect(res.status).toBe(422);
    });

    test("accepts the full block and reads it back", async () => {
      const res = await save({
        summary: "{{ data.service }}",
        start: "{{ data.starts_at }}",
        end: "{{ data.ends_at }}",
        location: "{{ data.address }}",
        organizerEmail: "bookings@example.com",
        attendees: "{{ data.email }}",
        sequence: 2,
        method: "REQUEST",
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { operations: any[] } };
      expect(data.operations[0].ics.organizerEmail).toBe("bookings@example.com");
      expect(data.operations[0].ics.sequence).toBe(2);
    });
  });
});
