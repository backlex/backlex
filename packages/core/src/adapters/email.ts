/**
 * One file travelling with an email.
 *
 * `content` is base64 because that is what every transport here ultimately
 * wants — the JSON APIs take it directly, and the MIME builders would have to
 * encode it anyway. Keeping the field in exactly one encoding means no adapter
 * has to guess whether it was handed text or bytes.
 */
export interface EmailAttachment {
  filename: string;
  /** base64, no line breaks, no `data:` prefix. */
  content: string;
  /** Defaults to `application/octet-stream` where a transport needs one. */
  contentType?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  /**
   * Files to attach.
   *
   * Added for calendar invites — an `.ics` reaches every calendar application
   * there is, with no provider to connect and no OAuth. Every transport in this
   * repo supports it, but a transport is a plug point, so a caller that MUST
   * know whether the file will arrive reads {@link EmailAdapter.attachments}
   * first rather than assuming.
   */
  attachments?: EmailAttachment[];
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
  /** Set to `"console"` by the dev/no-SMTP fallback adapter so callers can
   *  tell the user their mail was only logged, not delivered (e.g. invite
   *  flows surface a copyable link instead of claiming "email sent"). Real
   *  transports leave it unset. */
  provider?: string;
  /**
   * Whether {@link EmailMessage.attachments} actually leaves the building.
   *
   * `false` on a transport that would silently drop the file. That distinction
   * matters more than it looks: an invite email that arrives WITHOUT its `.ics`
   * is indistinguishable, to the recipient, from a system that never tried —
   * so the caller reports "sent without the invite" instead of "sent".
   *
   * Unset means supported; every adapter shipped here sets it explicitly.
   */
  attachments?: boolean;
}
