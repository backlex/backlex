import type { EmailAdapter } from "@backlex/core";

interface SendGridErrorBody {
  errors?: { message?: string }[];
}

export const sendgridEmail = (apiKey: string, defaultFrom: string): EmailAdapter => ({
  async send(msg) {
    const content: { type: string; value: string }[] = [
      { type: "text/plain", value: msg.text },
    ];
    if (msg.html) content.push({ type: "text/html", value: msg.html });
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: msg.from ?? defaultFrom },
        subject: msg.subject,
        content,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as SendGridErrorBody;
      const detail = body.errors?.[0]?.message ?? "send failed";
      throw new Error(`sendgrid: ${res.status} ${detail}`);
    }
  },
});
