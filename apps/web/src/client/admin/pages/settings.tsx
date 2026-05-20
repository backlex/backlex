// Settings page — general/appearance/email/bindings/env/about tabs
import { useCallback, useEffect, useRef, useState } from "react";
import { I, type IconComponent } from "../icons";
import { type AdapterId } from "../config";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import {
  emailConfigApi,
  settingsApi,
  workspaceConfigApi,
  type ApiRuntime,
} from "../api";
import { useTheme } from "@/components/theme-provider";
import { applyPrimaryColor } from "@/main";
import { ColorPicker } from "@workeros/ui/components/color-picker";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";

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
      pushToast("Email settings saved.");
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
      pushToast(`Test email sent to ${r.to}.`);
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
    <div className="flex max-w-[720px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          Email transport for <b>this workspace</b>. Resolution order: this config → the instance-wide
          default → the deployment’s <span className="font-mono">EMAIL_PROVIDER</span> / env keys. Secret
          values are encrypted at rest and never shown again.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Provider</label>
        <Select value={provider} onChange={(v: string) => { setProvider(v); mark(); }} options={EMAIL_PROVIDER_OPTIONS} />
        <span className="text-[11.5px] text-muted-foreground">{fields.hint}{envHint}</span>
      </div>
      {provider !== "inherit" && provider !== "console" && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">From address</label>
          <Input placeholder="hello@yourdomain.com" value={from} onChange={(e) => { setFrom(e.target.value); mark(); }} />
          <span className="text-[11.5px] text-muted-foreground">Required for every provider — must be a verified sender/domain for the chosen transport.</span>
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
            placeholder={cfg?.secretsSet?.[key] ? "•••••••• (stored — leave blank to keep)" : ""}
            value={secrets[key] ?? ""}
            onChange={(e) => { setSecrets((s) => ({ ...s, [key]: e.target.value })); mark(); }}
          />
          {cfg?.secretsSet?.[key] && <span className="text-[11.5px] text-muted-foreground">A value is stored. Type a new one to replace it, or leave blank to keep it.</span>}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <Button variant="outline" size="sm" disabled={testing} onClick={() => void sendTest()}>{testing ? "Sending…" : "Send test email"}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => void load()}>Discard</Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </div>
  );
}

const PRIMARY_PRESETS: { label: string; value: string }[] = [
  { label: "Lime", value: "oklch(0.841 0.238 128.85)" },
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
      pushToast("Primary color must be a hex (#rrggbb) or a CSS color function.");
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
      pushToast("Branding saved.");
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
    <div className="flex max-w-[720px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Workspace name</label>
        <Input
          value={workspaceName}
          disabled={loading}
          onChange={(e) => { setWorkspaceName(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground">Shown in the sidebar and the browser title.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Description</label>
        <Textarea
          rows={3}
          value={description}
          disabled={loading}
          onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
        />
        <span className="text-[11.5px] text-muted-foreground">Short tagline for the workspace.</span>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3.5">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Logo</div>
          <div className="text-[11.5px] text-muted-foreground">PNG, JPG, SVG or WebP. Replaces any previous upload.</div>
        </div>
        <div className="flex items-center gap-3">
          {logoSrc && (
            <img
              src={logoSrc}
              alt="workspace logo"
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
            {uploadingLogo ? "Uploading…" : logoFileKey ? "Replace" : "Upload"}
          </Button>
          {logoFileKey && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploadingLogo || loading}
              onClick={() => { setLogoFileKey(null); setDirty(true); }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Favicon</div>
          <div className="text-[11.5px] text-muted-foreground">PNG or ICO recommended (≤ 64 KB).</div>
        </div>
        <div className="flex items-center gap-3">
          {faviconSrc && (
            <img
              src={faviconSrc}
              alt="workspace favicon"
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
            {uploadingFavicon ? "Uploading…" : faviconFileKey ? "Replace" : "Upload"}
          </Button>
          {faviconFileKey && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploadingFavicon || loading}
              onClick={() => { setFaviconFileKey(null); setDirty(true); }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border pt-3.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Primary color</label>
        <div className="mb-2.5 flex flex-wrap gap-2">
          {PRIMARY_PRESETS.map((p) => {
            const active = primaryColor.trim() === p.value;
            return (
              <button
                key={p.value}
                type="button"
                title={p.label}
                aria-label={`Use ${p.label} palette`}
                aria-pressed={active}
                disabled={loading}
                onClick={() => commitPrimary(p.value)}
                className={`size-7 rounded-full border border-border p-0 ${loading ? "cursor-default" : "cursor-pointer"} ${active ? "shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--foreground)]" : ""}`}
                style={{ background: p.value }}
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
              Reset
            </Button>
          )}
        </div>
        <span className="text-[11.5px] text-muted-foreground">
          {primaryColorOk
            ? "Overrides the `--primary` token used across the admin and any published surfaces."
            : "Use a hex value (#rrggbb), or a CSS color function: rgb(), hsl(), oklch(), oklab()."}
        </span>
      </div>
      <div className="flex items-start justify-between gap-3 border-t border-border pt-3.5">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Workspace default theme</div>
          <div className="text-[11.5px] text-muted-foreground">Applied to users with no local override yet.</div>
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
              {opt === "" ? "Leave to user" : opt === "light" ? "Light" : opt === "dark" ? "Dark" : "System"}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">My theme</div>
          <div className="text-[11.5px] text-muted-foreground">Your own preference — stored locally, not synced.</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["light", "dark", "system"] as const).map((opt) => (
            <Button
              key={opt}
              variant={userTheme === opt ? "primary" : "outline"}
              size="sm"
              onClick={() => setUserTheme(opt)}
            >
              {opt === "light" ? "Light" : opt === "dark" ? "Dark" : "System"}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1.5">
        <Button variant="ghost" size="sm" disabled={!dirty || saving || loading} onClick={() => void load()}>Discard</Button>
        <Button variant="primary" size="sm" disabled={!dirty || saving || loading} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function SettingsPage({ adapter, pushToast }: { adapter: AdapterId; pushToast: (m: string) => void }) {
  const [tab, setTab] = useState("general");
  const [appUrl, setAppUrl] = useState("http://localhost:8787");
  const [from, setFrom] = useState("hello@example.com");
  const [signupOpen, setSignupOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  // Hydrate the General-tab form from /api/admin/settings on mount. APP_URL
  // and EMAIL_FROM come from env (read-only here); openSignup is the
  // runtime-mutable setting persisted in app_settings. The display name lives
  // in workspace_config and is edited from the Appearance tab.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.load();
        if (cancelled) return;
        const d = r.data as Record<string, unknown>;
        if (typeof d.appUrl === "string") setAppUrl(d.appUrl);
        if (typeof d.emailFrom === "string") setFrom(d.emailFrom);
        if (typeof d.openSignup === "boolean") setSignupOpen(d.openSignup);
      } catch {
        // keep seed
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
  const persistGeneral = async () => {
    try {
      await settingsApi.patch({ openSignup: signupOpen });
      setDirty(false);
      pushToast("Settings saved.");
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const bindingIcon = (t: string): IconComponent => (({ D1: I.Database, KV: I.Folder, R2: I.Server, DurableObj: I.Bolt, Vectorize: I.Bolt, Hyperdrive: I.Database, Dispatch: I.Bolt, Queue: I.Webhook, AI: I.Bolt } as Record<string, IconComponent>)[t] || I.Folder);

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title="Settings" description="Self-hosted on Cloudflare Workers. Most config lives in wrangler.toml; this page is a live view + UI for runtime-mutable values." />
      <div className="flex w-fit gap-0.5 rounded-3xl bg-muted p-[3px]">
        {[
          { id: "general", label: "General" },
          { id: "appearance", label: "Appearance" },
          { id: "email", label: "Email" },
          { id: "bindings", label: "Bindings", count: bindings.length },
          { id: "env", label: "Environment", count: envVars.length },
          { id: "about", label: "About" },
        ].map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-3xl border-0 px-3.5 py-[5px] text-[12.5px] font-medium ${on ? "bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.06),0_1px_0_oklch(0_0_0/0.04)]" : "bg-transparent text-muted-foreground"}`}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
              {t.count !== undefined && <span className={`rounded-sm border border-border px-[5px] py-px font-mono text-[11px] text-muted-foreground ${on ? "bg-muted" : "bg-background"}`}>{t.count}</span>}
            </button>
          );
        })}
      </div>

      {tab === "general" && (
        <div className="flex max-w-[720px] flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">APP_URL</div>
              <div className="text-[11.5px] text-muted-foreground">Public origin of this Worker — set via <span className="font-mono">wrangler.toml [vars]</span> (or <span className="font-mono">.env</span> on self-host). Used for CORS, OAuth callbacks and absolute links. Read-only here.</div>
            </div>
            <span className="max-w-[280px] truncate font-mono text-[12.5px] text-muted-foreground" title={appUrl}>{appUrl}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">EMAIL_FROM</div>
              <div className="text-[11.5px] text-muted-foreground">Sender address for transactional email — set via <span className="font-mono">wrangler secret put</span> / <span className="font-mono">.env</span>. When unset (or RESEND_API_KEY is missing) email is logged to stdout. Read-only here.</div>
            </div>
            <span className="font-mono text-[12.5px] text-muted-foreground">{from || "(not set)"}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Open sign-up</div>
              <div className="text-[11.5px] text-muted-foreground">When off, new account creation is rejected on every path (email/password, social, magic-link). The first user is always allowed so a fresh instance can bootstrap its admin.</div>
            </div>
            <Switch checked={signupOpen} onChange={(v) => { setSignupOpen(v); setDirty(true); }} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Runtime</div>
              <div className="text-[11.5px] text-muted-foreground">Auto-detected from <span className="font-mono">env</span> bindings.</div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-3xl border border-border bg-background py-0.5 pl-1.5 pr-2 text-[11px]"><span className="size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" />{adapter}</span>
          </div>
          <div className="flex justify-end gap-2 pt-1.5">
            <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDirty(false)}>Discard</Button>
            <Button variant="primary" size="sm" disabled={!dirty} onClick={persistGeneral}>Save</Button>
          </div>
        </div>
      )}

      {tab === "appearance" && <AppearanceSettingsCard pushToast={pushToast} />}

      {tab === "email" && <EmailSettingsCard pushToast={pushToast} />}

      {tab === "bindings" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <div className="flex items-start gap-2.5 overflow-hidden rounded-2xl border border-border bg-muted p-3.5">
            <I.Info size={14} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium">Bindings are read-only here</span>
              <span className="text-xs text-muted-foreground">Edit them in <span className="font-mono text-foreground">wrangler.toml</span> and redeploy. This panel reflects the live binding map from <span className="font-mono text-foreground">env</span>.</span>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.Server size={14} /><span className="text-[13px] font-medium">worker bindings</span>
              <span className="font-mono text-xs text-muted-foreground">{bindings.filter((b) => b.status === "connected").length} connected · {bindings.filter((b) => b.status !== "connected").length} optional</span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast("Bindings refreshed.")}>Refresh</Button>
            </div>
            <div className="w-full max-w-full overflow-x-auto">
            <div className="grid grid-cols-[24px_110px_160px_1fr_120px] items-center gap-3 border-b border-border bg-muted px-3.5 py-[11px] text-[11px] uppercase tracking-[0.4px] text-muted-foreground">
              <span></span><span>Type</span><span>Name</span><span>Resource</span><span>Status</span>
            </div>
            {bindings.map((b) => {
              const Ic = bindingIcon(b.type);
              return (
                <div key={b.id} className="grid grid-cols-[24px_110px_160px_1fr_120px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0">
                  <span><Ic size={14} /></span>
                  <span className="font-mono text-[12.5px]">{b.type}</span>
                  <span className="font-mono text-[13px]">{b.name}</span>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{b.target}</span>
                    {b.warn && <span className="text-[11.5px] text-muted-foreground">· {b.warn}</span>}
                  </div>
                  <span>
                    {b.status === "connected" && <Badge variant="default">connected</Badge>}
                    {b.status === "optional" && <Badge variant="secondary">unbound</Badge>}
                  </span>
                </div>
              );
            })}
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground">
            <div className="mb-2 flex items-center gap-2">
              <I.Code size={13} />
              <span className="text-[12.5px] font-medium">wrangler.toml snippet</span>
            </div>
            <pre className="m-0 whitespace-pre-wrap rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{`[[d1_databases]]
binding = "D1"
database_name = "workeros"

[[r2_buckets]]
binding = "R2"
bucket_name = "workeros-files"

[[vectorize]]
binding = "VECTORIZE"
index_name = "workeros-embeddings"

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
              <span className="text-[12.5px] font-medium">Environment variables are read-only here</span>
              <span className="text-xs text-muted-foreground">Set them in <span className="font-mono text-foreground">wrangler.toml [vars]</span> / <span className="font-mono text-foreground">wrangler secret put</span> (or <span className="font-mono text-foreground">apps/web/.env</span> on self-host) and redeploy. This panel only reports which keys are present — secret values are never sent to the browser.</span>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.Lock size={14} /><span className="text-[13px] font-medium">environment</span>
              <span className="font-mono text-xs text-muted-foreground">{envVars.filter((v) => v.value !== "(unset)").length} set · {envVars.filter((v) => v.value === "(unset)").length} unset</span>
            </div>
            <div className="w-full max-w-full overflow-x-auto">
            <div className="grid grid-cols-[24px_1fr_120px_110px] items-center gap-3 border-b border-border bg-muted px-3.5 py-[11px] text-[11px] uppercase tracking-[0.4px] text-muted-foreground">
              <span></span><span>Key</span><span>Kind</span><span>Status</span>
            </div>
            {envVars.map((v) => (
              <div key={v.id} className="grid grid-cols-[24px_1fr_120px_110px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0">
                <span>{v.secret ? <I.Lock size={13} /> : <I.Hash size={13} />}</span>
                <span className="font-mono text-[12.5px]">{v.key}</span>
                <span className="text-[11.5px] text-muted-foreground">{v.secret ? "secret" : "plain"}</span>
                <span>{v.value === "(unset)" ? <Badge variant="secondary">unset</Badge> : <Badge variant="default">set</Badge>}</span>
              </div>
            ))}
            </div>
          </div>
        </div>
      )}

      {tab === "about" && (
        <div className="flex max-w-[720px] flex-col gap-3">
          <div className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
            {[
              ["Version", "v0.9.4 (a8b2f1c)"],
              ["Released", "2025-10-12"],
              ["Runtime", adapter],
              ["Wrangler", "3.78.0"],
              ["License", "MIT"],
              ["Repository", "github.com/workeros/workeros"],
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
              <span className="text-[13px] font-medium">Open-source · MIT licensed</span>
              <span className="text-xs text-muted-foreground">Self-hosted on Cloudflare Workers. No telemetry, no billing — just clone, deploy, run.</span>
            </div>
            <div className="flex-1" />
            <Button variant="outline" size="sm" icon={I.Code}>GitHub</Button>
            <Button variant="ghost" size="sm" icon={I.Folder}>Docs</Button>
          </div>
        </div>
      )}
    </div>
  );
}
