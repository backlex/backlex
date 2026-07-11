// Settings cards: admin appearance theme + sign-in branding.
// Settings page — general/appearance/email/bindings/env/about tabs
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, } from "../../icons";
import { Button, } from "../../ui";
import {
  settingsApi,
  workspaceConfigApi,
} from "../../api";
import { useTheme } from "@/components/theme-provider";
import { applyPrimaryColor } from "@/main";
import { refreshBranding } from "@/lib/branding";
import { Card } from "@backlex/ui/components/card";
import { ColorPicker } from "@backlex/ui/components/color-picker";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";

/** Mirror of `services/workspace-config.ts::isValidColor` — keep in sync. */
const isValidColor = (v: string): boolean => {
  const s = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) {
    return s.length === 4 || s.length === 5 || s.length === 7 || s.length === 9;
  }
  return /^(rgb|hsl|oklch|oklab)a?\(\s*[\d\s%.,/-]+\s*\)$/i.test(s);
};

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
export function AppearanceSettingsCard({ pushToast }: { pushToast: (m: string) => void }) {
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
    <Card className="max-w-[920px] gap-4 p-[22px]">
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
              className="size-14 rounded-control bg-muted object-contain p-1"
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
              className="size-8 rounded-control bg-muted object-contain p-0.5"
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
    </Card>
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
export function SignInBrandingCard({ pushToast }: { pushToast: (m: string) => void }) {
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
    <Card className="max-w-[920px] gap-4 p-[22px]">
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
    </Card>
  );
}

/**
 * Workspace language + time-zone settings. Manages the `i18nLocales` list
 * (the languages this workspace is translated into — the columns of the
 * Translations page and the locale options members may pick), the workspace
 * default language, and the default time zone. Persisted to `app_settings`
 * via the same `PATCH /api/admin/settings` whitelist as the General form.
 */
