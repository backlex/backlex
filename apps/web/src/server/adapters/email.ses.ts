import { AwsClient } from "aws4fetch";
import type { EmailAdapter } from "@backlex/core";
import { rawMimeBase64 } from "../lib/mime";

/**
 * Amazon SES v2 send-email API (`POST /v2/email/outbound-emails`). Requests
 * are SigV4-signed via `aws4fetch`, so this works in any runtime with WHATWG
 * `fetch` (Bun, Workers, Vercel/Netlify Edge, Node 18+). `region` must be a
 * region where SES is enabled and the `from` address/domain is verified.
 */
export const sesEmail = (
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  defaultFrom: string,
): EmailAdapter => {
    // `retries` is pinned rather than inherited. aws4fetch defaults to TEN
    // retries with exponential backoff from 50 ms, so a 5xx or a 429 keeps ONE
    // call blocked for tens of seconds — measured at 38 s in the conformance
    // suite. That is most of a Worker's wall budget spent inside a single
    // send, and it is redundant: the durable job queue owns the long retry and
    // has the DLQ to show for it. Two absorbs a blip; anything longer belongs
    // to the queue.
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: "ses", retries: 2 });
  const endpoint = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  return {
    attachments: true,
    async send(msg) {
      const from = msg.from ?? defaultFrom;
      // SES's `Simple` shape has no attachment field at all, so a message with
      // one has to be assembled as a whole MIME document and sent as `Raw`.
      // Only that case pays for it — `Simple` stays the path for ordinary mail,
      // where SES does the encoding and header work itself.
      const body = msg.attachments?.length
        ? {
            FromEmailAddress: from,
            Destination: { ToAddresses: [msg.to] },
            Content: {
              Raw: {
                Data: rawMimeBase64({
                  from,
                  to: msg.to,
                  subject: msg.subject,
                  text: msg.text,
                  html: msg.html,
                  attachments: msg.attachments,
                }),
              },
            },
          }
        : {
            FromEmailAddress: from,
            Destination: { ToAddresses: [msg.to] },
            Content: {
              Simple: {
                Subject: { Data: msg.subject },
                Body: {
                  Text: { Data: msg.text },
                  ...(msg.html ? { Html: { Data: msg.html } } : {}),
                },
              },
            },
          };
      const res = await aws.fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`ses: ${res.status} ${text.slice(0, 200)}`);
      }
    },
  };
};
