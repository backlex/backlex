import { afterEach, describe, expect, test } from "bun:test";
import { cloudEmailAdapter } from "../src/server/adapters/email.cloud";
import type { Env } from "../src/server/env";

// Managed-cloud env: HTTP delivery channel (no service binding) so the adapter
// uses global fetch, which we stub per-test.
const env = {
  CLOUD_REPORT_SECRET: "test-secret",
  CLOUD_PROJECT_ID: "proj_123",
  CLOUD_REPORT_URL: "https://cloud.test",
} as unknown as Env;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("cloudEmailAdapter", () => {
  test("signs and posts the message to the gateway", async () => {
    let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    await cloudEmailAdapter(env).send({
      to: "user@example.com",
      subject: "Hi",
      text: "Body",
      html: "<p>Body</p>",
    });

    expect(captured!.url).toContain("/api/internal/email/send");
    expect(captured!.body.to).toBe("user@example.com");
    expect(captured!.body.subject).toBe("Hi");
    expect(captured!.body.text).toBe("Body");
    expect(captured!.headers["X-Backlex-Project"]).toBe("proj_123");
    expect(captured!.headers["X-Backlex-Signature"]).toBeTruthy();
  });

  test("maps a 429 throttle to a validation error", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { code: "RATE_LIMITED", message: "Email send rate limit exceeded" } }, 429)) as typeof fetch;
    await expect(
      cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/rate limit/i);
  });

  test("throws on a gateway 500", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "boom" } }, 500)) as typeof fetch;
    await expect(
      cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/boom/);
  });
});

/**
 * The `attachments` flag is a promise about a service in another repo, and for
 * a while it was deliberately `false` while the gateway caught up. Nothing
 * stopped it being flipped early — which would have been worse than leaving it
 * false, because a caller trusting `true` stops telling the operator the file
 * did not travel.
 *
 * These pin the two halves that have to agree. They cannot reach the running
 * gateway, so they assert the half this repo owns: that the claim and the
 * request body say the same thing.
 */
describe("cloudEmailAdapter attachments", () => {
  const file = { filename: "invite.ics", content: "QkVHSU46VkNBTEVOREFS", contentType: "text/calendar" };

  const capture = () => {
    const seen: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    return seen;
  };

  test("declares support, and actually forwards the field", async () => {
    // The failure this exists for: `attachments: true` beside a `send()` that
    // never puts the field on the wire. Both halves, one test — asserting the
    // flag alone would pass on an adapter that silently drops every file.
    const adapter = cloudEmailAdapter(env);
    expect(adapter.attachments).toBe(true);

    const seen = capture();
    await adapter.send({ to: "a@b.com", subject: "s", text: "t", attachments: [file] });

    expect(seen[0]!.body.attachments).toEqual([file]);
  });

  test("forwards the gateway's own shape, unrewritten", async () => {
    // The control plane reads `{ filename, content, contentType? }` with
    // `content` base64. Nothing translates in between, so a rename on either
    // side has to break something — let it break here.
    const seen = capture();
    await cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t", attachments: [file] });

    const sent = (seen[0]!.body.attachments as Record<string, unknown>[])[0]!;
    expect(Object.keys(sent).sort()).toEqual(["content", "contentType", "filename"]);
    expect(sent.content).not.toMatch(/^data:/);
  });

  test("a message with no attachments omits the key entirely", async () => {
    // The gateway treats an empty array as "none", but sending `[]` where the
    // field is meaningless invites a future validator to disagree.
    const seen = capture();
    await cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t", attachments: [] });

    expect("attachments" in seen[0]!.body).toBe(false);
  });

  test("a gateway refusal surfaces its reason, not a generic failure", async () => {
    // The gateway refuses rather than trims past its caps. That choice is only
    // worth anything if the reason reaches whoever sent the mail.
    globalThis.fetch = (async () =>
      jsonResponse({ error: { code: "VALIDATION", message: "Attachments are too large" } }, 400)) as typeof fetch;

    await expect(
      cloudEmailAdapter(env).send({ to: "a@b.com", subject: "s", text: "t", attachments: [file] }),
    ).rejects.toThrow(/Attachments are too large/);
  });
});
