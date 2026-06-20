import type { SMSAdapter, SMSMessage, SMSSendResult } from "@backlex/core/adapters";

/**
 * Twilio Programmable Messaging via the REST API. Auth is HTTP Basic
 * (`AccountSid:AuthToken`); each recipient is one `Messages.json` POST. Either a
 * `from` number (E.164 / alphanumeric sender id) or a `messagingServiceSid`
 * (MGxxxx) must be set — the message-service form lets Twilio pick the sender
 * pool and handle opt-outs. Runtime-agnostic: only `fetch` + `btoa`.
 */

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** A Twilio phone number (E.164) or approved alphanumeric sender id. */
  from?: string;
  /** A Messaging Service SID (MGxxxx) — alternative to `from`. */
  messagingServiceSid?: string;
}

// Twilio "code" values that mean the destination number is permanently bad:
// 21211 invalid 'To', 21610 recipient unsubscribed (STOP), 21614 not SMS-capable.
const DEAD_NUMBER_CODES = new Set([21211, 21610, 21614]);

export const twilioSms = (cfg: TwilioConfig): SMSAdapter => ({
  async send(msg: SMSMessage): Promise<SMSSendResult> {
    if (msg.to.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      cfg.accountSid,
    )}/Messages.json`;
    const auth = btoa(`${cfg.accountSid}:${cfg.authToken}`);
    const from = msg.from ?? cfg.from;
    const result: SMSSendResult = { sent: 0, failed: 0, invalidNumbers: [] };

    await Promise.all(
      msg.to.map(async (to) => {
        const form = new URLSearchParams();
        form.set("To", to);
        form.set("Body", msg.body);
        if (cfg.messagingServiceSid) form.set("MessagingServiceSid", cfg.messagingServiceSid);
        else if (from) form.set("From", from);

        const res = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Basic ${auth}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        });
        if (res.ok) {
          result.sent++;
          return;
        }
        result.failed++;
        if (res.status === 400) {
          const j = (await res.json().catch(() => null)) as { code?: number } | null;
          if (j?.code && DEAD_NUMBER_CODES.has(j.code)) result.invalidNumbers.push(to);
        }
      }),
    );
    return result;
  },
});
