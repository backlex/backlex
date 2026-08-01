import type { EmailAdapter } from "@backlex/core";

interface ResendErrorBody {
  message?: string;
}

export const resendEmail = (apiKey: string, defaultFrom: string): EmailAdapter => ({
  attachments: true,
  async send(msg) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: msg.from ?? defaultFrom,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        // Resend takes the base64 string directly on `content`.
        ...(msg.attachments?.length
          ? {
              attachments: msg.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                ...(a.contentType ? { content_type: a.contentType } : {}),
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ResendErrorBody;
      throw new Error(`resend: ${res.status} ${body.message ?? "send failed"}`);
    }
  },
});
