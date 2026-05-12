import type { EmailAdapter } from "@workeros/core";

interface MailgunErrorBody {
  message?: string;
}

/**
 * Mailgun Messages API. `host` is `api.mailgun.net` (US, default) or
 * `api.eu.mailgun.net` (EU region). `domain` is the sending domain
 * configured in Mailgun (e.g. `mg.example.com`).
 */
export const mailgunEmail = (
  apiKey: string,
  domain: string,
  defaultFrom: string,
  host = "api.mailgun.net",
): EmailAdapter => ({
  async send(msg) {
    const form = new URLSearchParams();
    form.set("from", msg.from ?? defaultFrom);
    form.set("to", msg.to);
    form.set("subject", msg.subject);
    form.set("text", msg.text);
    if (msg.html) form.set("html", msg.html);
    const res = await fetch(`https://${host}/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`api:${apiKey}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as MailgunErrorBody;
      throw new Error(`mailgun: ${res.status} ${body.message ?? "send failed"}`);
    }
  },
});
