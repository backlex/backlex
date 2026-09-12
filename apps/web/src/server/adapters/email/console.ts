import type { EmailAdapter } from "@backlex/core";

export const consoleEmail = (): EmailAdapter => ({
  provider: "console",
  // Nothing is delivered here at all, so there is no sense in which the file
  // arrives — but the question this flag answers is "would this transport drop
  // the attachment while claiming to have sent the mail", and the answer is no.
  // It drops the whole message, visibly, and `provider: "console"` says so.
  attachments: true,
  async send(msg) {
    const files = (msg.attachments ?? []).map((a) => a.filename).join(", ");
    console.log(
      `[email] to=${msg.to} subject=${JSON.stringify(msg.subject)}` +
        `${files ? ` attachments=[${files}]` : ""}\n${msg.text}`,
    );
  },
});
