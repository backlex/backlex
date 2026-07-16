export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
  /** Set to `"console"` by the dev/no-SMTP fallback adapter so callers can
   *  tell the user their mail was only logged, not delivered (e.g. invite
   *  flows surface a copyable link instead of claiming "email sent"). Real
   *  transports leave it unset. */
  provider?: string;
}
