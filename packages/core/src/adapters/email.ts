export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}
