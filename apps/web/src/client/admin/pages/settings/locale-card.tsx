// Settings card: workspace locale + timezone + i18n locales.
// Settings page — general/appearance/email/bindings/env/about tabs
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, } from "../../icons";
import { Button, IconButton, } from "../../ui";
import { Select } from "../../select";
import {
  settingsApi,
} from "../../api";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import {
  LOCALE_CODE_RE,
  languageOptions,
  localeLabel,
  timezoneOptions,
} from "../../preferences";


export function WorkspaceLocaleCard({ pushToast }: { pushToast: (m: string) => void }) {
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
    <Card className="max-w-[920px] gap-4 p-[22px]">
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
    </Card>
  );
}
