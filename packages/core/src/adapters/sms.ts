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
