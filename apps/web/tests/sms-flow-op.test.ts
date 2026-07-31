/**
 * The `sms` flow operation — the third messaging sibling next to `email` and
 * `push`.
 *
 * The interesting part is addressing. `push` can only reach a platform user's
 * registered devices, but the use case that motivated this op — an appointment
 * reminder — targets a *customer*, who has no account and so no `phone_numbers`
 * row. So the op carries two mutually exclusive modes and the tests below pin
 * both, plus the failure shapes that would otherwise look like a working flow:
 * a recipient template that renders empty, and one that renders a non-number.
 *
 * Runs go through the HTTP invoke endpoint so interpolation, the tenant scope
 * and the error surface are all exercised together. The harness resolves the
 * `console` SMS transport, which accepts every recipient.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sendSmsToNumbers } from "../src/server/services/sms";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const myId = async (h: TestHarness): Promise<string> =>
  ((await (await h.fetch("/api/me")).json()) as { data: { id: string } }).data.id;

describe("sms flow op", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  /** Create a flow with a single `sms` op; returns the create response. */
  const makeFlow = (op: Record<string, unknown>) =>
    h.fetch(
      "/api/flows",
      json({ name: `sms-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: [op] }),
    );

  /** Create + invoke, returning the run outcome. */
  const run = async (op: Record<string, unknown>, input: Record<string, unknown> = {}) => {
    const created = await makeFlow(op);
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${data.id}/run`, json(input));
    return (await res.json()) as { ok: boolean; error?: string };
  };

  describe("addressing by number (the customer case)", () => {
    test("interpolates the recipient off the triggering row and sends", async () => {
      const out = await run(
        { type: "sms", to: "{{ data.phone }}", body: "See you at {{ data.starts_at }}" },
        { phone: "+14155552671", starts_at: "09:00" },
      );
      expect(out).toEqual({ ok: true });
    });

    test("a literal number works without any interpolation", async () => {
      expect(await run({ type: "sms", to: "+14155552671", body: "hi" })).toEqual({ ok: true });
    });

    test("a recipient template that renders empty fails loudly", async () => {
      // The row simply has no phone. Handing the provider a blank number would
      // report a "successful" 0-send and the reminder would vanish silently.
      const out = await run({ type: "sms", to: "{{ data.phone }}", body: "hi" }, {});
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/rendered empty/);
    });

    test("a recipient that renders to a non-E.164 value fails loudly", async () => {
      const out = await run({ type: "sms", to: "{{ data.phone }}", body: "hi" }, { phone: "555-1234" });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/E\.164/);
      // The error lands on the `flow.run` activity row, so it names the
      // misconfigured template and must NOT echo the customer's number.
      expect(out.error).toContain("{{ data.phone }}");
      expect(out.error).not.toContain("555-1234");
    });
  });

  describe("addressing by user (the staff case)", () => {
    test("texts the user's registered number", async () => {
      const reg = await h.fetch("/api/phone-numbers", json({ phoneNumber: "+14155550000" }));
      expect(reg.status).toBe(200);
      expect(await run({ type: "sms", userId: await myId(h), body: "hi" })).toEqual({ ok: true });
    });

    test("a user with no registered number is a silent no-op, not a failure", async () => {
      // Mirrors `push`: an unreachable recipient must not fail the whole flow.
      expect(await run({ type: "sms", userId: await myId(h), body: "hi" })).toEqual({ ok: true });
    });

    test("a userId template that renders empty fails loudly", async () => {
      const out = await run({ type: "sms", userId: "{{ data.author }}", body: "hi" }, {});
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/rendered empty/);
    });
  });

  describe("the operation schema rejects an ambiguous recipient at save time", () => {
    test("both `to` and `userId` is refused", async () => {
      const res = await makeFlow({ type: "sms", to: "+14155552671", userId: "u1", body: "hi" });
      expect(res.status).toBe(422);
    });

    test("neither `to` nor `userId` is refused", async () => {
      const res = await makeFlow({ type: "sms", body: "hi" });
      expect(res.status).toBe(422);
    });

    test("an empty body is refused", async () => {
      const res = await makeFlow({ type: "sms", to: "+14155552671", body: "" });
      expect(res.status).toBe(422);
    });
  });
});

describe("sendSmsToNumbers", () => {
  let h: TestHarness;
  let client: Database;
  let ctx: { db: any; dialect: "sqlite"; smsFor: any };

  beforeEach(() => {
    h = makeHarness();
    client = new Database(h.env.SQLITE_PATH as string);
    ctx = {
      db: drizzle({ client }),
      dialect: "sqlite",
      smsFor: async () => ({
        send: async (msg: { to: string[]; body: string; from?: string }) => {
          sent.push(msg);
          return { sent: msg.to.length, failed: 0, invalidNumbers: [] };
        },
      }),
    };
    sent = [];
  });
  afterEach(() => h.cleanup());

  let sent: { to: string[]; body: string; from?: string }[] = [];

  test("sends to raw numbers with no phone_numbers lookup", async () => {
    const r = await sendSmsToNumbers(ctx, "t1", { numbers: ["+14155552671"], body: "hi" });
    expect(r.sent).toBe(1);
    expect(sent[0]?.to).toEqual(["+14155552671"]);
  });

  test("de-dupes repeated numbers so a recipient is texted once", async () => {
    await sendSmsToNumbers(ctx, "t1", { numbers: ["+14155552671", "+14155552671"], body: "hi" });
    expect(sent[0]?.to).toEqual(["+14155552671"]);
  });

  test("an empty recipient set never reaches the transport", async () => {
    const r = await sendSmsToNumbers(ctx, "t1", { numbers: [], body: "hi" });
    expect(r).toEqual({ sent: 0, failed: 0, invalidNumbers: [] });
    expect(sent).toHaveLength(0);
  });

  test("passes the sender override through", async () => {
    await sendSmsToNumbers(ctx, "t1", { numbers: ["+14155552671"], body: "hi", from: "BACKLEX" });
    expect(sent[0]?.from).toBe("BACKLEX");
  });
});
