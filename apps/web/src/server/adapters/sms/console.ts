import type { SMSAdapter } from "@backlex/core/adapters";

/** Dev/test transport — logs the message and "accepts" every recipient. */
export const consoleSms = (): SMSAdapter => ({
  async send(msg) {
    console.log(
      `[sms] to=${msg.to.length} from=${msg.from ?? "-"} body=${JSON.stringify(msg.body)}`,
    );
    return { sent: msg.to.length, failed: 0, invalidNumbers: [] };
  },
});
