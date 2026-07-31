/**
 * SMS transport. Mirrors the EmailAdapter / PushAdapter shape, with the
 * push-style twist that one message targets a *set* of recipients (phone
 * numbers, E.164) and `send` returns a result so the caller can prune numbers
 * the provider reported as permanently undeliverable (unroutable / opted-out).
 *
 * Unlike push (where a single batch can span several platforms and so needs a
 * `multi` fan-out), an SMS deployment uses exactly one provider — so there is
 * no composite SMS adapter; a config resolves to a single leaf.
 */

export type SMSProvider = "twilio" | "sns" | "netgsm" | "iletimerkezi" | "console";

/**
 * Loose E.164 check: leading `+` and 7–15 digits. Deliberately not a
 * carrier/country validation — the provider rejects truly bad numbers at send
 * time and the caller prunes them from `invalidNumbers`. Shared so that
 * registration (`/api/phone-numbers`) and the `sms` flow op agree on what a
 * number looks like.
 */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export interface SMSMessage {
  /** Target phone numbers in E.164 format, e.g. "+14155552671". */
  to: string[];
  /** Message text. */
  body: string;
  /** Optional sender override (a provider sender number / alphanumeric id).
   *  Falls back to the adapter's configured sender when omitted. */
  from?: string;
}

export interface SMSSendResult {
  /** Number of recipients the provider accepted for delivery. */
  sent: number;
  /** Number that failed for a transient/unknown reason. */
  failed: number;
  /**
   * Numbers the provider rejected as permanently invalid (malformed,
   * unroutable, opted-out). The caller should deactivate these in
   * `phone_numbers`.
   */
  invalidNumbers: string[];
}

export interface SMSAdapter {
  send(msg: SMSMessage): Promise<SMSSendResult>;
}
