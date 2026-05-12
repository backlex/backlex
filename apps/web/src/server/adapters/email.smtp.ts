import nodemailer from "nodemailer";
import type { EmailAdapter } from "@workeros/core";

export interface SmtpConfig {
  host: string;
  port: number;
  /** `true` → implicit TLS (port 465). `false` → plaintext/STARTTLS (587, 25);
   *  nodemailer upgrades via STARTTLS automatically when the server offers it. */
  secure: boolean;
  user?: string;
  pass?: string;
}

/**
 * Generic SMTP transport via nodemailer. Needs a runtime with Node's
 * `net`/`tls` — Bun, Vercel/Netlify Node functions, or self-host. It does
 * **not** work on Cloudflare Workers (no raw TCP sockets); the Worker bundle
 * aliases `nodemailer` to a throwing stub and `buildContext` never selects
 * this adapter there. On Workers use an HTTP-API provider instead
 * (resend / sendgrid / mailgun / ses).
 */
export const smtpEmail = (cfg: SmtpConfig, defaultFrom: string): EmailAdapter => {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user || cfg.pass
      ? { auth: { user: cfg.user ?? "", pass: cfg.pass ?? "" } }
      : {}),
  });
  return {
    async send(msg) {
      await transport.sendMail({
        from: msg.from ?? defaultFrom,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      });
    },
  };
};
