
import { Trans, useLingui } from "@lingui/react/macro";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import { ACCENTS, safeAccent, } from "@/lib/public-theme";
import { I } from "../../../icons";
import {
  IconButton,
} from "../../../ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Card } from "@backlex/ui/components/card";
import {
  type ApiFormSettings,
} from "../../../api";
import { AddLanguagePopover } from "./share-tab";

export function PanelCard({
  icon: Icon,
  title,
  children,
  onClose,
}: {
  icon: (p: { size?: number }) => React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const { t } = useLingui();
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-primary"><Icon size={14} /></span>
        {title}
        {onClose && (
          <span className="ml-auto">
            <IconButton icon={I.X} title={t`Deselect`} onClick={onClose} />
          </span>
        )}
      </div>
      {children}
    </Card>
  );
}

export function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-control border border-border bg-background/50 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-[6px] px-2 py-1.5 text-[12px] font-medium transition-colors ${
            value === o.value ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DesignPanel({
  settings,
  languages,
  collection,
  eligibleCount,
  versioned,
  onOpenCollection,
  onPatch,
}: {
  settings: ApiFormSettings;
  languages: string[];
  collection: string;
  eligibleCount: number;
  versioned: boolean;
  onOpenCollection: () => void;
  onPatch: (p: Partial<ApiFormSettings>) => void;
}) {
  const { t } = useLingui();
  const accent = safeAccent(settings.accent);
  return (
    <>
      <PanelCard icon={I.Palette} title={<Trans>Form design</Trans>}>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>theme</Trans></PanelLabel>
          <Segmented
            value={settings.theme ?? "dark"}
            onChange={(v) => onPatch({ theme: v })}
            options={[
              { value: "dark", label: t`Dark` },
              { value: "light", label: t`Light` },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>accent</Trans></PanelLabel>
          <ColorSwatchPicker
            options={ACCENTS.map((c) => ({ value: c, swatch: c }))}
            value={accent}
            onChange={(accent) => onPatch({ accent })}
            showValue
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>font</Trans></PanelLabel>
          <Segmented
            value={settings.font ?? "sans"}
            onChange={(v) => onPatch({ font: v })}
            options={[
              { value: "sans", label: "Manrope" },
              { value: "lexend", label: "Lexend" },
              { value: "mono", label: <span className="font-mono">Mono</span> },
              { value: "system", label: t`System` },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>languages</Trans></PanelLabel>
          <div className="flex flex-wrap items-center gap-1">
            {languages.map((l, i) => (
              <span
                key={l}
                className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
              >
                {l}
                {i > 0 && (
                  <button
                    type="button"
                    title={t`Remove language`}
                    onClick={() => onPatch({ languages: languages.filter((x) => x !== l) })}
                    className="text-muted-foreground/60 hover:text-destructive"
                  >
                    <I.X size={9} />
                  </button>
                )}
              </span>
            ))}
            <AddLanguagePopover
              languages={languages}
              onAdd={(code) => onPatch({ languages: [...languages, code] })}
            />
          </div>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            <Trans>Visitors get their browser language; <span className="font-mono">?lang={languages[1] ?? "tr"}</span> forces
            one. Missing strings fall back to the base language.</Trans>
          </span>
        </div>
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <PanelLabel><Trans>source collection</Trans></PanelLabel>
          <div className="flex items-center gap-2 rounded-control border border-border bg-background/50 px-3 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-primary/10 text-primary">
              <I.Database size={12} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px]">{collection}</div>
              <div className="truncate text-[10.5px] text-muted-foreground">
                <Trans>{eligibleCount} eligible fields</Trans>
                {versioned && <span> · <Trans>versioned</Trans></span>}
              </div>
            </div>
            <IconButton icon={I.ExternalLink} title={t`Open collection`} onClick={onOpenCollection} />
          </div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            <Trans>Select a block on the canvas to edit its settings. Scalar and
            file fields can be exposed — never private or computed ones.</Trans>
          </p>
        </div>
      </PanelCard>
    </>
  );
}

/* ── right panel: block settings ───────────────────────────────────── */

export function EndingPanel({
  settings,
  locale,
  base,
  onText,
  onPatch,
  onClose,
}: {
  settings: ApiFormSettings;
  locale: string;
  base: string;
  onText: (key: "title" | "description" | "submitLabel" | "successMessage", value: string) => void;
  onPatch: (p: Partial<ApiFormSettings>) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const loc = locale !== base ? settings.i18n?.[locale] : undefined;
  return (
    <PanelCard icon={I.Zap} title={<Trans>Ending</Trans>} onClose={onClose}>
      {locale !== base && (
        <div className="rounded-control border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary">
          <Trans>editing {locale.toUpperCase()} — empty falls back to {base.toUpperCase()}</Trans>
        </div>
      )}
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Submit button label</Trans>
        <Input
          value={locale === base ? settings.submitLabel ?? "" : loc?.submitLabel ?? ""}
          placeholder={locale === base ? t`Submit` : settings.submitLabel ?? t`Submit`}
          onChange={(e) => onText("submitLabel", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Success message</Trans>
        <Textarea
          rows={2}
          value={locale === base ? settings.successMessage ?? "" : loc?.successMessage ?? ""}
          placeholder={locale === base ? t`Thanks — we got it!` : settings.successMessage ?? ""}
          onChange={(e) => onText("successMessage", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Redirect URL</Trans>
        <Input
          value={settings.redirectUrl ?? ""}
          placeholder="https://example.com/thanks"
          onChange={(e) => onPatch({ redirectUrl: e.target.value || undefined })}
        />
        <span className="text-[11px] font-normal text-muted-foreground">
          <Trans>If set, visitors are sent there instead of seeing the message.</Trans>
        </span>
      </label>
    </PanelCard>
  );
}

/* ── share tab ─────────────────────────────────────────────────────── */
