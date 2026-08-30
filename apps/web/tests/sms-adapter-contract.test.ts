/**
 * One conformance suite, run against every SMS backend.
 *
 * Five files implement `SMSAdapter`, and the contract is a *counting* one:
 * `send()` answers `{ sent, failed, invalidNumbers }` and the caller acts on
 * those numbers — the messaging service reports them to the operator, and
 * `invalidNumbers` is what prunes a dead number from the workspace's list.
 *
 * That makes every failure here arithmetic, and arithmetic fails quietly. A
 * provider that drops a recipient reports `sent: 2` for a three-number send and
 * nothing anywhere says the third was lost. A provider that counts a rejection
 * as sent reports success for a message nobody received. Neither raises an
 * error, neither shows in a log, and the operator's only signal is a customer
 * who says they never got the text.
 *
 * The suite is therefore about the accounting, not about any provider's wire
 * format. Each adapter is driven with a fake `fetch` that answers the way its
 * own API does, and the assertions are the ones that must hold for all of them
 * at once.
 *
 * **Not asserted: E164 validation.** The contract exports `E164_PATTERN` and no
 * adapter imports it, which looks like an omission and is not — malformed
 * numbers are refused upstream (`routes/phone-numbers.ts`, `services/flows.ts`)
 * and `invalidNumbers` means "the carrier says this number is dead", which is a
 * different thing that only the provider can know. Demanding validation here
 * would be inventing a requirement rather than checking one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SMSAdapter, SMSSendResult } from "@backlex/core/adapters";
import { twilioSms } from "../src/server/adapters/sms.twilio";
import { netgsmSms } from "../src/server/adapters/sms.netgsm";
import { iletimerkeziSms } from "../src/server/adapters/sms.iletimerkezi";
import { snsSms } from "../src/server/adapters/sms.sns";
import { consoleSms } from "../src/server/adapters/sms.console";
import { asFetch } from "./helpers/fetch-stub";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TO = ["+15551230001", "+15551230002", "+15551230003"];

/** How each provider says "accepted" and "rejected, and this number is dead". */
type Wire = {
  ok: () => Response;
  /** A refusal that names the recipient as unreachable. */
  deadNumber: () => Response;
  /** A refusal that says nothing about the recipient (an outage). */
  transient: () => Response;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The five backends, each with the wire shapes its own API produces.
 *
 * Written from each adapter's parsing code rather than invented, because a
 * fake that answers the way the ADAPTER wishes would make the suite agree with
 * itself — the same trap the storage conformance suite documents.
 */
const BACKENDS: Array<{
  label: string;
  make: () => SMSAdapter;
  wire: Wire;
  /** Some providers batch every recipient into one call and cannot attribute
   *  a per-number verdict; they are exempt from the per-number assertions and
   *  say so here rather than being quietly skipped. */
  perNumber: boolean;
}> = [
  {
    label: "twilio",
    make: () => twilioSms({ accountSid: "AC0", authToken: "tok", from: "+15550000000" }),
    wire: {
      ok: () => json({ sid: "SM1" }, 201),
      // 21614 = "not a mobile number" — one of the codes twilio's adapter maps.
      deadNumber: () => json({ code: 21614, message: "not mobile" }, 400),
      transient: () => json({ message: "service unavailable" }, 503),
    },
    perNumber: true,
  },
  {
    label: "netgsm",
    make: () => netgsmSms({ usercode: "u", password: "p", msgheader: "H" } as never),
    wire: {
      ok: () => new Response("00 1234567", { status: 200 }),
      deadNumber: () => new Response("30", { status: 200 }),
      transient: () => new Response("", { status: 500 }),
    },
    perNumber: false,
  },
  {
    label: "iletimerkezi",
    make: () => iletimerkeziSms({ key: "k", hash: "h", sender: "S" } as never),
    // JSON, despite the API's XML-looking docs — and HTTP 200 carries the real
    // outcome in `status.code`, so a 200 alone is not success.
    wire: {
      ok: () => json({ response: { status: { code: "200" } } }),
      deadNumber: () => json({ response: { status: { code: "404" } } }),
      transient: () => new Response("", { status: 500 }),
    },
    perNumber: false,
  },
  {
    label: "sns",
    make: () => snsSms({ region: "eu-west-1", accessKeyId: "AK", secretAccessKey: "SK" }),
    wire: {
      ok: () => new Response("<PublishResponse/>", { status: 200 }),
      // The adapter requires BOTH markers before it will call a number dead —
      // `InvalidParameter` alone is any malformed request, not a bad phone.
      deadNumber: () =>
        new Response(
          "<Error><Code>InvalidParameter</Code><Message>Invalid parameter: PhoneNumber</Message></Error>",
          { status: 400 },
        ),
      transient: () => new Response("", { status: 500 }),
    },
    perNumber: true,
  },
  {
    label: "console",
    make: () => consoleSms(),
    wire: { ok: () => json({}), deadNumber: () => json({}), transient: () => json({}) },
    perNumber: true,
  },
];

/** Answer every outbound call with `reply`, and count the calls. */
const stub = (reply: () => Response) => {
  let calls = 0;
  globalThis.fetch = asFetch(async () => {
    calls += 1;
    return reply();
  });
  return () => calls;
};

const accounted = (r: SMSSendResult) => r.sent + r.failed;

for (const { label, make, wire, perNumber } of BACKENDS) {
  describe(`SMSAdapter conformance — ${label}`, () => {
    test("every recipient is accounted for on a clean send", async () => {
      // The invariant the whole contract rests on: a number is either sent or
      // failed. One that is neither has been dropped, and `sent: 2` out of
      // three is a number an operator reads as success.
      stub(wire.ok);
      const r = await make().send({ to: [...TO], body: "hello" });
      expect(`${label}: accounted ${accounted(r)} of ${TO.length}`).toBe(
        `${label}: accounted ${TO.length} of ${TO.length}`,
      );
      expect(`${label}: sent ${r.sent}`).toBe(`${label}: sent ${TO.length}`);
      expect(r.invalidNumbers).toEqual([]);
    });

    test("a provider refusal counts as failed, never as sent", async () => {
      // A rejection that lands in `sent` is the worst outcome available: the
      // operator is told the message went out, and nothing ever revisits it.
      stub(wire.transient);
      const r = await make().send({ to: [...TO], body: "hello" });
      if (label === "console") {
        // The console adapter has no provider to refuse — it is the dev sink
        // and always accepts. Stated rather than skipped.
        expect(`${label}: sent ${r.sent}`).toBe(`${label}: sent ${TO.length}`);
        return;
      }
      expect(`${label}: sent on refusal ${r.sent}`).toBe(`${label}: sent on refusal 0`);
      expect(`${label}: accounted ${accounted(r)}`).toBe(`${label}: accounted ${TO.length}`);
    });

    test("send never throws — a failure is a count, not an exception", async () => {
      // The messaging service sends to many recipients in one call and reports
      // one summary. An adapter that throws takes the whole batch down,
      // including the recipients that would have succeeded.
      globalThis.fetch = asFetch(async () => {
        throw new Error("ECONNREFUSED");
      });
      if (label === "console") {
        // No provider to be unreachable — the dev sink writes to stdout.
        expect((await make().send({ to: [...TO], body: "x" })).sent).toBe(TO.length);
        return;
      }
      const r = await make().send({ to: [...TO], body: "hello" });
      expect(`${label}: accounted ${accounted(r)}`).toBe(`${label}: accounted ${TO.length}`);
      expect(`${label}: sent ${r.sent}`).toBe(`${label}: sent 0`);
    });

    test("an empty recipient list sends nothing and calls nobody", async () => {
      // Guarded explicitly in three of the five. A provider called with zero
      // recipients bills for the request and some answer 400, which surfaces
      // as a failed send of a message nobody was going to receive.
      const calls = stub(wire.ok);
      const r = await make().send({ to: [], body: "hello" });
      expect(r).toEqual({ sent: 0, failed: 0, invalidNumbers: [] });
      expect(`${label}: outbound calls ${calls()}`).toBe(`${label}: outbound calls 0`);
    });

    if (perNumber && label !== "console") {
      test("a dead number is reported so the caller can prune it", async () => {
        // `invalidNumbers` is the only path by which a workspace stops texting
        // a disconnected number. An adapter that folds it into `failed`
        // retries it on every campaign, forever.
        stub(wire.deadNumber);
        const r = await make().send({ to: [...TO], body: "hello" });
        expect(`${label}: invalid ${r.invalidNumbers.length}`).toBe(
          `${label}: invalid ${TO.length}`,
        );
        // And they must be the numbers that were passed in, not synthesised.
        for (const n of r.invalidNumbers) expect(TO).toContain(n);
        expect(`${label}: accounted ${accounted(r)}`).toBe(`${label}: accounted ${TO.length}`);
      });
    }
  });
}

describe("the suite covers the backends that exist", () => {
  test("every sms adapter file is either exercised or named as absent", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../src/server/adapters", import.meta.url))
      .filter((f) => /^sms\..*\.ts$/.test(f))
      .map((f) => f.replace(/^sms\.|\.ts$/g, ""))
      .sort();
    expect(files).toEqual(["cloud", "console", "iletimerkezi", "netgsm", "sns", "twilio"]);

    const covered = BACKENDS.map((b) => b.label).sort();
    // `cloud` is deliberately absent: it proxies to the managed control plane
    // rather than to a carrier, so its "conformance" is the control plane's
    // and a fake here would assert our own request shape back at us.
    expect(covered).toEqual(["console", "iletimerkezi", "netgsm", "sns", "twilio"]);
  });
});
