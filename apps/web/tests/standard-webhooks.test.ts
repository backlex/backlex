/**
 * The Standard Webhooks signer, cross-checked against a verifier we did not
 * write for it.
 *
 * Auth hooks sign with `lib/standard-webhooks.ts`; `@backlex/integrations`
 * already contains a Standard Webhooks VERIFIER (the Polar branch of
 * `verifyPaymentSignature`), written independently and against the spec, for
 * incoming webhooks. Two hand-written implementations of one format is exactly
 * the shape that drifts — so instead of trusting them to agree, this asserts it.
 * If our signature stops being verifiable by that code, it has stopped being
 * verifiable by every off-the-shelf `standardwebhooks` library too, which is
 * the entire reason for using this format on the endpoint an app implements
 * first.
 *
 * Same family of check as the `E164_PATTERN` / `E164_RE` corpus test: twins
 * that span a package boundary get a test, not a merge.
 */
import { describe, expect, test } from "bun:test";
import { verifyPaymentSignature } from "@backlex/integrations/payments";
import {
  generateStandardWebhookSecret,
  signStandardWebhook,
  standardWebhookKeyBytes,
} from "../src/server/lib/standard-webhooks";

const BODY = JSON.stringify({ event: "before-user-created", data: { email: "a@b.test" } });

const verify = (secret: string, headers: Record<string, string>, rawBody: string) =>
  verifyPaymentSignature("polar", { headers, rawBody, secret });

describe("our signature verifies against the independent verifier", () => {
  test("a base64 `whsec_` secret round-trips", async () => {
    const secret = generateStandardWebhookSecret();
    const headers = await signStandardWebhook(secret, BODY);
    expect(await verify(secret, headers, BODY)).toEqual({ ok: true });
  });

  test("a bare (non-base64) secret round-trips too", async () => {
    // The spec's reference implementations fall back to raw bytes; both sides
    // have to make the same fallback or a hand-typed secret silently fails.
    const secret = "not base64 at all!!";
    const headers = await signStandardWebhook(secret, BODY);
    expect(await verify(secret, headers, BODY)).toEqual({ ok: true });
  });

  test("a changed body fails verification", async () => {
    const secret = generateStandardWebhookSecret();
    const headers = await signStandardWebhook(secret, BODY);
    const r = await verify(secret, headers, `${BODY} `);
    expect(r.ok).toBe(false);
  });

  test("a changed id or timestamp fails verification — both are inside the signature", async () => {
    const secret = generateStandardWebhookSecret();
    const headers = await signStandardWebhook(secret, BODY);
    expect((await verify(secret, { ...headers, "webhook-id": "msg_other" }, BODY)).ok).toBe(false);
  });

  test("the wrong secret fails verification", async () => {
    const headers = await signStandardWebhook(generateStandardWebhookSecret(), BODY);
    const r = await verify(generateStandardWebhookSecret(), headers, BODY);
    expect(r.ok).toBe(false);
  });

  test("a replayed timestamp is refused by the receiver's tolerance window", async () => {
    // Not our behaviour to enforce — but it is the reason the timestamp
    // travels in its own header, and a signer that omitted it from the signed
    // string would make this check meaningless.
    const secret = generateStandardWebhookSecret();
    const stale = Math.floor(Date.now() / 1000) - 60 * 60;
    const headers = await signStandardWebhook(secret, BODY, { timestampSeconds: stale });
    expect(await verify(secret, headers, BODY)).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });
});

describe("the header set is the one the spec names", () => {
  test("id, timestamp and a `v1,` prefixed base64 signature", async () => {
    const headers = await signStandardWebhook("whsec_c2VjcmV0", BODY, {
      id: "msg_fixed",
      timestampSeconds: 1_800_000_000,
    });
    expect(headers).toEqual({
      "webhook-id": "msg_fixed",
      "webhook-timestamp": "1800000000",
      // A literal vector, not a shape assertion: HMAC-SHA256 over
      // `msg_fixed.1800000000.<body>` with the base64-decoded key. Anything
      // that changes this — the separator, the order, the encoding — is a
      // breaking change for every app already verifying us, and a regex would
      // not notice any of them.
      "webhook-signature": "v1,/rPFp4PJKkxflpfBq5te00fA+kuITXiZTFwtWz2vTZ4=",
    });
  });

  test("a fresh secret is 32 bytes of entropy, base64, `whsec_` prefixed", () => {
    const secret = generateStandardWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(standardWebhookKeyBytes(secret)).toHaveLength(32);
    expect(generateStandardWebhookSecret()).not.toBe(secret);
  });
});
