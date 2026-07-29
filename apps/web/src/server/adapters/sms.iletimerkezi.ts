import type { SMSAdapter, SMSMessage, SMSSendResult } from "@backlex/core/adapters";

/**
 * İleti Merkezi (TR) via the v1 JSON API —
 * `https://api.iletimerkezi.com/v1/send-sms/json`. Auth is the API `key` +
 * `hash` pair issued in the panel, carried inside the request envelope (there is
 * no auth header). `sender` is the pre-approved alphanumeric originator.
 * Runtime-agnostic: only `fetch`.
 *
 * Two notes on the request shape:
 *
 * - The recipient list key really is spelled **`receipents`** in the published
 *   API — that typo is part of the contract, not one of ours.
 * - We send **one request per recipient** even though `receipents.number` is an
 *   array. The response carries a single `status.code` for the whole order, so a
 *   batched call cannot say *which* number was rejected. `invalidNumbers` is what
 *   deactivates rows in `phone_numbers`, so batching would mean either never
 *   pruning a dead number or pruning the whole batch over one bad entry. Same
 *   trade-off the Twilio/SNS adapters make.
 */

interface IletimerkeziConfig {
  /**
   * API key from the panel. Identifier half of the credential pair — stored in
   * the non-secret `config` blob and readable by workspace admins, exactly like
   * Twilio's Account SID. It is useless on its own; `hash` is the secret.
   */
  key: string;
  /** API hash (secret) from the panel — encrypted at rest, never returned. */
  hash: string;
  /** Pre-approved sender / originator title. */
  sender: string;
}

interface IletimerkeziResponse {
  response?: { status?: { code?: number | string; message?: string } };
}

/** Documented success status for the v1 API. */
const SUCCESS_CODE = 200;

/**
 * Status codes that describe the *recipient* rather than the account. `405` is
 * the "invalid / unusable recipient number" status. Assumption noted because the
 * published table is terse: every account-level failure has its own code
 * (`400` malformed request, `401`/`402` credentials, `403` insufficient balance,
 * `404` unapproved sender, `406` empty message, `410` blocked account), so a
 * `405` on a single-recipient order can only be about that number.
 *
 * Anything not listed here counts as `failed` — a transient or config problem
 * must never deactivate a good number.
 */
const DEAD_NUMBER_CODES = new Set([405]);

/** E.164 (`+905321234567`) → the msisdn form the API expects (`905321234567`). */
const toMsisdn = (e164: string): string => e164.trim().replace(/^\+/, "");

export const iletimerkeziSms = (cfg: IletimerkeziConfig): SMSAdapter => ({
  async send(msg: SMSMessage): Promise<SMSSendResult> {
    if (msg.to.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };
    const sender = msg.from ?? cfg.sender;
    const result: SMSSendResult = { sent: 0, failed: 0, invalidNumbers: [] };

    await Promise.all(
      msg.to.map(async (to) => {
        const payload = {
          request: {
            authentication: { key: cfg.key, hash: cfg.hash },
            order: {
              sender,
              message: {
                text: msg.body,
                // sic — "receipents" is the API's own spelling.
                receipents: { number: [toMsisdn(to)] },
              },
            },
          },
        };

        let res: Response;
        try {
          res = await fetch("https://api.iletimerkezi.com/v1/send-sms/json", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch {
          result.failed++; // network/DNS failure — transient, never a dead number
          return;
        }

        const body = (await res.json().catch(() => null)) as IletimerkeziResponse | null;
        const raw = body?.response?.status?.code;
        const code = typeof raw === "string" ? Number(raw) : raw;
        // The API answers HTTP 200 with the real outcome in `status.code`, so a
        // 200 alone is not success. A non-2xx with no parsable body is a failure
        // with no number-level information.
        if (res.ok && code === SUCCESS_CODE) {
          result.sent++;
          return;
        }
        result.failed++;
        if (typeof code === "number" && DEAD_NUMBER_CODES.has(code)) result.invalidNumbers.push(to);
      }),
    );
    return result;
  },
});
