import type { SMSAdapter, SMSMessage, SMSSendResult } from "@backlex/core/adapters";

/**
 * NetGSM (TR) via the classic HTTP GET API — `https://api.netgsm.com.tr/sms/send/get`.
 * Auth is the panel `usercode` + `password` passed as query params; `msgheader`
 * is the pre-approved alphanumeric sender (başlık) registered with NetGSM.
 * Runtime-agnostic: only `fetch`.
 *
 * Two deliberate simplifications, both documented rather than clever:
 *
 * 1. **One request per recipient.** The endpoint does accept several `gsmno`
 *    values, but then it answers with a *single* status line for the whole
 *    batch — which destroys per-number attribution. `invalidNumbers` is what
 *    prunes rows from `phone_numbers`, so a batch answer would either prune
 *    nobody or prune everybody. One call per number keeps the mapping exact,
 *    same as the Twilio/SNS adapters.
 * 2. **Plain-text response.** The GET API always answers HTTP 200 and puts the
 *    real outcome in the body: `"00 <bulkid>"` on success, otherwise a bare
 *    numeric error code. So a 200 is *not* a success — the body decides.
 */

interface NetgsmConfig {
  /** NetGSM panel user code (subscriber no / API user). */
  usercode: string;
  /**
   * Panel password. NetGSM's classic API takes it as a *query parameter*, so it
   * rides in the URL — that is the documented contract, not an oversight. We
   * therefore never log the request URL, and the value is stored encrypted
   * (see `SMS_SECRET_KEYS`). Prefer an API-only sub-user in the NetGSM panel.
   */
  password: string;
  /** Pre-approved sender header (başlık) registered with NetGSM. */
  msgheader: string;
}

/**
 * NetGSM error codes that describe the *destination number* rather than the
 * account or the message. `70` is documented as "invalid / missing parameter";
 * because every other query parameter we send is constant per config (and a bad
 * one surfaces as its own code — `30` credentials, `40` unknown msgheader, `20`
 * message body), the only per-request variable left is `gsmno`. Assumption:
 * a `70` on a single-recipient call means that number is unroutable.
 *
 * Everything else (`20` message/length, `30` auth or IP not allowed, `40`
 * unknown sender header, `50`/`51` IYS restrictions, `80`/`85` rate limits,
 * `100` system error) is an account-level problem: count it as `failed` so we
 * never deactivate a perfectly good number over a config mistake.
 */
const DEAD_NUMBER_CODES = new Set(["70"]);

const SUCCESS_CODE = "00";

/** E.164 (`+905321234567`) → NetGSM's msisdn form (`905321234567`). */
const toMsisdn = (e164: string): string => e164.trim().replace(/^\+/, "");

export const netgsmSms = (cfg: NetgsmConfig): SMSAdapter => ({
  async send(msg: SMSMessage): Promise<SMSSendResult> {
    if (msg.to.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };
    const header = msg.from ?? cfg.msgheader;
    const result: SMSSendResult = { sent: 0, failed: 0, invalidNumbers: [] };

    await Promise.all(
      msg.to.map(async (to) => {
        const q = new URLSearchParams();
        q.set("usercode", cfg.usercode);
        q.set("password", cfg.password);
        q.set("gsmno", toMsisdn(to));
        q.set("message", msg.body);
        q.set("msgheader", header);

        let res: Response;
        try {
          res = await fetch(`https://api.netgsm.com.tr/sms/send/get?${q.toString()}`, {
            method: "GET",
          });
        } catch {
          result.failed++; // network/DNS failure — transient, never a dead number
          return;
        }
        if (!res.ok) {
          result.failed++;
          return;
        }
        // Body is `"<code>"` or `"<code> <bulkid>"`; the code is the first token.
        const code = (await res.text().catch(() => "")).trim().split(/\s+/)[0] ?? "";
        if (code === SUCCESS_CODE) {
          result.sent++;
          return;
        }
        result.failed++;
        if (DEAD_NUMBER_CODES.has(code)) result.invalidNumbers.push(to);
      }),
    );
    return result;
  },
});
