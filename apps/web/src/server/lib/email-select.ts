import type { EmailAdapter } from "@backlex/core/adapters";
import { consoleEmail } from "../adapters/email.console";
import { resendEmail } from "../adapters/email.resend";
import { sendgridEmail } from "../adapters/email.sendgrid";
import { mailgunEmail } from "../adapters/email.mailgun";
import { sesEmail } from "../adapters/email.ses";
import { smtpEmail } from "../adapters/email.smtp";
import { isCloudflareWorkers, isEdgeRuntime } from "./runtime";
import type { Env } from "../env";

/**
 * Normalized, fully-resolved email transport spec — the union the env layer
 * AND the per-workspace `email_config` layer both compile down to before being
 * handed to {@link buildEmailAdapter}. Keeping a single spec type means adapter
 * wiring (and the SMTP-on-Workers guard) lives in exactly one place.
 */
export type EmailSpec =
  | { provider: "console" }
  | { provider: "resend"; from: string; apiKey: string }
  | { provider: "sendgrid"; from: string; apiKey: string }
  | { provider: "mailgun"; from: string; apiKey: string; domain: string; host?: string }
  | { provider: "ses"; from: string; accessKeyId: string; secretAccessKey: string; region: string }
  | {
      provider: "smtp";
      from: string;
      host: string;
      port?: number;
      secure?: boolean;
      user?: string;
      pass?: string;
    };

export type EmailProviderId = EmailSpec["provider"];
/** Provider ids selectable in per-workspace config. `inherit` = "use the next
 *  level down" (the instance `_global` row, then the deployment env). */
export const EMAIL_PROVIDER_IDS = [
  "inherit",
  "console",
  "resend",
  "sendgrid",
  "mailgun",
  "ses",
  "smtp",
] as const;
export type EmailConfigProviderId = (typeof EMAIL_PROVIDER_IDS)[number];

/** @deprecated re-export for back-compat — use `lib/runtime.ts` directly. */
export const onCloudflareWorkers = isCloudflareWorkers;

/**
 * Turn a resolved {@link EmailSpec} into a live adapter. Returns `undefined`
 * when the spec can't be served *here* — currently only `smtp` on Cloudflare
 * Workers (no raw TCP); callers fall back to the next transport.
 */
export const buildEmailAdapter = (spec: EmailSpec): EmailAdapter | undefined => {
  switch (spec.provider) {
    case "console":
      return consoleEmail();
    case "resend":
      return resendEmail(spec.apiKey, spec.from);
    case "sendgrid":
      return sendgridEmail(spec.apiKey, spec.from);
    case "mailgun":
      return mailgunEmail(spec.apiKey, spec.domain, spec.from, spec.host);
    case "ses":
      return sesEmail(spec.accessKeyId, spec.secretAccessKey, spec.region, spec.from);
    case "smtp": {
      if (isEdgeRuntime()) {
        console.warn(
          "[email] SMTP is not supported on edge runtimes (Cloudflare Workers / Vercel Edge / Netlify Edge — no raw TCP) — use resend/sendgrid/mailgun/ses instead",
        );
        return undefined;
      }
      const port = spec.port ?? 587;
      return smtpEmail(
        { host: spec.host, port, secure: spec.secure ?? port === 465, user: spec.user, pass: spec.pass },
        spec.from,
      );
    }
  }
};

/** Candidate spec per provider, built from `Env` — `undefined` when its
 *  credentials (plus `EMAIL_FROM`) aren't all present. */
const envSpecs = (
  env: Env,
): Record<Exclude<EmailProviderId, "console">, () => EmailSpec | undefined> => {
  const from = env.EMAIL_FROM;
  return {
    resend: () =>
      from && env.RESEND_API_KEY ? { provider: "resend", from, apiKey: env.RESEND_API_KEY } : undefined,
    sendgrid: () =>
      from && env.SENDGRID_API_KEY
        ? { provider: "sendgrid", from, apiKey: env.SENDGRID_API_KEY }
        : undefined,
    mailgun: () =>
      from && env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN
        ? {
            provider: "mailgun",
            from,
            apiKey: env.MAILGUN_API_KEY,
            domain: env.MAILGUN_DOMAIN,
            host: env.MAILGUN_HOST,
          }
        : undefined,
    ses: () =>
      from && env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY && env.SES_REGION
        ? {
            provider: "ses",
            from,
            accessKeyId: env.SES_ACCESS_KEY_ID,
            secretAccessKey: env.SES_SECRET_ACCESS_KEY,
            region: env.SES_REGION,
          }
        : undefined,
    smtp: () =>
      from && env.SMTP_HOST
        ? {
            provider: "smtp",
            from,
            host: env.SMTP_HOST,
            port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
            secure: env.SMTP_SECURE === "true" ? true : undefined,
            user: env.SMTP_USER,
            pass: env.SMTP_PASSWORD,
          }
        : undefined,
  };
};

/**
 * Resolve the deployment-level email adapter from `Env`. `EMAIL_PROVIDER`
 * forces a specific transport; when unset we auto-detect from whichever
 * provider has complete credentials (priority: resend → sendgrid → mailgun →
 * ses → smtp) and otherwise log to stdout. An explicitly-requested provider
 * with missing/unsupported config warns and degrades to the console adapter
 * rather than crashing the runtime.
 */
export const selectEmailAdapter = (env: Env): EmailAdapter => {
  const specs = envSpecs(env);
  const explicit = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (explicit === "console") return consoleEmail();
  if (explicit && explicit in specs) {
    const spec = specs[explicit as Exclude<EmailProviderId, "console">]();
    const adapter = spec ? buildEmailAdapter(spec) : undefined;
    if (adapter) return adapter;
    console.warn(
      `[email] EMAIL_PROVIDER=${explicit} but its config (+ EMAIL_FROM) is not usable here — falling back to console adapter`,
    );
    return consoleEmail();
  }
  if (explicit) {
    console.warn(`[email] unknown EMAIL_PROVIDER=${explicit} — falling back to auto-detect`);
  }
  for (const key of ["resend", "sendgrid", "mailgun", "ses", "smtp"] as const) {
    const spec = specs[key]();
    const adapter = spec ? buildEmailAdapter(spec) : undefined;
    if (adapter) return adapter;
  }
  return consoleEmail();
};
