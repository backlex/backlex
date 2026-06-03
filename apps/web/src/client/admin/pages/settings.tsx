// Settings page — general/appearance/email/bindings/env/about tabs
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "../icons";
import { type AdapterId } from "../config";
import { Badge, Button, IconButton, PageHeader } from "../ui";
import { Select } from "../select";
import {
  emailConfigApi,
  settingsApi,
  workspaceConfigApi,
  type ApiRuntime,
} from "../api";
import { useTheme } from "@/components/theme-provider";
import { applyPrimaryColor } from "@/main";
import { refreshBranding } from "@/lib/branding";
import { ColorPicker } from "@backlex/ui/components/color-picker";
import { Input } from "@backlex/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Textarea } from "@backlex/ui/components/textarea";
import { SettingsSkeleton } from "../page-skeletons";
import {
  LOCALE_CODE_RE,
  languageOptions,
  localeLabel,
  timezoneOptions,
} from "../preferences";

/** Mirror of `services/workspace-config.ts::isValidColor` — keep in sync. */
const isValidColor = (v: string): boolean => {
  const s = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) {
    return s.length === 4 || s.length === 5 || s.length === 7 || s.length === 9;
  }
  return /^(rgb|hsl|oklch|oklab)a?\(\s*[\d\s%.,/-]+\s*\)$/i.test(s);
};

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

function EmailSettingsCard({ pushToast }: { pushToast: (m: string) => void }) {
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
    <div className="flex max-w-[920px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
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
    </div>
  );
}

const PRIMARY_PRESETS: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  { label: "Emerald", value: "oklch(0.78 0.21 155)" },
  { label: "Teal", value: "oklch(0.78 0.14 185)" },
  { label: "Cyan", value: "oklch(0.78 0.16 210)" },
  { label: "Blue", value: "oklch(0.7 0.2 255)" },
  { label: "Indigo", value: "oklch(0.65 0.22 280)" },
  { label: "Violet", value: "oklch(0.68 0.24 305)" },
  { label: "Pink", value: "oklch(0.75 0.23 350)" },
  { label: "Rose", value: "oklch(0.7 0.24 15)" },
  { label: "Orange", value: "oklch(0.78 0.2 50)" },
  { label: "Amber", value: "oklch(0.85 0.18 85)" },
  { label: "Slate", value: "oklch(0.55 0.04 250)" },
];

/**
 * Per-workspace branding form. Reads its workspace's own row (no `_global`
 * fallback) so the admin edits *this* workspace's overrides explicitly. Logo
 * and favicon upload via the existing storage route with fixed logical keys
 * (`branding/logo` / `branding/favicon`) — re-uploading replaces.
 */
function AppearanceSettingsCard({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const { theme: userTheme, setTheme: setUserTheme } = useTheme();
  const [workspaceName, setWorkspaceName] = useState("");
  const [description, setDescription] = useState("");
  const [logoFileKey, setLogoFileKey] = useState<string | null>(null);
  const [faviconFileKey, setFaviconFileKey] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState("");
  const [defaultTheme, setDefaultTheme] = useState<"" | "light" | "dark" | "system">("");
  // Per-asset nonce appended to the preview URL so a re-upload to the same
  // logical key busts the browser cache.
  const [logoBust, setLogoBust] = useState<string>("");
  const [faviconBust, setFaviconBust] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const faviconInputRef = useRef<HTMLInputElement | null>(null);

  const primaryColorOk = primaryColor.trim() === "" || isValidColor(primaryColor);

  // Single mutation point for the primary color: keeps state, dirty flag, and
  // live `--primary` preview in sync so every input (preset, picker, text,
  // reset) updates the swatch cascade instantly.
  const commitPrimary = useCallback((next: string) => {
    setPrimaryColor(next);
    setDirty(true);
    const trimmed = next.trim();
    applyPrimaryColor(trimmed && isValidColor(trimmed) ? trimmed : null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await workspaceConfigApi.getRaw();
      const d = r.data;
      setWorkspaceName(d.workspaceName ?? "");
      setDescription(d.description ?? "");
      setLogoFileKey(d.logoFileKey ?? null);
      setFaviconFileKey(d.faviconFileKey ?? null);
      setPrimaryColor(d.primaryColor ?? "");
      // Revert any in-flight live preview (e.g. on Discard) to the server's
      // saved value so the form and the `--primary` token stay aligned.
      applyPrimaryColor(d.primaryColor ?? null);
      setDefaultTheme(
        d.defaultTheme === "light" || d.defaultTheme === "dark" || d.defaultTheme === "system"
          ? d.defaultTheme
          : "",
      );
      const v = String(d.updatedAt ?? Date.now());
      setLogoBust(v);
      setFaviconBust(v);
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => { void load(); }, [load]);

  const uploadFile = async (kind: "logo" | "favicon", file: File): Promise<string> => {
    const key = `branding/${kind}`;
    const res = await fetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Upload failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    return key;
  };

  const onPickLogo = async (file: File | null) => {
    if (!file) return;
    setUploadingLogo(true);
    try {
      const key = await uploadFile("logo", file);
      setLogoFileKey(key);
      setLogoBust(String(Date.now()));
      setDirty(true);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setUploadingLogo(false);
    }
  };

  const onPickFavicon = async (file: File | null) => {
    if (!file) return;
    setUploadingFavicon(true);
    try {
      const key = await uploadFile("favicon", file);
      setFaviconFileKey(key);
      setFaviconBust(String(Date.now()));
      setDirty(true);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setUploadingFavicon(false);
    }
  };

  const save = async () => {
    if (!primaryColorOk) {
      pushToast(t`Primary color must be a hex (#rrggbb) or a CSS color function.`);
      return;
    }
    setSaving(true);
    try {
      const nextPrimary = primaryColor.trim() || null;
      await workspaceConfigApi.put({
        workspaceName: workspaceName.trim() || null,
        description: description.trim() || null,
        logoFileKey,
        faviconFileKey,
        primaryColor: nextPrimary,
        defaultTheme: defaultTheme || null,
      });
      applyPrimaryColor(nextPrimary);
      setDirty(false);
      // Re-pull the resolved branding so the sidebar (and login) brand area
      // pick up the new logo / workspace name without a page reload.
      void refreshBranding();
      pushToast(t`Branding saved.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const previewUrl = (key: string | null, bust: string): string | null =>
    key ? `/api/storage/${encodeURIComponent(key)}${bust ? `?v=${bust}` : ""}` : null;

  const logoSrc = previewUrl(logoFileKey, logoBust);
  const faviconSrc = previewUrl(faviconFileKey, faviconBust);

  return (
    <div className="flex max-w-[920px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Workspace name</Trans></label>
        <Input
          value={workspaceName}
          disabled={loading}
          onChange={(e) => { setWorkspaceName(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Shown in the sidebar and the browser title.</Trans></span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Description</Trans></label>
        <Textarea
          rows={3}
          value={description}
          disabled={loading}
          onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Short tagline for the workspace.</Trans></span>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Logo</Trans></div>
          <div className="text-[11.5px] text-muted-foreground"><Trans>PNG, JPG, SVG or WebP — square images display best. Replaces any previous upload.</Trans></div>
        </div>
        <div className="flex items-center gap-3">
          {logoSrc && (
            <img
              src={logoSrc}
              alt={t`workspace logo`}
              className="size-14 rounded-[6px] bg-muted object-contain p-1"
            />
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              void onPickLogo(f);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploadingLogo || loading}
            onClick={() => logoInputRef.current?.click()}
          >
            {uploadingLogo ? <Trans>Uploading…</Trans> : logoFileKey ? <Trans>Replace</Trans> : <Trans>Upload</Trans>}
          </Button>
          {logoFileKey && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploadingLogo || loading}
              onClick={() => { setLogoFileKey(null); setDirty(true); }}
            >
              <Trans>Remove</Trans>
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Favicon</Trans></div>
          <div className="text-[11.5px] text-muted-foreground"><Trans>PNG or ICO recommended (≤ 64 KB).</Trans></div>
        </div>
        <div className="flex items-center gap-3">
          {faviconSrc && (
            <img
              src={faviconSrc}
              alt={t`workspace favicon`}
              className="size-8 rounded-[6px] bg-muted object-contain p-0.5"
            />
          )}
          <input
            ref={faviconInputRef}
            type="file"
            accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              void onPickFavicon(f);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploadingFavicon || loading}
            onClick={() => faviconInputRef.current?.click()}
          >
            {uploadingFavicon ? <Trans>Uploading…</Trans> : faviconFileKey ? <Trans>Replace</Trans> : <Trans>Upload</Trans>}
          </Button>
          {faviconFileKey && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploadingFavicon || loading}
              onClick={() => { setFaviconFileKey(null); setDirty(true); }}
            >
              <Trans>Remove</Trans>
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Primary color</Trans></label>
        <div className="mb-2.5 flex flex-wrap gap-2">
          {PRIMARY_PRESETS.map((p) => {
            const active = primaryColor.trim() === p.value;
            return (
              <button
                key={p.value}
                type="button"
                title={p.label}
                aria-label={t`Use ${p.label} palette`}
                aria-pressed={active}
                disabled={loading}
                onClick={() => commitPrimary(p.value)}
                className={`size-7 rounded-full border border-border p-0 ${loading ? "cursor-default" : "cursor-pointer"} ${active ? "shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--foreground)]" : ""}`}
                style={{ background: p.value || "var(--primary)" }}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-2.5">
          <ColorPicker
            value={primaryColorOk && primaryColor.trim() ? primaryColor : ""}
            disabled={loading}
            onChange={(hex) => commitPrimary(hex)}
          />
          <Input
            value={primaryColor}
            placeholder="#3b82f6 or oklch(0.84 0.23 128.85)"
            disabled={loading}
            onChange={(e) => commitPrimary(e.target.value)}
            className="flex-1 font-mono"
          />
          {primaryColor && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => commitPrimary("")}
            >
              <Trans>Reset</Trans>
            </Button>
          )}
        </div>
        <span className="text-[11.5px] text-muted-foreground">
          {primaryColorOk
            ? <Trans>Overrides the `--primary` token used across the admin and any published surfaces.</Trans>
            : <Trans>Use a hex value (#rrggbb), or a CSS color function: rgb(), hsl(), oklch(), oklab().</Trans>}
        </span>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Workspace default theme</Trans></div>
          <div className="text-[11.5px] text-muted-foreground"><Trans>Applied to users with no local override yet.</Trans></div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["", "light", "dark", "system"] as const).map((opt) => (
            <Button
              key={opt || "user"}
              variant={defaultTheme === opt ? "primary" : "outline"}
              size="sm"
              disabled={loading}
              onClick={() => { setDefaultTheme(opt); setDirty(true); }}
            >
              {opt === "" ? <Trans>Leave to user</Trans> : opt === "light" ? <Trans>Light</Trans> : opt === "dark" ? <Trans>Dark</Trans> : <Trans>System</Trans>}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>My theme</Trans></div>
          <div className="text-[11.5px] text-muted-foreground"><Trans>Your own preference — stored locally, not synced.</Trans></div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["light", "dark", "system"] as const).map((opt) => (
            <Button
              key={opt}
              variant={userTheme === opt ? "primary" : "outline"}
              size="sm"
              onClick={() => setUserTheme(opt)}
            >
              {opt === "light" ? <Trans>Light</Trans> : opt === "dark" ? <Trans>Dark</Trans> : <Trans>System</Trans>}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1.5">
        <Button variant="ghost" size="sm" disabled={!dirty || saving || loading} onClick={() => void load()}><Trans>Discard</Trans></Button>
        <Button variant="primary" size="sm" disabled={!dirty || saving || loading} onClick={() => void save()}>
          {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </div>
  );
}

/**
 * Editable copy for the public sign-in screen's brand panel. These are
 * instance-global — the sign-in page is reached before any workspace is
 * selected — so they persist on the `tenant_id IS NULL` `app_settings` row.
 * Both fields are optional; left blank, the sign-in screen falls back to its
 * built-in default copy. Surfaced to the (unauthenticated) sign-in page
 * through `/api/auth/providers`.
 */
function SignInBrandingCard({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [headline, setHeadline] = useState("");
  const [tagline, setTagline] = useState("");
  const [termsUrl, setTermsUrl] = useState("");
  const [privacyUrl, setPrivacyUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await settingsApi.load();
      const d = r.data as Record<string, unknown>;
      setHeadline(typeof d.signInHeadline === "string" ? d.signInHeadline : "");
      setTagline(typeof d.signInTagline === "string" ? d.signInTagline : "");
      setTermsUrl(typeof d.termsUrl === "string" ? d.termsUrl : "");
      setPrivacyUrl(typeof d.privacyUrl === "string" ? d.privacyUrl : "");
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await settingsApi.patch({
        signInHeadline: headline.trim(),
        signInTagline: tagline.trim(),
        termsUrl: termsUrl.trim(),
        privacyUrl: privacyUrl.trim(),
      });
      setDirty(false);
      pushToast(t`Sign-in screen saved.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-[920px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>Headline, tagline, and the Terms/Privacy links shown on the public
          sign-in and sign-up screens. This applies instance-wide — the sign-in page is
          reached before any workspace is selected. Leave a field blank to use the
          built-in default (or, for the URLs, to show plain text with no link).</Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Headline</Trans></label>
        <Input
          value={headline}
          disabled={loading}
          maxLength={120}
          placeholder={t`Sign in to backlex.`}
          onChange={(e) => { setHeadline(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Large title in the sign-in brand panel.</Trans></span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Tagline</Trans></label>
        <Textarea
          rows={3}
          value={tagline}
          disabled={loading}
          maxLength={280}
          onChange={(e) => { setTagline(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Short sentence shown under the headline.</Trans></span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Terms of Service URL</Trans></label>
        <Input
          type="url"
          value={termsUrl}
          disabled={loading}
          maxLength={2048}
          placeholder="https://example.com/terms"
          onChange={(e) => { setTermsUrl(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Linked from the sign-up consent line. Leave blank to show plain text with no link.</Trans></span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Privacy Policy URL</Trans></label>
        <Input
          type="url"
          value={privacyUrl}
          disabled={loading}
          maxLength={2048}
          placeholder="https://example.com/privacy"
          onChange={(e) => { setPrivacyUrl(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Linked from the sign-up consent line. Leave blank to show plain text with no link.</Trans></span>
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-2.5">
        <Button variant="ghost" size="sm" disabled={!dirty || saving || loading} onClick={() => void load()}><Trans>Discard</Trans></Button>
        <Button variant="primary" size="sm" className="min-w-[5.5rem]" disabled={!dirty || saving || loading} onClick={() => void save()}>
          {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </div>
  );
}

/**
 * Workspace language + time-zone settings. Manages the `i18nLocales` list
 * (the languages this workspace is translated into — the columns of the
 * Translations page and the locale options members may pick), the workspace
 * default language, and the default time zone. Persisted to `app_settings`
 * via the same `PATCH /api/admin/settings` whitelist as the General form.
 */
function WorkspaceLocaleCard({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [locales, setLocales] = useState<string[]>(["en"]);
  const [defaultLocale, setDefaultLocale] = useState("en");
  const [timezone, setTimezone] = useState("UTC");
  const [customCode, setCustomCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await settingsApi.load();
      const d = r.data as Record<string, unknown>;
      const list =
        Array.isArray(d.i18nLocales) && d.i18nLocales.length > 0
          ? (d.i18nLocales as string[])
          : ["en"];
      setLocales(list);
      setDefaultLocale(
        typeof d.i18nDefaultLocale === "string" &&
          list.includes(d.i18nDefaultLocale)
          ? d.i18nDefaultLocale
          : (list[0] ?? "en"),
      );
      setTimezone(typeof d.timezone === "string" ? d.timezone : "UTC");
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => { void load(); }, [load]);

  const addLocale = (code: string) => {
    const c = code.trim();
    if (!c) return;
    if (!LOCALE_CODE_RE.test(c)) {
      pushToast(t`"${c}" is not a valid language code.`);
      return;
    }
    if (locales.some((x) => x.toLowerCase() === c.toLowerCase())) {
      pushToast(t`${c} is already in the list.`);
      return;
    }
    setLocales((arr) => [...arr, c]);
    setDirty(true);
  };

  const removeLocale = (code: string) => {
    if (locales.length <= 1) {
      pushToast(t`At least one language is required.`);
      return;
    }
    const next = locales.filter((x) => x !== code);
    setLocales(next);
    // Reassigning the default keeps the server-side invariant satisfied
    // (i18nDefaultLocale must be a member of i18nLocales).
    if (defaultLocale === code) setDefaultLocale(next[0] ?? "en");
    setDirty(true);
  };

  const addOptions = useMemo(() => languageOptions(locales), [locales]);
  const tzOptions = useMemo(() => timezoneOptions(), []);

  const save = async () => {
    setSaving(true);
    try {
      await settingsApi.patch({
        i18nLocales: locales,
        i18nDefaultLocale: defaultLocale,
        timezone,
      });
      setDirty(false);
      pushToast(t`Workspace language settings saved.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-[920px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
      <div className="flex items-start gap-2.5">
        <I.Globe size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>
            Languages this workspace is translated into — they become the columns
            on the <b>Translations</b> page and the locale options members can
            pick in their account. The <b>default</b> applies to anyone who hasn't
            chosen one.
          </Trans>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Languages</Trans></label>
        <div className="flex flex-col gap-1.5">
          {locales.map((code) => {
            const isDefault = code === defaultLocale;
            return (
              <div
                key={code}
                className="flex items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2"
              >
                <span className="text-[13px]">{localeLabel(code)}</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">{code}</span>
                <div className="flex-1" />
                {isDefault ? (
                  <span
                    title={t`Default language`}
                    className="flex size-8 items-center justify-center text-primary"
                  >
                    <I.Star size={14} fill="currentColor" />
                  </span>
                ) : (
                  <IconButton
                    icon={I.Star}
                    title={t`Make default`}
                    disabled={loading}
                    onClick={() => { setDefaultLocale(code); setDirty(true); }}
                  />
                )}
                <IconButton
                  icon={I.Trash}
                  title={t`Remove`}
                  disabled={loading || locales.length <= 1}
                  onClick={() => removeLocale(code)}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Add a language</Trans></label>
        {/* Remount on every list change so the picker resets to its
            placeholder after each add — it's an action trigger, not a
            field that retains a value. */}
        <Select
          key={`add-lang-${locales.join("|")}`}
          value={undefined}
          placeholder={t`Pick a language…`}
          disabled={loading}
          onChange={(v: string) => addLocale(v)}
          options={addOptions}
        />
        <div className="flex items-center gap-2">
          <Input
            placeholder={t`…or a custom code (e.g. zh-Hant)`}
            value={customCode}
            disabled={loading}
            onChange={(e) => setCustomCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLocale(customCode);
                setCustomCode("");
              }
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !customCode.trim()}
            onClick={() => { addLocale(customCode); setCustomCode(""); }}
          >
            <Trans>Add</Trans>
          </Button>
        </div>
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>BCP-47 codes — a language plus an optional region/script (e.g.{" "}
          <span className="font-mono">pt-BR</span>,{" "}
          <span className="font-mono">zh-Hant</span>).</Trans>
        </span>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default time zone</Trans></label>
        <Select
          value={timezone}
          disabled={loading}
          onChange={(v: string) => { setTimezone(v); setDirty(true); }}
          options={tzOptions}
        />
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>Applied to members who haven't set a personal time zone in their account.</Trans>
        </span>
      </div>

      <div className="flex justify-end gap-2 border-t border-border pt-2.5">
        <Button variant="ghost" size="sm" disabled={!dirty || saving || loading} onClick={() => void load()}><Trans>Discard</Trans></Button>
        {/* Fixed min width so the Save ⇄ Saving… swap doesn't resize the
            button and shift the Discard button. */}
        <Button variant="primary" size="sm" className="min-w-[5.5rem]" disabled={!dirty || saving || loading} onClick={() => void save()}>
          {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </div>
  );
}

export function SettingsPage({ adapter, pushToast }: { adapter: AdapterId; pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [tab, setTab] = useState("general");
  const [appUrl, setAppUrl] = useState("http://localhost:8787");
  const [from, setFrom] = useState("hello@example.com");
  // First-load gate — drives the page skeleton until the General-tab settings
  // hydrate from the server.
  const [loaded, setLoaded] = useState(false);
  // Hydrate the General-tab form from /api/admin/settings on mount. APP_URL and
  // EMAIL_FROM come from env (read-only here). Public sign-up is governed by
  // Auth Settings (auth_config.policy.openSignup), not this page. The display
  // name lives in workspace_config and is edited from the Appearance tab.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.load();
        if (cancelled) return;
        const d = r.data as Record<string, unknown>;
        if (typeof d.appUrl === "string") setAppUrl(d.appUrl);
        if (typeof d.emailFrom === "string") setFrom(d.emailFrom);
      } catch {
        // keep seed
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [bindings, setBindings] = useState<{ id: number; type: string; name: string; target: string; status: string; warn: string | undefined }[]>([]);
  const [envVars, setEnvVars] = useState<{ id: number | string; key: string; value: string; secret: boolean; source: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.runtime();
        if (cancelled) return;
        const rt = r.data as ApiRuntime;
        setBindings(
          rt.bindings.map((b, i) => ({
            id: i + 1,
            type: b.type,
            name: b.name,
            target: b.target,
            status: b.status,
            warn: b.status === "optional" ? `${b.name} unbound` : undefined,
          })),
        );
        setEnvVars(
          rt.envVars.map((v, i) => ({
            id: i + 1,
            key: v.key,
            value: v.set ? (v.secret ? "••••••••" : "set") : "(unset)",
            secret: v.secret,
            source: v.source,
          })),
        );
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const bindingIcon = (t: string): IconComponent => (({ D1: I.Database, KV: I.Folder, R2: I.Server, DurableObj: I.Bolt, Vectorize: I.Bolt, Hyperdrive: I.Database, Dispatch: I.Bolt, Queue: I.Webhook, AI: I.Bolt } as Record<string, IconComponent>)[t] || I.Folder);

  // First whole-page fetch — General-tab settings haven't hydrated yet.
  if (!loaded) return <SettingsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title={t`Settings`} description={t`Self-hosted on Cloudflare Workers. Most config lives in wrangler.toml; this page is a live view + UI for runtime-mutable values.`} />
      <Tabs value={tab} onValueChange={(v) => setTab(v)}>
        <TabsList>
          {[
            { id: "general", label: t`General` },
            { id: "appearance", label: t`Appearance` },
            { id: "email", label: t`Email` },
            { id: "bindings", label: t`Bindings`, count: bindings.length },
            { id: "env", label: t`Environment`, count: envVars.length },
            { id: "about", label: t`About` },
          ].map((tabItem) => (
            <TabsTrigger key={tabItem.id} value={tabItem.id}>
              <span>{tabItem.label}</span>
              {tabItem.count !== undefined && <span className="rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground">{tabItem.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "general" && (
        <div className="flex flex-col gap-4">
        <div className="flex max-w-[920px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">APP_URL</div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Public origin of this Worker — set via <span className="font-mono">wrangler.toml [vars]</span> (or <span className="font-mono">.env</span> on self-host). Used for CORS, OAuth callbacks and absolute links. Read-only here.</Trans></div>
            </div>
            <span className="break-all text-right font-mono text-[12.5px] text-muted-foreground">{appUrl}</span>
          </div>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">EMAIL_FROM</div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Sender address for transactional email — set via <span className="font-mono">wrangler secret put</span> / <span className="font-mono">.env</span>. When unset (or RESEND_API_KEY is missing) email is logged to stdout. Read-only here.</Trans></div>
            </div>
            <span className="break-all text-right font-mono text-[12.5px] text-muted-foreground">{from || t`(not set)`}</span>
          </div>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Runtime</Trans></div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Auto-detected from <span className="font-mono">env</span> bindings.</Trans></div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-3xl border border-border bg-background py-0.5 pl-1.5 pr-2 text-[11px]"><span className="size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" />{adapter}</span>
          </div>
        </div>
        <WorkspaceLocaleCard pushToast={pushToast} />
        </div>
      )}

      {tab === "appearance" && (
        <div className="flex flex-col gap-4">
          <AppearanceSettingsCard pushToast={pushToast} />
          <SignInBrandingCard pushToast={pushToast} />
        </div>
      )}

      {tab === "email" && <EmailSettingsCard pushToast={pushToast} />}

      {tab === "bindings" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <div className="flex items-start gap-2.5 overflow-hidden rounded-2xl border border-border bg-muted p-3.5">
            <I.Info size={14} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium"><Trans>Bindings are read-only here</Trans></span>
              <span className="text-xs text-muted-foreground"><Trans>Edit them in <span className="font-mono text-foreground">wrangler.toml</span> and redeploy. This panel reflects the live binding map from <span className="font-mono text-foreground">env</span>.</Trans></span>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-3.5">
              <I.Server size={14} className="shrink-0" /><span className="whitespace-nowrap text-[13px] font-medium"><Trans>worker bindings</Trans></span>
              <span className="font-mono text-xs text-muted-foreground"><Trans>{bindings.filter((b) => b.status === "connected").length} connected · {bindings.filter((b) => b.status !== "connected").length} optional</Trans></span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast(t`Bindings refreshed.`)}><Trans>Refresh</Trans></Button>
            </div>
            <div className="hidden grid-cols-[24px_110px_160px_1fr_120px] items-center gap-3 border-b border-border bg-muted px-3.5 py-[11px] text-[11px] uppercase tracking-[0.4px] text-muted-foreground md:grid">
              <span></span><span><Trans>Type</Trans></span><span><Trans>Name</Trans></span><span><Trans>Resource</Trans></span><span><Trans>Status</Trans></span>
            </div>
            {bindings.map((b) => {
              const Ic = bindingIcon(b.type);
              return (
                <div key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_110px_160px_1fr_120px] md:gap-3 md:py-[11px]">
                  <span className="shrink-0"><Ic size={14} /></span>
                  <span className="font-mono text-[12.5px]">{b.type}</span>
                  <span className="order-last w-full break-all font-mono text-[13px] md:order-none md:w-auto md:break-normal">{b.name}</span>
                  <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 md:order-none md:w-auto md:flex-nowrap">
                    <span className="break-all font-mono text-xs text-muted-foreground">{b.target}</span>
                    {b.warn && <span className="text-[11.5px] text-muted-foreground">· {b.warn}</span>}
                  </div>
                  <span className="ml-auto shrink-0 md:ml-0">
                    {b.status === "connected" && <Badge variant="default"><Trans>connected</Trans></Badge>}
                    {b.status === "optional" && <Badge variant="secondary"><Trans>unbound</Trans></Badge>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground">
            <div className="mb-2 flex items-center gap-2">
              <I.Code size={13} />
              <span className="text-[12.5px] font-medium"><Trans>wrangler.toml snippet</Trans></span>
            </div>
            <pre className="m-0 whitespace-pre-wrap rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{`[[d1_databases]]
binding = "D1"
database_name = "backlex"

[[r2_buckets]]
binding = "R2"
bucket_name = "backlex-files"

[[vectorize]]
binding = "VECTORIZE"
index_name = "backlex-embeddings"

[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeRoom"`}</pre>
          </div>
        </div>
      )}

      {tab === "env" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <div className="flex items-start gap-2.5 overflow-hidden rounded-2xl border border-border bg-muted p-3.5">
            <I.Info size={14} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium"><Trans>Environment variables are read-only here</Trans></span>
              <span className="text-xs text-muted-foreground"><Trans>Set them in <span className="font-mono text-foreground">wrangler.toml [vars]</span> / <span className="font-mono text-foreground">wrangler secret put</span> (or <span className="font-mono text-foreground">apps/web/.env</span> on self-host) and redeploy. This panel only reports which keys are present — secret values are never sent to the browser.</Trans></span>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.Lock size={14} /><span className="text-[13px] font-medium"><Trans>environment</Trans></span>
              <span className="font-mono text-xs text-muted-foreground"><Trans>{envVars.filter((v) => v.value !== "(unset)").length} set · {envVars.filter((v) => v.value === "(unset)").length} unset</Trans></span>
            </div>
            <div className="hidden grid-cols-[24px_1fr_120px_110px] items-center gap-3 border-b border-border bg-muted px-3.5 py-[11px] text-[11px] uppercase tracking-[0.4px] text-muted-foreground md:grid">
              <span></span><span><Trans>Key</Trans></span><span><Trans>Kind</Trans></span><span><Trans>Status</Trans></span>
            </div>
            {envVars.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_1fr_120px_110px] md:gap-3 md:py-[11px]">
                <span className="shrink-0">{v.secret ? <I.Lock size={13} /> : <I.Hash size={13} />}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] md:flex-none md:break-normal">{v.key}</span>
                <span className="text-[11.5px] text-muted-foreground">{v.secret ? <Trans>secret</Trans> : <Trans>plain</Trans>}</span>
                <span className="ml-auto shrink-0 md:ml-0">{v.value === "(unset)" ? <Badge variant="secondary"><Trans>unset</Trans></Badge> : <Badge variant="default"><Trans>set</Trans></Badge>}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "about" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <div className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
            {[
              [t`Version`, "v0.9.4 (a8b2f1c)"],
              [t`Released`, "2025-10-12"],
              [t`Runtime`, adapter],
              [t`Wrangler`, "3.78.0"],
              [t`License`, "MIT"],
              [t`Repository`, "github.com/backlex/backlex"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{k}</span>
                <span className="font-mono text-[12.5px] text-muted-foreground">{v}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2.5 overflow-hidden rounded-2xl border border-border bg-card p-[18px] text-card-foreground">
            <I.Shield size={14} />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium"><Trans>Open-source · MIT licensed</Trans></span>
              <span className="text-xs text-muted-foreground"><Trans>Self-hosted on Cloudflare Workers. No telemetry, no billing — just clone, deploy, run.</Trans></span>
            </div>
            <div className="flex-1" />
            <Button variant="outline" size="sm" icon={I.Code}><Trans>GitHub</Trans></Button>
            <Button variant="ghost" size="sm" icon={I.Folder}><Trans>Docs</Trans></Button>
          </div>
        </div>
      )}
    </div>
  );
}
