/**
 * One conformance suite, run against every email backend.
 *
 * `EmailAdapter.send()` returns `Promise<void>`. That signature has exactly one
 * way to report a failure — throwing — which makes the contract unusually
 * unforgiving: an adapter that swallows a 401, a suppression-list rejection or
 * a DNS failure has told its caller the mail went out. Nothing downstream can
 * tell the difference, because there is nothing to inspect.
 *
 * What rides on that: invitations, password resets, approval requests and
 * signature invites. Every one of them is a flow where the user is now waiting
 * for a message that will never arrive, and the operator's log says it was
 * sent. `services/email.ts` is the only place that could retry, and it retries
 * on a throw.
 *
 * The second thing asserted here is quieter: the message has to reach the wire.
 * A provider whose payload shape drifted — a renamed field, a `to` that stopped
 * being an array — still gets a 200 from a permissive API and delivers nothing,
 * or delivers a blank message. So each test reads the request body back and
 * checks the recipient and subject are actually in it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { EmailAdapter, EmailMessage } from "@backlex/core/adapters";
import { resendEmail } from "../src/server/adapters/email.resend";
import { sendgridEmail } from "../src/server/adapters/email.sendgrid";
import { mailgunEmail } from "../src/server/adapters/email.mailgun";
import { sesEmail } from "../src/server/adapters/email.ses";
import { consoleEmail } from "../src/server/adapters/email.console";
import { asFetch } from "./helpers/fetch-stub";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MSG: EmailMessage = {
  to: "recipient@example.test",
  subject: "Your invitation",
  text: "Open the link to accept.",
};

const BACKENDS: Array<{ label: string; make: () => EmailAdapter }> = [
  { label: "resend", make: () => resendEmail("re_key", "from@example.test") },
  { label: "sendgrid", make: () => sendgridEmail("SG.key", "from@example.test") },
  { label: "mailgun", make: () => mailgunEmail("key", "mg.example.test", "from@example.test") },
  { label: "ses", make: () => sesEmail("AK", "SK", "eu-west-1", "from@example.test") },
];

/** Record every outbound request and answer with `status`. */
const stub = (status: number, body = "{}") => {
  const seen: { url: string; body: string }[] = [];
  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let payload = "";
    const b = init?.body ?? (input as Request)?.body;
    if (typeof b === "string") payload = b;
    else if (b instanceof URLSearchParams) payload = b.toString();
    else if (b instanceof FormData) payload = [...b.entries()].map(([k, v]) => `${k}=${v}`).join("&");
    else if (input instanceof Request) payload = await input.clone().text().catch(() => "");
    seen.push({ url, body: payload });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return seen;
};

for (const { label, make } of BACKENDS) {
  describe(`EmailAdapter conformance — ${label}`, () => {
    test("a 2xx resolves without throwing", async () => {
      stub(200, JSON.stringify({ id: "msg_1" }));
      await make().send(MSG);
    });

    test("the recipient and subject actually reach the wire", async () => {
      // A payload whose shape drifted still gets a 200 from a permissive API
      // and delivers a blank message — or nothing. The only way to see that
      // from here is to read the request back.
      const seen = stub(200);
      await make().send(MSG);
      expect(`${label}: made a request: ${seen.length}`).toBe(`${label}: made a request: 1`);
      // `+` is a space in a form-encoded body and `decodeURIComponent` leaves
      // it alone — mailgun and ses post urlencoded, so decoding without this
      // makes "Your invitation" read as "Your+invitation" and the assertion
      // fails on the test's bug rather than the adapter's.
      const sent = decodeURIComponent(seen[0]!.body.replace(/\+/g, " "));
      expect(`${label} carries the recipient: ${sent.includes(MSG.to)}`).toBe(
        `${label} carries the recipient: true`,
      );
      expect(`${label} carries the subject: ${sent.includes(MSG.subject)}`).toBe(
        `${label} carries the subject: true`,
      );
    });

    test("a provider refusal THROWS — a void return has no other signal", async () => {
      // 401 stands in for every terminal refusal: expired key, suspended
      // account, unverified sender. Swallowing it tells the caller an
      // invitation was delivered that never left the building.
      stub(401, JSON.stringify({ message: "unauthorized" }));
      await expect(make().send(MSG)).rejects.toThrow();
    });

    test("a 5xx throws too, so the queue can retry it", async () => {
      // The difference between 4xx and 5xx is the caller's business — but only
      // if the caller hears about it at all.
      stub(503, "upstream unavailable");
      const started = Date.now();
      await expect(make().send(MSG)).rejects.toThrow();
      // And it must surface PROMPTLY. `email.ses` signs through aws4fetch,
      // which retries ten times with exponential backoff unless told
      // otherwise — that measured 38 s here, inside one send, which on a
      // Worker is most of the wall budget and duplicates the durable queue's
      // own retry. The bound is generous; the failure it catches is an order
      // of magnitude away.
      expect(`${label}: surfaced within 5s: ${Date.now() - started < 5000}`).toBe(
        `${label}: surfaced within 5s: true`,
      );
    });

    test("a transport failure is not swallowed", async () => {
      globalThis.fetch = asFetch(async () => {
        throw new Error("ECONNREFUSED");
      });
      await expect(make().send(MSG)).rejects.toThrow();
    });

    test("declares whether it can carry attachments", () => {
      // Read by `services/documents.ts` before it tries to mail a generated
      // PDF. An adapter that claimed `true` and dropped the file would send a
      // covering note with nothing attached.
      expect(`${label}: attachments ${make().attachments}`).toBe(`${label}: attachments true`);
    });
  });
}

describe("EmailAdapter conformance — console", () => {
  test("never throws, and says which provider it is", async () => {
    // The dev sink: it must not fail a local sign-up flow, and it is the one
    // adapter that identifies itself, which is how the settings screen can
    // warn that mail is not really going anywhere.
    const c = consoleEmail();
    expect(c.provider).toBe("console");
    await c.send(MSG);
  });

  test("prints the link but not the whole body", async () => {
    // What a developer needs from it is the accept/reset URL. Dumping the full
    // rendered HTML of every transactional mail into the terminal is how a
    // token ends up in a scrollback that gets pasted into an issue.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await consoleEmail().send({ ...MSG, html: "<p>secret markup</p>" });
    } finally {
      console.log = orig;
    }
    const out = lines.join("\n");
    expect(`logged something: ${out.length > 0}`).toBe("logged something: true");
    expect(out).toContain(MSG.to);
    expect(out).not.toContain("secret markup");
  });
});

describe("the suite covers the backends that exist", () => {
  test("every email adapter file is either exercised or named as absent", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../src/server/adapters", import.meta.url))
      .filter((f) => /^email\..*\.ts$/.test(f))
      .map((f) => f.replace(/^email\.|\.ts$/g, ""))
      .sort();
    expect(files).toEqual(["cloud", "console", "mailgun", "resend", "sendgrid", "ses", "smtp"]);

    const EXERCISED = ["console", "mailgun", "resend", "sendgrid", "ses"];
    const NOT_EXERCISED: Record<string, string> = {
      smtp: "opens a real TCP socket and speaks the SMTP dialogue — a fake here would be a mail server, not a stub",
      cloud: "proxies to the managed control plane, whose conformance is its own",
    };
    expect([...EXERCISED, ...Object.keys(NOT_EXERCISED)].sort()).toEqual(files);
    for (const [name, why] of Object.entries(NOT_EXERCISED)) {
      expect(`${name}: ${why.length > 40}`).toBe(`${name}: true`);
    }
  });
});
