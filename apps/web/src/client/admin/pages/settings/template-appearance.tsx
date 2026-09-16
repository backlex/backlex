/**
 * The Appearance tab shared by the email- and document-template editors: the
 * theme, accent and font a form's design panel offers, in the same vocabulary
 * (`@backlex/core/appearance`).
 *
 * A template is raw HTML, so choosing a theme does not restyle it behind the
 * author's back. The choice becomes `{{ theme.* }}` values the HTML reads — the
 * same values the mailer and the PDF renderer fill in — which is why the tab
 * lists those variables under the controls rather than on a separate screen:
 * picking a colour and putting it somewhere is one task.
 *
 * Each control shows what it DOES rather than naming it: the theme as two
 * miniature documents in the palettes a recipient would see, the font as the
 * letters it draws, a variable with the colour it currently holds.
 */
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  ACCENTS,
  THEME_VAR_NAMES,
  fontStack,
  paletteFor,
  safeAccent,
  themeVars,
  type Appearance,
  type AppearanceFont,
  type AppearanceTheme,
  type ThemeVars,
} from "@backlex/core/appearance";
import { cn } from "@backlex/ui/lib/utils";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import { I } from "../../icons";
import { Button } from "../../ui";
import { PanelLabel } from "../data/forms/panels";

const THEME_VAR_DESCRIPTIONS: Record<keyof ThemeVars, MessageDescriptor> = {
  mode: msg`light or dark.`,
  accent: msg`The accent colour — links, buttons, headings.`,
  accentInk: msg`Text that reads on the accent, for a button label.`,
  bg: msg`Page background.`,
  card: msg`Background of a panel on the page.`,
  text: msg`Body text.`,
  muted: msg`Secondary text.`,
  faint: msg`Least prominent text, such as a footnote.`,
  border: msg`Borders and dividers.`,
  font: msg`A CSS font-family value.`,
  fontsHref: msg`Stylesheet URL for the web fonts. PDFs load it; most mail clients fall back to the stack.`,
};

const FONT_OPTIONS: { value: AppearanceFont; label: string }[] = [
  { value: "sans", label: "Manrope" },
  { value: "lexend", label: "Lexend" },
  { value: "mono", label: "Mono" },
  { value: "system", label: "System" },
];

/** Drop keys equal to what an unset appearance already renders, so choosing the
 *  defaults back leaves a template with nothing stored. */
const compact = (a: Appearance): Appearance | null => {
  const out: Appearance = {};
  if (a.theme && a.theme !== "light") out.theme = a.theme;
  if (a.accent && a.accent.toLowerCase() !== ACCENTS[0].toLowerCase()) out.accent = a.accent;
  if (a.font && a.font !== "sans") out.font = a.font;
  return Object.keys(out).length > 0 ? out : null;
};

const SELECTED = "border-primary bg-primary/10";
const UNSELECTED = "border-input hover:bg-accent/40";

/** A theme as a miniature of the document it produces — the palette a recipient
 *  sees, not the word for it. */
function ThemeCard({
  mode,
  accent,
  selected,
  onSelect,
}: {
  mode: AppearanceTheme;
  accent: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const p = paletteFor(mode);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        // `items-stretch` is load-bearing: the admin's base button rule aligns
        // its children to the start, which collapses the miniature to nothing.
        "flex min-w-0 flex-1 cursor-pointer flex-col items-stretch gap-2 rounded-control border p-2 text-left transition-colors",
        selected ? SELECTED : UNSELECTED,
      )}
    >
      <span
        className="flex h-16 flex-col gap-1.5 rounded-sm p-2.5"
        style={{ background: p.bg }}
        aria-hidden
      >
        <span className="h-2 w-[46%] rounded-[3px]" style={{ background: accent }} />
        <span className="h-1.5 w-[82%] rounded-[3px] opacity-85" style={{ background: p.text }} />
        <span className="h-1.5 w-[64%] rounded-[3px] opacity-80" style={{ background: p.muted }} />
        <span className="mt-auto h-3 w-[38%] rounded-[4px]" style={{ background: accent }} />
      </span>
      <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
        {selected && <I.Check size={13} className="text-primary" />}
        {mode === "light" ? <Trans>Light</Trans> : <Trans>Dark</Trans>}
      </span>
    </button>
  );
}

export function TemplateAppearancePanel({
  value,
  onChange,
}: {
  value: Appearance | null;
  onChange: (next: Appearance | null) => void;
}) {
  const theme: AppearanceTheme = value?.theme ?? "light";
  const accent = safeAccent(value?.accent);
  const font: AppearanceFont = value?.font ?? "sans";
  const patch = (p: Appearance) => onChange(compact({ theme, accent, font, ...p }));

  return (
    <div className="flex flex-col gap-4" data-testid="template-appearance">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <PanelLabel><Trans>theme</Trans></PanelLabel>
          {value && (
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onChange(null)}>
              <Trans>Reset</Trans>
            </Button>
          )}
        </div>
        <div className="flex gap-2.5">
          {(["light", "dark"] as const).map((mode) => (
            <ThemeCard
              key={mode}
              mode={mode}
              accent={accent}
              selected={theme === mode}
              onSelect={() => patch({ theme: mode })}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <PanelLabel><Trans>accent</Trans></PanelLabel>
        <ColorSwatchPicker
          options={ACCENTS.map((c) => ({ value: c, swatch: c }))}
          value={accent}
          onChange={(next) => patch({ accent: next })}
          showValue
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <PanelLabel><Trans>font</Trans></PanelLabel>
        {/* Four names do not fit a segmented control half an editor column
            wide — and a clipped "System" reads as a missing option. */}
        <div className="grid grid-cols-4 gap-2 max-[420px]:grid-cols-2">
          {FONT_OPTIONS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={font === f.value}
              onClick={() => patch({ font: f.value })}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1 rounded-control border px-2 py-2.5 transition-colors",
                font === f.value ? SELECTED : UNSELECTED,
              )}
            >
              <span className="text-[20px] leading-none font-semibold" style={{ fontFamily: fontStack(f.value) }}>
                Aa
              </span>
              <span className="text-[11.5px] text-muted-foreground">{f.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The `{{ theme.* }}` variables, each a button that inserts its placeholder,
 *  showing the value the current appearance gives it. */
export function ThemeVariables({
  appearance,
  onInsert,
}: {
  appearance: Appearance | null;
  onInsert: (path: string) => void;
}) {
  const { t, i18n } = useLingui();
  const values = themeVars(appearance);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4" data-testid="theme-variables">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Theme variables</Trans>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>Always available. Click one to insert it where your cursor is.</Trans>
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-1.5 max-[1280px]:grid-cols-1">
        {THEME_VAR_NAMES.map((name) => {
          const path = `theme.${name}`;
          const value = values[name];
          const isColour = /^(#|rgba?\()/.test(value);
          return (
            <li key={name} className="min-w-0">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsert(path)}
                title={i18n._(THEME_VAR_DESCRIPTIONS[name])}
                aria-label={t`Insert {{ ${path} }}`}
                className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-control border border-border bg-card px-2 hover:bg-accent"
              >
                {isColour ? (
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full border border-border"
                    style={{ background: value }}
                  />
                ) : (
                  <I.Code size={11} className="shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0 font-mono text-[11.5px]">{path}</span>
                <span className="min-w-0 truncate text-right font-mono text-[10.5px] text-muted-foreground ml-auto">
                  {value}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
