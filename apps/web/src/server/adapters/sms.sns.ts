import type { SMSAdapter, SMSMessage, SMSSendResult } from "@backlex/core/adapters";

/**
 * Amazon SNS SMS (the transport behind AWS Amplify's `notifications`). One
 * `Publish` call per recipient, signed with AWS Signature V4 over the Query
 * API. Everything is Web Crypto (HMAC-SHA256 / SHA-256) so it runs unchanged on
 * Workers / Bun / Node / Deno — no AWS SDK, no Node `crypto`.
 *
 * SigV4 reference:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */

interface SnsConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional alphanumeric Sender ID (supported only in some countries). */
  senderId?: string;
}

const ENC = new TextEncoder();

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  [...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (data: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", ENC.encode(data) as BufferSource));

const hmac = async (key: Uint8Array, data: string): Promise<Uint8Array<ArrayBuffer>> => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, ENC.encode(data) as BufferSource));
};

const signingKey = async (
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  let key: Uint8Array<ArrayBuffer> = ENC.encode(`AWS4${secret}`);
  key = await hmac(key, dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  return key;
};

export const snsSms = (cfg: SnsConfig): SMSAdapter => ({
  async send(msg: SMSMessage): Promise<SMSSendResult> {
    if (msg.to.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };
    const service = "sns";
    const host = `sns.${cfg.region}.amazonaws.com`;
    const endpoint = `https://${host}/`;
    const result: SMSSendResult = { sent: 0, failed: 0, invalidNumbers: [] };

    await Promise.all(
      msg.to.map(async (to) => {
        // YYYYMMDDTHHMMSSZ + the YYYYMMDD date stamp.
        const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
        const dateStamp = amzDate.slice(0, 8);

        const params = new URLSearchParams();
        params.set("Action", "Publish");
        params.set("Version", "2010-03-31");
        params.set("PhoneNumber", to);
        params.set("Message", msg.body);
        if (cfg.senderId) {
          params.set("MessageAttributes.entry.1.Name", "AWS.SNS.SMS.SenderID");
          params.set("MessageAttributes.entry.1.Value.DataType", "String");
          params.set("MessageAttributes.entry.1.Value.StringValue", cfg.senderId);
        }
        const body = params.toString();

        const payloadHash = await sha256Hex(body);
        const canonicalHeaders =
          `content-type:application/x-www-form-urlencoded\n` +
          `host:${host}\n` +
          `x-amz-date:${amzDate}\n`;
        const signedHeaders = "content-type;host;x-amz-date";
        const canonicalRequest = [
          "POST",
          "/",
          "",
          canonicalHeaders,
          signedHeaders,
          payloadHash,
        ].join("\n");
        const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
        const stringToSign = [
          "AWS4-HMAC-SHA256",
          amzDate,
          scope,
          await sha256Hex(canonicalRequest),
        ].join("\n");
        const signature = toHex(
          await hmac(await signingKey(cfg.secretAccessKey, dateStamp, cfg.region, service), stringToSign),
        );
        const authorization =
          `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`;

        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-amz-date": amzDate,
              authorization,
            },
            body,
          });
        } catch {
          // See the matching note in `sms.twilio.ts`: under `Promise.all` a
          // thrown fetch discards the verdicts of recipients already sent.
          result.failed++;
          return;
        }
        if (res.ok) {
          result.sent++;
          return;
        }
        result.failed++;
        // SNS returns 400 InvalidParameter for a malformed destination number.
        if (res.status === 400) {
          const text = await res.text().catch(() => "");
          if (/InvalidParameter/i.test(text) && /phone/i.test(text)) {
            result.invalidNumbers.push(to);
          }
        }
      }),
    );
    return result;
  },
});
