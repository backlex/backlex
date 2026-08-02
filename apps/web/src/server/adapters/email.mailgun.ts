import type { EmailAdapter } from "@backlex/core";

interface MailgunErrorBody {
  message?: string;
}

/**
 * Mailgun Messages API. `host` is `api.mailgun.net` (US, default) or
 * `api.eu.mailgun.net` (EU region). `domain` is the sending domain
 * configured in Mailgun (e.g. `mg.example.com`).
 */
/** base64 → bytes, for the multipart file part. */
const decode = (b64: string): Uint8Array => {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const mailgunEmail = (
  apiKey: string,
  domain: string,
  defaultFrom: string,
  host = "api.mailgun.net",
): EmailAdapter => ({
  attachments: true,
  async send(msg) {
    const files = msg.attachments ?? [];
    // Attachments have to travel as multipart. The urlencoded form stays the
    // default for everything else: it is what the existing transactional mail
    // has always sent, and switching every message to multipart to serve the
    // rare one with a file is a change nobody asked for.
    const body: URLSearchParams | FormData = files.length ? new FormData() : new URLSearchParams();
    body.set("from", msg.from ?? defaultFrom);
    body.set("to", msg.to);
    body.set("subject", msg.subject);
    body.set("text", msg.text);
    if (msg.html) body.set("html", msg.html);
    for (const f of files) {
      (body as FormData).append(
        "attachment",
        new Blob([decode(f.content) as unknown as BlobPart], {
          type: f.contentType ?? "application/octet-stream",
        }),
        f.filename,
      );
    }
    const res = await fetch(`https://${host}/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`api:${apiKey}`)}`,
        // Omitted for FormData on purpose — `fetch` has to set it itself so the
        // multipart boundary in the header matches the one in the body.
        ...(files.length ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      body,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as MailgunErrorBody;
      throw new Error(`mailgun: ${res.status} ${body.message ?? "send failed"}`);
    }
  },
});
