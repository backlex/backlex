// The item-form editor for a `money` field.
//
// An amount box with the currency next to it. The currency is not editable
// here: it is either fixed on the field or it is another column on the same
// form, and giving this input a third opinion would be a way for a row to
// disagree with itself.
//
// The one piece of real work is the decimal separator. An operator in Turkish
// types `19,99`; the API reads `.` and refuses a `,` outright rather than
// guessing whether `1,234` is a thousand or one-and-a-bit (docs/money.md § What
// the API will not guess). The right place to resolve that is here, where the
// UI locale is known — so this component parses what was typed against the
// active locale's own separators and posts the canonical form.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { currencyExponent, formatMoney, type MoneyValue } from "@backlex/db/money";

/** The locale's decimal and group separators, from Intl itself rather than a
 *  table — `formatToParts` is the only source that cannot drift from how the
 *  same number is rendered back into the field. */
const separators = (locale: string): { decimal: string; group: string } => {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    return {
      decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
      group: parts.find((p) => p.type === "group")?.value ?? ",",
    };
  } catch {
    return { decimal: ".", group: "," };
  }
};

/**
 * What the user typed → a canonical decimal string, or null when it is not a
 * number yet (mid-typing `-`, `1.`, or empty).
 *
 * Deliberately tolerant of BOTH separators: someone pasting `19.99` into a
 * Turkish admin means nineteen ninety-nine, and refusing it because the locale
 * says otherwise would be pedantry against a value that has exactly one reading.
 * Ambiguity is only possible when both characters appear, and then the LAST one
 * is the decimal point — which is true in every convention that uses two.
 */
export const parseTypedAmount = (raw: string, locale: string): string | null => {
  const text = raw.trim().replace(/\s/g, "");
  if (text === "" || text === "-" || text === "+") return null;
  const { decimal, group } = separators(locale);
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let decimalChar: string | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalChar = lastDot > lastComma ? "." : ",";
  } else if (lastDot >= 0 || lastComma >= 0) {
    const only = lastDot >= 0 ? "." : ",";
    // One separator, and it could be either role. The locale breaks the tie,
    // except for the giveaway case: a group separator never has anything but
    // three digits after it.
    const after = text.length - text.lastIndexOf(only) - 1;
    decimalChar = only === decimal ? only : after === 3 && only === group ? null : only;
  }
  let normalized = text;
  if (decimalChar) {
    const at = normalized.lastIndexOf(decimalChar);
    normalized = `${normalized.slice(0, at).replace(/[.,]/g, "")}.${normalized.slice(at + 1)}`;
  } else {
    normalized = normalized.replace(/[.,]/g, "");
  }
  if (!/^[+-]?\d*\.?\d*$/.test(normalized) || !/\d/.test(normalized)) return null;
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
};

interface MoneyInputProps {
  /** `{ amount, currency }`, or null. */
  value: unknown;
  onChange: (v: MoneyValue | null) => void;
  /** Fixed currency from the field's spec, when it has one. */
  currency?: string;
  /** Name of the sibling column holding the code, when it has one instead. */
  currencyField?: string;
  /** The form's current values — so the currency shown follows the column the
   *  operator is editing RIGHT NOW, not the one still in the saved row. */
  siblings?: Record<string, unknown>;
  invalid?: boolean;
  disabled?: boolean;
}

export function MoneyInput({
  value,
  onChange,
  currency,
  currencyField,
  siblings,
  invalid,
  disabled,
}: MoneyInputProps) {
  const { i18n, t } = useLingui();
  const locale = i18n.locale || "en";
  const sibling = currencyField ? siblings?.[currencyField] : undefined;
  const active =
    (currency || (typeof sibling === "string" ? sibling.trim().toUpperCase() : "")) || "";
  const exponent = currencyExponent(active || null);

  const stored = value as Partial<MoneyValue> | null | undefined;
  const storedAmount = typeof stored?.amount === "number" ? stored.amount : null;

  // The box holds TEXT, not the number — otherwise a half-typed `19.` would
  // round-trip through `Number` and delete the character the operator just hit.
  const [text, setText] = useState<string>(
    storedAmount === null ? "" : storedAmount.toFixed(exponent),
  );
  // Re-seed when the row changes underneath (opening another item, an
  // optimistic patch landing) but never while the field has focus.
  useEffect(() => {
    setText((prev) => {
      const next = storedAmount === null ? "" : storedAmount.toFixed(exponent);
      const prevParsed = parseTypedAmount(prev, locale);
      return prevParsed !== null && Number(prevParsed) === storedAmount ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedAmount, exponent]);

  const commit = (raw: string) => {
    setText(raw);
    const parsed = parseTypedAmount(raw, locale);
    if (parsed === null) {
      onChange(null);
      return;
    }
    if (!active) {
      // No currency to denominate it in yet — the row has to answer that first,
      // and posting a bare amount would be a 422 the operator cannot act on.
      onChange(null);
      return;
    }
    onChange({ amount: Number(parsed), currency: active });
  };

  // Re-denominate when the ROW's currency column changes under us.
  //
  // Without this the draft keeps the currency it was typed in while the badge
  // beside it already reads the new one, and the save fails with "is in TRY,
  // but this field is denominated in JPY" — an error about a value the operator
  // can see is right. Switching a row from lira to yen means the number they
  // typed is now yen, which is also what the currency's own decimals then
  // enforce (`1500.75` in JPY reads as too precise, in the box, before saving).
  const committed = typeof stored?.currency === "string" ? stored.currency : null;
  useEffect(() => {
    if (!active || !committed || committed === active) return;
    const parsed = parseTypedAmount(text, locale);
    onChange(parsed === null ? null : { amount: Number(parsed), currency: active });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, committed]);

  const tooPrecise =
    parseTypedAmount(text, locale) !== null &&
    (parseTypedAmount(text, locale) as string).split(".")[1] !== undefined &&
    ((parseTypedAmount(text, locale) as string).split(".")[1] as string).length > exponent;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <Input
          className="min-w-0 flex-1 text-right tabular-nums"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          placeholder={(0).toFixed(exponent)}
          aria-invalid={invalid || tooPrecise || undefined}
          aria-label={t`Amount`}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            const parsed = parseTypedAmount(text, locale);
            if (parsed !== null && !tooPrecise) setText(Number(parsed).toFixed(exponent));
          }}
        />
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
          {active || "—"}
        </span>
      </div>
      {!active && (
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            Set {currencyField} first — an amount has to say what it is in.
          </Trans>
        </span>
      )}
      {tooPrecise && (
        <span className="text-[11.5px] text-destructive">
          <Trans>{active} amounts have {exponent} decimal places.</Trans>
        </span>
      )}
      {active && !tooPrecise && storedAmount !== null && (
        <span className="text-[11.5px] text-muted-foreground">
          {formatMoney({ amount: storedAmount, currency: active }, locale)}
        </span>
      )}
    </div>
  );
}
