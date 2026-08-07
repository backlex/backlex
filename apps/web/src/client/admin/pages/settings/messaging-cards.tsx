// Settings cards: email / push / SMS provider configuration.
// Split out of the former 1686-line pages/settings.tsx god-file.
// Settings page — general/appearance/email/bindings/env/about tabs
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, } from "../../icons";
import { Badge, Button, IconButton, } from "../../ui";
import { Select } from "../../select";
import {
  deviceTokensApi,
  emailConfigApi,
  pushConfigApi,
  smsConfigApi,
  type ApiDeviceToken,
} from "../../api";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";


const EMAIL_PROVIDER_OPTIONS = [
  { value: "inherit", label: "Inherit — deployment default" },
  { value: "console", label: "Console (log to stdout)" },
  { value: "resend", label: "Resend" },
  { value: "sendgrid", label: "SendGrid" },
  { value: "mailgun", label: "Mailgun" },
  { value: "ses", label: "Amazon SES" },
  { value: "smtp", label: "SMTP" },
];

// [key, label, placeholder, type] for config fields; [key, label] for secrets.
const EMAIL_PROVIDER_FIELDS: Record<string, { hint: string; config: [string, string, string, string][]; secrets: [string, string][] }> = {
  inherit: { hint: "Falls through to the instance-wide override, then EMAIL_PROVIDER / *_API_KEY / EMAIL_FROM on the Worker.", config: [], secrets: [] },
  console: { hint: "Doesn't send anything — writes the message to the Worker log. Dev only.", config: [], secrets: [] },
  resend: { hint: "HTTP API — works on every runtime, including Cloudflare Workers.", config: [], secrets: [["apiKey", "API key"]] },
  sendgrid: { hint: "HTTP API — works on every runtime, including Cloudflare Workers.", config: [], secrets: [["apiKey", "API key"]] },
  mailgun: { hint: "HTTP API — works on every runtime, including Cloudflare Workers.", config: [["domain", "Sending domain", "mg.example.com", "text"], ["host", "API host (optional)", "api.mailgun.net / api.eu.mailgun.net", "text"]], secrets: [["apiKey", "API key"]] },
  ses: { hint: "SigV4-signed — works on every runtime. The from address/domain must be verified in SES.", config: [["region", "Region", "us-east-1", "text"], ["accessKeyId", "Access key ID", "AKIA…", "text"]], secrets: [["secretAccessKey", "Secret access key"]] },
  smtp: { hint: "nodemailer — NOT supported on Cloudflare Workers (no raw TCP). Use an HTTP-API provider there.", config: [["host", "Host", "smtp.example.com", "text"], ["port", "Port", "587", "number"], ["user", "Username", "", "text"], ["secure", "Implicit TLS (port 465)", "", "checkbox"]], secrets: [["pass", "Password"]] },
};

export function EmailSettingsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [cfg, setCfg] = useState<any>(null);
  const [provider, setProvider] = useState("inherit");
  const [from, setFrom] = useState("");
  const [config, setConfig] = useState<Record<string, any>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const r = await emailConfigApi.get();
      const d = r.data as any;
      setCfg(d);
      setProvider(d.provider || "inherit");
      setFrom(d.fromAddress ?? "");
      setConfig({ ...(d.config || {}) });
      setSecrets({});
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  useEffect(() => { void load(); }, []);

  const fields = EMAIL_PROVIDER_FIELDS[provider] ?? EMAIL_PROVIDER_FIELDS.inherit!;
  const mark = () => setDirty(true);

  const save = async () => {
    setSaving(true);
    try {
      const cfgOut: Record<string, any> = {};
      for (const [key, , , type] of fields.config) {
        const v = config[key];
        if (type === "number") cfgOut[key] = v === "" || v == null ? undefined : Number(v);
        else if (type === "checkbox") cfgOut[key] = !!v;
        else cfgOut[key] = v == null ? "" : String(v);
      }
      await emailConfigApi.put({ provider, fromAddress: from || null, config: cfgOut, secrets });
      pushToast(t`Email settings saved.`);
      await load();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await emailConfigApi.sendTest();
      pushToast(t`Test email sent to ${r.to}.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const envHint =
    cfg && (cfg.env?.provider || cfg.env?.from)
      ? ` · deployment env: ${cfg.env.provider ?? "(auto)"}${cfg.env.from ? ` from ${cfg.env.from}` : ""}`
      : "";

  return (
    <Card className="max-w-[920px] gap-4 p-[22px]">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>Email transport for <b>this workspace</b>. Resolution order: this config → the instance-wide
          default → the deployment's <span className="font-mono">EMAIL_PROVIDER</span> / env keys. Secret
          values are encrypted at rest and never shown again.</Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Provider</Trans></label>
        <Select value={provider} onChange={(v: string) => { setProvider(v); mark(); }} options={EMAIL_PROVIDER_OPTIONS} />
        <span className="text-[11.5px] text-muted-foreground">{fields.hint}{envHint}</span>
      </div>
      {provider !== "inherit" && provider !== "console" && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>From address</Trans></label>
          <Input placeholder="hello@yourdomain.com" value={from} onChange={(e) => { setFrom(e.target.value); mark(); }} />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Required for every provider — must be a verified sender/domain for the chosen transport.</Trans></span>
        </div>
      )}
      {fields.config.map(([key, label, placeholder, type]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          {type === "checkbox" ? (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={!!config[key]} onChange={(e) => { setConfig((c) => ({ ...c, [key]: e.target.checked })); mark(); }} />
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</span>
            </label>
          ) : (
            <>
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
              <Input type={type === "number" ? "number" : "text"} placeholder={placeholder} value={config[key] ?? ""} onChange={(e) => { setConfig((c) => ({ ...c, [key]: e.target.value })); mark(); }} />
            </>
          )}
        </div>
      ))}
      {fields.secrets.map(([key, label]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={cfg?.secretsSet?.[key] ? t`•••••••• (stored — leave blank to keep)` : ""}
            value={secrets[key] ?? ""}
            onChange={(e) => { setSecrets((s) => ({ ...s, [key]: e.target.value })); mark(); }}
          />
          {cfg?.secretsSet?.[key] && <span className="text-[11.5px] text-muted-foreground"><Trans>A value is stored. Type a new one to replace it, or leave blank to keep it.</Trans></span>}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <Button variant="outline" size="sm" disabled={testing} onClick={() => void sendTest()}>{testing ? <Trans>Sending…</Trans> : <Trans>Send test email</Trans>}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => void load()}><Trans>Discard</Trans></Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}</Button>
        </div>
      </div>
    </Card>
  );
}

const PUSH_PROVIDER_OPTIONS = [
  { value: "inherit", label: "Inherit — deployment default" },
  { value: "console", label: "Console (log to stdout)" },
  { value: "fcm", label: "Firebase Cloud Messaging (Android / cross-platform)" },
  { value: "apns", label: "Apple Push (iOS native)" },
  { value: "web-push", label: "Web Push (browsers, VAPID)" },
];

const PUSH_PROVIDER_FIELDS: Record<
  string,
  {
    hint: string;
    config: [string, string, string, string][];
    secrets: [string, string][];
    link?: { href: string; label: string };
  }
> = {
  inherit: { hint: "Falls through to the instance default, then the deployment's PUSH_* env vars (self-host only). On managed cloud there's no platform fallback — pick a provider and enter your workspace's own keys.", config: [], secrets: [] },
  console: { hint: "Doesn't deliver anything — writes the notification to the Worker log. Dev only.", config: [], secrets: [] },
  fcm: { hint: "HTTP v1 API — works on every runtime. From your Firebase service-account JSON (Project settings → Service accounts → Generate new private key).", config: [["projectId", "Project ID", "my-app", "text"], ["clientEmail", "Client email", "firebase-adminsdk@my-app.iam.gserviceaccount.com", "text"]], secrets: [["privateKey", "Service-account private key (PEM)"]], link: { href: "https://console.firebase.google.com/", label: "Firebase Console →" } },
  apns: { hint: "Token-based (.p8). Direct APNs needs an HTTP/2 runtime (Cloudflare Workers); on Node/Bun route iOS through FCM. Create the key under Certificates, Identifiers & Profiles → Keys.", config: [["keyId", "Key ID", "ABC123DEFG", "text"], ["teamId", "Team ID", "DEF456GHIJ", "text"], ["bundleId", "Bundle ID", "com.example.app", "text"], ["production", "Production gateway (uncheck for sandbox)", "", "checkbox"]], secrets: [["privateKey", "APNs auth key (.p8 PEM)"]], link: { href: "https://developer.apple.com/account/resources/authkeys/list", label: "Apple Developer — Keys →" } },
  "web-push": { hint: "VAPID + aes128gcm — works on every runtime including Cloudflare Workers. Use “Generate keypair” below, or paste your own (raw base64url, e.g. from `npx web-push generate-vapid-keys`).", config: [["subject", "Subject (mailto: or origin URL)", "mailto:admin@example.com", "text"], ["vapidPublicKey", "VAPID public key (base64url)", "", "text"]], secrets: [["vapidPrivateKey", "VAPID private key (base64url)"]] },
};

/** Generate a VAPID keypair in the browser (Web Crypto), in the exact raw
 *  base64url format the server expects: public = raw P-256 point, private =
 *  the JWK `d` scalar. No CLI / external account needed. */
const generateVapidKeypair = async (): Promise<{ publicKey: string; privateKey: string }> => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as { d?: string };
  const b64url = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { publicKey: b64url(pubRaw), privateKey: jwk.d ?? "" };
};

/** Push transport config — mirrors {@link EmailSettingsCard}, minus the From
 *  address, plus a viewer of the admin's own registered devices so "Send test"
 *  has somewhere to land. */
export function PushSettingsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [cfg, setCfg] = useState<any>(null);
  const [provider, setProvider] = useState("inherit");
  const [config, setConfig] = useState<Record<string, any>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [devices, setDevices] = useState<ApiDeviceToken[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const r = await pushConfigApi.get();
      const d = r.data as any;
      setCfg(d);
      setProvider(d.provider || "inherit");
      setConfig({ ...(d.config || {}) });
      setSecrets({});
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const loadDevices = async () => {
    try {
      const r = await deviceTokensApi.list();
      setDevices(r.data);
    } catch {
      /* device list is best-effort context */
    }
  };
  useEffect(() => {
    void load();
    void loadDevices();
  }, []);

  const fields = PUSH_PROVIDER_FIELDS[provider] ?? PUSH_PROVIDER_FIELDS.inherit!;
  const mark = () => setDirty(true);

  const save = async () => {
    setSaving(true);
    try {
      const cfgOut: Record<string, any> = {};
      for (const [key, , , type] of fields.config) {
        const v = config[key];
        if (type === "number") cfgOut[key] = v === "" || v == null ? undefined : Number(v);
        else if (type === "checkbox") cfgOut[key] = !!v;
        else cfgOut[key] = v == null ? "" : String(v);
      }
      await pushConfigApi.put({ provider, config: cfgOut, secrets });
      pushToast(t`Push settings saved.`);
      await load();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await pushConfigApi.sendTest();
      pushToast(t`Test push sent to ${r.sent} device(s).`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const envHint = cfg?.env?.provider ? ` · deployment env: ${cfg.env.provider}` : "";
  const activeDevices = devices.filter((d) => d.isActive);

  return (
    <Card className="max-w-[920px] gap-4 p-[22px]">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>Native push transport for <b>this workspace</b>. Resolution order: this config → the
          instance-wide default → the deployment's <span className="font-mono">PUSH_*</span> env vars.
          Secret values are encrypted at rest and never shown again. In-app notifications can fan out to
          devices via the <span className="font-mono">push</span> flag.</Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Provider</Trans></label>
        <Select value={provider} onChange={(v: string) => { setProvider(v); mark(); }} options={PUSH_PROVIDER_OPTIONS} />
        <span className="text-[11.5px] text-muted-foreground">
          {fields.hint}{envHint}
          {fields.link && (
            <> <a href={fields.link.href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{fields.link.label}</a></>
          )}
        </span>
      </div>
      {fields.config.map(([key, label, placeholder, type]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          {type === "checkbox" ? (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={config[key] !== false} onChange={(e) => { setConfig((c) => ({ ...c, [key]: e.target.checked })); mark(); }} />
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</span>
            </label>
          ) : (
            <>
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
              <Input type="text" placeholder={placeholder} value={config[key] ?? ""} onChange={(e) => { setConfig((c) => ({ ...c, [key]: e.target.value })); mark(); }} />
            </>
          )}
        </div>
      ))}
      {fields.secrets.map(([key, label]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
          <Textarea
            rows={3}
            autoComplete="off"
            className="font-mono text-[11px]"
            placeholder={cfg?.secretsSet?.[key] ? t`•••••••• (stored — leave blank to keep)` : ""}
            value={secrets[key] ?? ""}
            onChange={(e) => { setSecrets((s) => ({ ...s, [key]: e.target.value })); mark(); }}
          />
          {cfg?.secretsSet?.[key] && <span className="text-[11.5px] text-muted-foreground"><Trans>A value is stored. Type a new one to replace it, or leave blank to keep it.</Trans></span>}
        </div>
      ))}
      {provider === "web-push" && (
        <div className="flex flex-col items-start gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { publicKey, privateKey } = await generateVapidKeypair();
              setConfig((c) => ({ ...c, vapidPublicKey: publicKey }));
              setSecrets((s) => ({ ...s, vapidPrivateKey: privateKey }));
              mark();
              pushToast(t`VAPID keypair generated — review and Save to store it.`);
            }}
          >
            <Trans>Generate keypair</Trans>
          </Button>
          <span className="text-[11.5px] text-muted-foreground"><Trans>Fills the public key + private key fields above with a fresh VAPID pair. Click Save to store it.</Trans></span>
        </div>
      )}
      <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
        <span className="text-[12.5px] font-medium text-foreground"><Trans>Your registered devices</Trans></span>
        {activeDevices.length === 0 ? (
          <span className="text-[11.5px] text-muted-foreground"><Trans>No active devices for your account. Register one from a client app to receive a test push.</Trans></span>
        ) : (
          <div className="flex flex-col gap-1">
            {activeDevices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="flex items-center gap-2"><Badge>{d.platform}</Badge><span className="text-muted-foreground">{d.deviceName || d.token.slice(0, 24)}…</span></span>
                <IconButton icon={I.Trash} title={t`Remove device`} onClick={async () => { try { await deviceTokensApi.remove(d.id); await loadDevices(); } catch (e) { pushToast((e as Error).message); } }} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <Button variant="outline" size="sm" disabled={testing} onClick={() => void sendTest()}>{testing ? <Trans>Sending…</Trans> : <Trans>Send test push</Trans>}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => void load()}><Trans>Discard</Trans></Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}</Button>
        </div>
      </div>
    </Card>
  );
}

// Exported for `tests/client/sms-settings-card.test.tsx`, which cross-checks these
// tables against the server registry (SMS_PROVIDER_IDS / SMS_SECRET_KEYS) — a
// provider added on the server but missing here is silently unconfigurable.
export const SMS_PROVIDER_OPTIONS = [
  { value: "inherit", label: "Inherit — deployment default" },
  { value: "console", label: "Console (log to stdout)" },
  { value: "twilio", label: "Twilio (Programmable Messaging)" },
  { value: "sns", label: "Amazon SNS (AWS SMS)" },
  { value: "netgsm", label: "NetGSM (Türkiye)" },
  { value: "iletimerkezi", label: "İleti Merkezi (Türkiye)" },
];

export const SMS_PROVIDER_FIELDS: Record<
  string,
  {
    hint: string;
    config: [string, string, string, string][];
    secrets: [string, string][];
    link?: { href: string; label: string };
  }
> = {
  inherit: { hint: "Falls through to the instance default, then the deployment's SMS_* / TWILIO_* env vars (self-host only). On managed cloud there's no platform fallback — pick a provider and enter your workspace's own keys.", config: [], secrets: [] },
  console: { hint: "Doesn't deliver anything — writes the message to the Worker log. Dev only.", config: [], secrets: [] },
  twilio: { hint: "Programmable Messaging REST API — works on every runtime. Use a From number (E.164) OR a Messaging Service SID. Credentials from the Twilio Console.", config: [["accountSid", "Account SID", "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "text"], ["from", "From number (E.164) or sender id", "+14155552671", "text"], ["messagingServiceSid", "Messaging Service SID (optional, MGxxxx)", "", "text"]], secrets: [["authToken", "Auth Token"]], link: { href: "https://console.twilio.com/", label: "Twilio Console →" } },
  sns: { hint: "Amazon SNS SMS — signed with AWS SigV4, works on every runtime. The IAM principal needs sns:Publish. Sender ID is only honoured in supported countries.", config: [["region", "AWS region", "us-east-1", "text"], ["accessKeyId", "Access key ID", "AKIA…", "text"], ["senderId", "Sender ID (optional)", "MYAPP", "text"]], secrets: [["secretAccessKey", "Secret access key"]], link: { href: "https://console.aws.amazon.com/sns/", label: "AWS SNS Console →" } },
  netgsm: { hint: "NetGSM (Türkiye) — the classic HTTP API. User code + password are your panel credentials; the message header (başlık) must already be approved by NetGSM. Recipients are sent as E.164; the leading + is stripped for you.", config: [["usercode", "User code (kullanıcı kodu)", "8501234567", "text"], ["msgheader", "Message header (başlık)", "MYCOMPANY", "text"]], secrets: [["password", "Panel password"]], link: { href: "https://www.netgsm.com.tr/", label: "NetGSM panel →" } },
  iletimerkezi: { hint: "İleti Merkezi (Türkiye) — the v1 JSON API. Key + hash come from the panel's API credentials page; the sender title must already be approved. Recipients are sent as E.164; the leading + is stripped for you.", config: [["key", "API key", "", "text"], ["sender", "Sender title (gönderici adı)", "MYCOMPANY", "text"]], secrets: [["hash", "API hash"]], link: { href: "https://www.iletimerkezi.com/", label: "İleti Merkezi panel →" } },
};

/** SMS transport config — mirrors {@link PushSettingsCard}, minus the device
 *  viewer (SMS targets phone numbers); "Send test" takes an optional E.164 number
 *  so an admin without a registered number can still verify delivery. */
export function SmsSettingsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [cfg, setCfg] = useState<any>(null);
  const [provider, setProvider] = useState("inherit");
  const [config, setConfig] = useState<Record<string, any>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const r = await smsConfigApi.get();
      const d = r.data as any;
      setCfg(d);
      setProvider(d.provider || "inherit");
      setConfig({ ...(d.config || {}) });
      setSecrets({});
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const fields = SMS_PROVIDER_FIELDS[provider] ?? SMS_PROVIDER_FIELDS.inherit!;
  const mark = () => setDirty(true);

  const save = async () => {
    setSaving(true);
    try {
      const cfgOut: Record<string, any> = {};
      for (const [key, , , type] of fields.config) {
        const v = config[key];
        if (type === "number") cfgOut[key] = v === "" || v == null ? undefined : Number(v);
        else if (type === "checkbox") cfgOut[key] = !!v;
        else cfgOut[key] = v == null ? "" : String(v);
      }
      await smsConfigApi.put({ provider, config: cfgOut, secrets });
      pushToast(t`SMS settings saved.`);
      await load();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await smsConfigApi.sendTest(testTo.trim() || undefined);
      pushToast(t`Test SMS sent to ${r.sent} number(s).`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const envHint = cfg?.env?.provider ? ` · deployment env: ${cfg.env.provider}` : "";

  return (
    <Card className="max-w-[920px] gap-4 p-[22px]">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>SMS transport for <b>this workspace</b>. Resolution order: this config → the
          instance-wide default → the deployment's <span className="font-mono">SMS_*</span> env vars.
          Secret values are encrypted at rest and never shown again. Send to a user via
          the <span className="font-mono">messaging.send_sms</span> tool / API once they register a
          phone number.</Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Provider</Trans></label>
        {/* Switching provider swaps the credential fields below, so drop any
            half-typed secret for the old provider rather than PUT-ing it under
            the new one's row. */}
        <Select value={provider} onChange={(v: string) => { setProvider(v); setSecrets({}); mark(); }} options={SMS_PROVIDER_OPTIONS} />
        <span className="text-[11.5px] text-muted-foreground">
          {fields.hint}{envHint}
          {fields.link && (
            <> <a href={fields.link.href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{fields.link.label}</a></>
          )}
        </span>
      </div>
      {fields.config.map(([key, label, placeholder]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
          <Input type="text" placeholder={placeholder} value={config[key] ?? ""} onChange={(e) => { setConfig((c) => ({ ...c, [key]: e.target.value })); mark(); }} />
        </div>
      ))}
      {fields.secrets.map(([key, label]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
          <Textarea
            rows={2}
            autoComplete="off"
            className="font-mono text-[11px]"
            placeholder={cfg?.secretsSet?.[key] ? t`•••••••• (stored — leave blank to keep)` : ""}
            value={secrets[key] ?? ""}
            onChange={(e) => { setSecrets((s) => ({ ...s, [key]: e.target.value })); mark(); }}
          />
          {cfg?.secretsSet?.[key] && <span className="text-[11.5px] text-muted-foreground"><Trans>A value is stored. Type a new one to replace it, or leave blank to keep it.</Trans></span>}
        </div>
      ))}
      <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Test recipient (E.164)</Trans></label>
        <Input type="text" placeholder="+14155552671" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Where “Send test SMS” delivers. Leave blank to use your account's registered numbers.</Trans></span>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <Button variant="outline" size="sm" disabled={testing} onClick={() => void sendTest()}>{testing ? <Trans>Sending…</Trans> : <Trans>Send test SMS</Trans>}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => void load()}><Trans>Discard</Trans></Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}</Button>
        </div>
      </div>
    </Card>
  );
}
