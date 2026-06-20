import type { SMSAdapter } from "@backlex/core/adapters";
import { consoleSms } from "../adapters/sms.console";
import { twilioSms } from "../adapters/sms.twilio";
import { snsSms } from "../adapters/sms.sns";
import type { Env } from "../env";

/**
 * Normalized SMS transport spec — the union both the env layer and the
 * per-workspace `sms_config` layer compile down to before {@link buildSmsAdapter}.
 * Unlike push (one batch can span platforms → a `multi` fan-out), an SMS
 * deployment uses exactly one provider, so there's no composite spec.
 */
export type SMSSpec =
  | { provider: "console" }
  | {
      provider: "twilio";
      accountSid: string;
      authToken: string;
      from?: string;
      messagingServiceSid?: string;
    }
  | {
      provider: "sns";
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      senderId?: string;
    };

export type SMSLeafProviderId = SMSSpec["provider"];

/** Provider ids selectable in per-workspace config. `inherit` = "use the next
 *  level down" (the instance `_global` row, then the deployment env). */
export const SMS_PROVIDER_IDS = ["inherit", "console", "twilio", "sns"] as const;
export type SMSConfigProviderId = (typeof SMS_PROVIDER_IDS)[number];

/** Turn a resolved {@link SMSSpec} into a live adapter. */
export const buildSmsAdapter = (spec: SMSSpec): SMSAdapter => {
  switch (spec.provider) {
    case "console":
      return consoleSms();
    case "twilio":
      return twilioSms(spec);
    case "sns":
      return snsSms(spec);
  }
};

const twilioFromEnv = (env: Env): SMSSpec | undefined =>
  env.TWILIO_ACCOUNT_SID &&
  env.TWILIO_AUTH_TOKEN &&
  (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)
    ? {
        provider: "twilio",
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM,
        messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      }
    : undefined;

const snsFromEnv = (env: Env): SMSSpec | undefined =>
  env.SMS_AWS_REGION && env.SMS_AWS_ACCESS_KEY_ID && env.SMS_AWS_SECRET_ACCESS_KEY
    ? {
        provider: "sns",
        region: env.SMS_AWS_REGION,
        accessKeyId: env.SMS_AWS_ACCESS_KEY_ID,
        secretAccessKey: env.SMS_AWS_SECRET_ACCESS_KEY,
        senderId: env.SMS_AWS_SENDER_ID,
      }
    : undefined;

/**
 * Resolve the deployment-level SMS spec from `Env`. `SMS_PROVIDER` forces one
 * transport; when unset we pick the first provider with complete credentials
 * (twilio → sns) and fall back to `console` when none is configured. The result
 * is the spec that would actually run, so `context.ts` can detect the "nothing
 * real configured" case (`console`) and swap in the managed-cloud adapter.
 */
export const selectSmsSpec = (env: Env): SMSSpec => {
  const explicit = env.SMS_PROVIDER?.trim().toLowerCase();
  if (explicit === "console") return { provider: "console" };
  if (explicit === "twilio") {
    const spec = twilioFromEnv(env);
    if (spec) return spec;
    console.warn("[sms] SMS_PROVIDER=twilio but its credentials are incomplete — using console");
    return { provider: "console" };
  }
  if (explicit === "sns") {
    const spec = snsFromEnv(env);
    if (spec) return spec;
    console.warn("[sms] SMS_PROVIDER=sns but its credentials are incomplete — using console");
    return { provider: "console" };
  }
  if (explicit) {
    console.warn(`[sms] unknown SMS_PROVIDER=${explicit} — falling back to auto-detect`);
  }
  return twilioFromEnv(env) ?? snsFromEnv(env) ?? { provider: "console" };
};

/** Resolve the deployment-level SMS adapter from `Env`. */
export const selectSmsAdapter = (env: Env): SMSAdapter => buildSmsAdapter(selectSmsSpec(env));
