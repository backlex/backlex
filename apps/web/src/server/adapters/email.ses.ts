import { AwsClient } from "aws4fetch";
import type { EmailAdapter } from "@workeros/core";

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
    async send(msg) {
      const body = {
        FromEmailAddress: msg.from ?? defaultFrom,
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
