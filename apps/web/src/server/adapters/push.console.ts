import type { PushAdapter } from "@backlex/core/adapters";

/** Dev/test transport — logs the notification and "accepts" every token. */
export const consolePush = (): PushAdapter => ({
  async send(msg) {
    const platforms = [...new Set(msg.tokens.map((t) => t.platform))].join(",");
    console.log(
      `[push] tokens=${msg.tokens.length} platforms=${platforms} title=${JSON.stringify(
        msg.title,
      )}\n${msg.body}`,
    );
    return { sent: msg.tokens.length, failed: 0, invalidTokens: [] };
  },
});
