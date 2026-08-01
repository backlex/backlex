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
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: "ses" });
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
