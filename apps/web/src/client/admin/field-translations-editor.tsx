// @ts-nocheck
// Shared per-field label-translations editor — rendered in the Field tab of the
// Add / Edit field dialogs. One row per workspace locale (from the `i18nLocales`
// setting, the same source the i18n_text field editor uses). Empty rows are
// dropped on save. Display-only: the admin resolves a field's label as
// `translations[activeLocale] ?? label ?? name`.
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { useSettings } from "./queries";

/** Strip empty entries; undefined when nothing is set. */
export const cleanTranslations = (
  v: Record<string, string>,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v ?? {})) {
    if (val?.trim()) out[k] = val.trim();
  }
  return Object.keys(out).length ? out : undefined;
};

export function FieldTranslationsEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useLingui();
  const { data: settings } = useSettings();
  const locales: string[] =
    (settings?.data as { i18nLocales?: string[] } | undefined)?.i18nLocales ?? [];

  const set = (loc: string, label: string) => onChange({ ...value, [loc]: label });

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
        <Trans>Field name translations <span className="text-muted-foreground">(optional)</span></Trans>
      </label>
      {locales.length === 0 ? (
        <div className="rounded-surface bg-muted p-3 text-[11.5px] text-muted-foreground">
          <Trans>No workspace locales configured — add them under Settings → Localization.</Trans>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {locales.map((loc) => (
            <div key={loc} className="flex items-center gap-2">
              <span className="w-9 shrink-0 rounded-control bg-muted px-1.5 py-1 text-center font-mono text-[11px] uppercase text-muted-foreground">{loc}</span>
              <Input
                className="h-8 flex-1"
                placeholder={t`Label in ${loc}`}
                value={value[loc] ?? ""}
                onChange={(e) => set(loc, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}
      <span className="text-[11.5px] text-muted-foreground">
        <Trans>Shown instead of the label when the admin UI is in that language.</Trans>
      </span>
    </div>
  );
}
