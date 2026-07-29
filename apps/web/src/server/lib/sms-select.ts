import type { SMSAdapter } from "@backlex/core/adapters";
import { consoleSms } from "../adapters/sms.console";
import { twilioSms } from "../adapters/sms.twilio";
import { snsSms } from "../adapters/sms.sns";
import { netgsmSms } from "../adapters/sms.netgsm";
import { iletimerkeziSms } from "../adapters/sms.iletimerkezi";
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
    }
  | {
      provider: "netgsm";
      usercode: string;
      password: string;
      msgheader: string;
    }
  | {
      provider: "iletimerkezi";
      key: string;
      hash: string;
      sender: string;
    };

export type SMSLeafProviderId = SMSSpec["provider"];

/** Provider ids selectable in per-workspace config. `inherit` = "use the next
 *  level down" (the instance `_global` row, then the deployment env). */
export const SMS_PROVIDER_IDS = [
  "inherit",
  "console",
  "twilio",
  "sns",
  "netgsm",
  "iletimerkezi",
] as const;
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
    case "netgsm":
      return netgsmSms(spec);
    case "iletimerkezi":
      return iletimerkeziSms(spec);
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

const netgsmFromEnv = (env: Env): SMSSpec | undefined =>
  env.NETGSM_USERCODE && env.NETGSM_PASSWORD && env.NETGSM_MSGHEADER
    ? {
        provider: "netgsm",
        usercode: env.NETGSM_USERCODE,
        password: env.NETGSM_PASSWORD,
        msgheader: env.NETGSM_MSGHEADER,
      }
    : undefined;

const iletimerkeziFromEnv = (env: Env): SMSSpec | undefined =>
  env.ILETIMERKEZI_KEY && env.ILETIMERKEZI_HASH && env.ILETIMERKEZI_SENDER
    ? {
        provider: "iletimerkezi",
        key: env.ILETIMERKEZI_KEY,
        hash: env.ILETIMERKEZI_HASH,
        sender: env.ILETIMERKEZI_SENDER,
      }
    : undefined;

/** Env readers keyed by the `SMS_PROVIDER` value that forces them. Also defines
 *  the auto-detect precedence when `SMS_PROVIDER` is unset. */
const ENV_READERS: [Exclude<SMSLeafProviderId, "console">, (env: Env) => SMSSpec | undefined][] = [
  ["twilio", twilioFromEnv],
  ["sns", snsFromEnv],
  ["netgsm", netgsmFromEnv],
  ["iletimerkezi", iletimerkeziFromEnv],
];

/**
 * Resolve the deployment-level SMS spec from `Env`. `SMS_PROVIDER` forces one
 * transport; when unset we pick the first provider with complete credentials
 * (twilio → sns → netgsm → iletimerkezi) and fall back to `console` when none is
 * configured. The result is the spec that would actually run, so `context.ts` can
 * detect the "nothing real configured" case (`console`) and swap in the
 * managed-cloud adapter.
 */
export const selectSmsSpec = (env: Env): SMSSpec => {
  const explicit = env.SMS_PROVIDER?.trim().toLowerCase();
  if (explicit === "console") return { provider: "console" };
  if (explicit) {
    const reader = ENV_READERS.find(([id]) => id === explicit)?.[1];
    if (reader) {
      const spec = reader(env);
      if (spec) return spec;
      console.warn(
        `[sms] SMS_PROVIDER=${explicit} but its credentials are incomplete — using console`,
      );
      return { provider: "console" };
    }
    console.warn(`[sms] unknown SMS_PROVIDER=${explicit} — falling back to auto-detect`);
  }
  for (const [, reader] of ENV_READERS) {
    const spec = reader(env);
    if (spec) return spec;
  }
  return { provider: "console" };
};

/** Resolve the deployment-level SMS adapter from `Env`. */
export const selectSmsAdapter = (env: Env): SMSAdapter => buildSmsAdapter(selectSmsSpec(env));
