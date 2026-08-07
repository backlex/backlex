// Shared per-field display-format editor — rendered in the Interface tab of the
// Add / Edit field dialogs for number / timestamp fields. Display-only: it
// changes how the value RENDERS in lists + detail, never storage/API/sort. The
// parent owns a plain `format` object; `cleanFormat` strips empties for save.
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { Select } from "../select";
import { formatFieldValue } from "../lib/format-value";

export interface FieldFormatDraft {
  style?: string;
  precision?: string; // kept as string in the draft; coerced on save
  currency?: string;
  thousandSeparator?: boolean;
  dateStyle?: string;
  prefix?: string;
  suffix?: string;
}

/** Hydrate a draft from a stored `format` object. */
export const formatToDraft = (v: unknown): FieldFormatDraft => {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  return {
    style: typeof o.style === "string" ? o.style : undefined,
    precision: o.precision != null ? String(o.precision) : "",
    currency: typeof o.currency === "string" ? o.currency : "",
    thousandSeparator: o.thousandSeparator == null ? true : !!o.thousandSeparator,
    dateStyle: typeof o.dateStyle === "string" ? o.dateStyle : undefined,
    prefix: typeof o.prefix === "string" ? o.prefix : "",
    suffix: typeof o.suffix === "string" ? o.suffix : "",
  };
};

/** Compile a draft into the `format` object (or undefined when it's all defaults). */
export const cleanFormat = (d: FieldFormatDraft, type: string): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  const isNum = type === "integer" || type === "number";
  const isDate = type === "timestamp";
  if (isNum && d.style && d.style !== "plain") {
    out.style = d.style;
    if (d.precision?.trim() && !Number.isNaN(Number(d.precision))) out.precision = Number(d.precision);
    if (d.style === "currency" && d.currency?.trim()) out.currency = d.currency.trim().toUpperCase();
    if (d.style === "decimal" && d.thousandSeparator === false) out.thousandSeparator = false;
  }
  if (isDate && d.dateStyle) out.dateStyle = d.dateStyle;
  if (d.prefix?.trim()) out.prefix = d.prefix;
  if (d.suffix?.trim()) out.suffix = d.suffix;
  return Object.keys(out).length ? out : undefined;
};

const CURRENCIES = ["USD", "EUR", "GBP", "TRY", "JPY", "CAD", "AUD", "CHF", "CNY", "INR"];

export function FieldFormatEditor({
  type,
  value,
  onChange,
}: {
  type: string;
  value: FieldFormatDraft;
  onChange: (next: FieldFormatDraft) => void;
}) {
  const { t } = useLingui();
  const isNum = type === "integer" || type === "number";
  const isDate = type === "timestamp";
  if (!isNum && !isDate) return null;

  const set = (patch: Partial<FieldFormatDraft>) => onChange({ ...value, ...patch });
  const compiled = cleanFormat(value, type);
  const sample = isNum ? 1234.5 : Date.now() - 3 * 86400000;
  const preview = formatFieldValue(sample, { type, format: compiled as never }, "en");

  return (
    <div className="flex flex-col gap-2.5 rounded-control bg-muted p-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
          <Trans>Display format</Trans>
        </span>
        <span className="text-[11.5px] text-muted-foreground"><Trans>rendering only — never affects storage or sorting</Trans></span>
      </div>

      {isNum && (
        <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-1">
            <label className="text-[11.5px] font-medium text-muted-foreground"><Trans>Style</Trans></label>
            <Select
              value={value.style ?? "plain"}
              onChange={(v) => set({ style: v })}
              options={[
                { value: "plain", label: t`Plain` },
                { value: "decimal", label: t`Decimal (1,234.5)` },
                { value: "currency", label: t`Currency` },
                // Both percent renderings are offered, labelled by what the
                // COLUMN holds rather than by a name — "Percent" alone is the
                // ambiguity, and choosing wrong is off by a factor of a hundred.
                // The 0–100 variant is listed first because it is what every
                // template's `{min: 0, max: 100}` validation means.
                { value: "percent100", label: t`Percent — column holds 20 for 20%` },
                { value: "percent", label: t`Percent — column holds 0.2 for 20%` },
              ]}
              size="sm"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label className="text-[11.5px] font-medium text-muted-foreground"><Trans>Decimal places</Trans></label>
            <Input inputMode="numeric" className="h-8" placeholder="—" value={value.precision ?? ""} onChange={(e) => set({ precision: e.target.value })} />
          </div>
          {value.style === "currency" && (
            <div className="flex min-w-0 flex-col gap-1">
              <label className="text-[11.5px] font-medium text-muted-foreground"><Trans>Currency</Trans></label>
              <Select
                value={value.currency || "USD"}
                onChange={(v) => set({ currency: v })}
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                size="sm"
              />
            </div>
          )}
          {value.style === "decimal" && (
            <label className="col-span-2 flex cursor-pointer items-center gap-2 text-[12px] text-foreground max-[520px]:col-span-1">
              <input type="checkbox" checked={value.thousandSeparator !== false} onChange={(e) => set({ thousandSeparator: e.target.checked })} />
              <Trans>Group thousands (1,234)</Trans>
            </label>
          )}
        </div>
      )}

      {isDate && (
        <div className="flex flex-col gap-1">
          <label className="text-[11.5px] font-medium text-muted-foreground"><Trans>Date style</Trans></label>
          <Select
            value={value.dateStyle ?? "datetime"}
            onChange={(v) => set({ dateStyle: v })}
            options={[
              { value: "relative", label: t`Relative (3d ago)` },
              { value: "date", label: t`Date only` },
              { value: "time", label: t`Time only` },
              { value: "datetime", label: t`Date & time` },
            ]}
            size="sm"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-1">
          <label className="text-[11.5px] font-medium text-muted-foreground"><Trans>Prefix</Trans></label>
          <Input className="h-8" placeholder="≈" value={value.prefix ?? ""} onChange={(e) => set({ prefix: e.target.value })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label className="text-[11.5px] font-medium text-muted-foreground"><Trans>Suffix</Trans></label>
          <Input className="h-8" placeholder="kg" value={value.suffix ?? ""} onChange={(e) => set({ suffix: e.target.value })} />
        </div>
      </div>

      <div className="text-[11.5px] text-muted-foreground">
        <Trans>Preview:</Trans> <span className="font-mono text-foreground">{preview || "—"}</span>
      </div>
    </div>
  );
}
