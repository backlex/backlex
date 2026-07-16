import type { EmailAdapter } from "@backlex/core";

export const consoleEmail = (): EmailAdapter => ({
  provider: "console",
  async send(msg) {
    console.log(
      `[email] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`,
    );
  },
});
