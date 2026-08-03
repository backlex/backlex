// @ts-nocheck
// Shared currency editor — the Money tab of the Add / Edit field dialogs, shown
// for the `money` interface.
//
// Unlike the Location tab, nothing here is optional. A money column stores an
// integer count of minor units, and the currency is what says how many of them
// make one — so a money field with no currency is a number nobody, including
// this admin, can interpret. The dialog refuses to save without one.
//
// Two ways to answer, and the choice is a real modelling decision rather than a
// preference: ONE currency for the whole column (a price list, a payroll table)
// or one PER ROW, read from a sibling text column (an invoices table that bills
// in whatever the customer pays in). The second is what the schema templates
// already do — a `currency` column sitting next to the amounts — which is why
// it is offered as a first-class mode instead of being something you work
// around.
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import {
  COMMON_CURRENCIES,
  currencyExponent,
  formatMoney,
  MAX_MINOR_UNIT_EXPONENT,
} from "@backlex/db/money";
import { Select } from "./select";
import { I } from "./icons";

export interface MoneyDraft {
  /** `"fixed"` → one currency for the column; `"column"` → per row. */
  mode: "fixed" | "column";
  /** ISO code, when `mode === "fixed"`. Uppercased on save. */
  currency: string;
  /** Sibling text field holding the code, when `mode === "column"`. */
  currencyField: string;
  /** Major units already in a numeric column an adopted table brought with it. */
  decimalStorage: boolean;
}

export const emptyMoneyDraft = (defaultCurrency?: string): MoneyDraft => ({
  mode: "fixed",
  currency: (defaultCurrency || "USD").toUpperCase(),
  currencyField: "",
  decimalStorage: false,
});

/** Shape the stored `money` spec. Returns undefined when the draft is not
 *  usable yet, which is what the dialog's save guard tests. */
export const cleanMoney = (d: MoneyDraft): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  if (d.mode === "fixed") {
    const code = d.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return undefined;
    out.currency = code;
  } else {
    if (!d.currencyField) return undefined;
    out.currencyField = d.currencyField;
  }
  if (d.decimalStorage) out.storage = "decimal";
  return out;
};

/** Rehydrate the draft from a stored spec so re-opening Edit shows what is
 *  actually saved. */
export const moneyDraftFrom = (spec: unknown, defaultCurrency?: string): MoneyDraft => {
  const s = (spec ?? {}) as {
    currency?: string;
    currencyField?: string;
    storage?: string;
  };
  if (s.currencyField) {
    return {
      mode: "column",
      currency: (defaultCurrency || "USD").toUpperCase(),
      currencyField: s.currencyField,
      decimalStorage: s.storage === "decimal",
    };
  }
  return {
    mode: "fixed",
    currency: (s.currency || defaultCurrency || "USD").toUpperCase(),
    currencyField: "",
    decimalStorage: s.storage === "decimal",
  };
};

interface MoneyEditorProps {
  value: MoneyDraft;
  onChange: (v: MoneyDraft) => void;
  /** The collection's other fields — only a text one can hold a currency code. */
  candidates: { name: string; type?: string; label?: string }[];
  /** True for an adopted collection, where the amount column already exists and
   *  may hold major units. Managed collections never see the option: backlex
   *  creates the column, so it creates it as minor units. */
  adopted?: boolean;
  /** Admin UI locale, for the worked example below. */
  locale?: string;
}

/** The sentinel the currency dropdown uses for "type a code I don't list". */
const CUSTOM = "__custom__";

export function FieldMoneyEditor({
  value,
  onChange,
  candidates,
  adopted,
  locale = "en",
}: MoneyEditorProps) {
  const { t } = useLingui();
  const textFields = candidates.filter((f) => (f.type ?? "text") === "text");
  const listed = COMMON_CURRENCIES.some((c) => c.code === value.currency);
  const code = value.currency.trim().toUpperCase();
  const codeValid = /^[A-Z]{3}$/.test(code);
  const exponent = currencyExponent(codeValid ? code : "USD");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Currency</Trans>
        </span>
        <Select
          className="min-w-0"
          value={value.mode}
          onChange={(v) => onChange({ ...value, mode: v as MoneyDraft["mode"] })}
          options={[
            {
              value: "fixed",
              label: t`The same for every row`,
              hint: t`A price list, a payroll table — one currency for the whole column`,
            },
            {
              value: "column",
              label: t`Read from another column`,
              hint: t`Invoices billed in whatever each customer pays in`,
            },
          ]}
        />
      </div>

      {value.mode === "fixed" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            <Trans>Which currency</Trans>
          </span>
          <Select
            className="min-w-0"
            value={listed ? value.currency : CUSTOM}
            onChange={(v) =>
              onChange({ ...value, currency: v === CUSTOM ? "" : v })
            }
            options={[
              ...COMMON_CURRENCIES.map((c) => ({
                value: c.code,
                label: c.code,
                hint: c.name,
              })),
              { value: CUSTOM, label: t`Custom…`, hint: t`Any ISO-4217 code` },
            ]}
          />
          {!listed && (
            <Input
              className="font-mono uppercase"
              value={value.currency}
              placeholder="XAF"
              maxLength={3}
              aria-invalid={(value.currency !== "" && !codeValid) || undefined}
              aria-label={t`Currency code`}
              onChange={(e) =>
                onChange({ ...value, currency: e.target.value.toUpperCase() })
              }
            />
          )}
          <span className="text-[11.5px] text-muted-foreground">
            {codeValid ? (
              <Trans>
                Amounts are stored to {exponent} decimal places — e.g.{" "}
                <span className="font-mono text-foreground">
                  {formatMoney({ amount: 1234.5678, currency: code }, locale)}
                </span>
                .
              </Trans>
            ) : (
              <Trans>Enter a three-letter ISO-4217 code, like USD or TRY.</Trans>
            )}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            <Trans>Column holding the code</Trans>
          </span>
          {textFields.length === 0 ? (
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>
                This collection has no text column to read a currency code from. Add
                one first, or give this field a single fixed currency.
              </Trans>
            </span>
          ) : (
            <Select
              className="min-w-0"
              value={value.currencyField}
              placeholder={t`Pick a column`}
              onChange={(v) => onChange({ ...value, currencyField: v })}
              options={textFields.map((f) => ({
                value: f.name,
                label: f.label || f.name,
                hint: f.name,
              }))}
            />
          )}
          <div className="flex items-start gap-1.5 rounded-control border border-border bg-muted/40 px-2 py-1.5 text-[11.5px] text-muted-foreground">
            <I.Info size={12} className="mt-px shrink-0" />
            <span className="min-w-0">
              <Trans>
                Every row needs a code in this column before an amount can be saved,
                and totals over this field have to be grouped by it — adding amounts
                in different currencies together is refused rather than answered.
              </Trans>
            </span>
          </div>
        </div>
      )}

      {adopted && (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.decimalStorage}
            onChange={(e) => onChange({ ...value, decimalStorage: e.target.checked })}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12.5px] text-foreground">
              <Trans>This column already holds decimal amounts</Trans>
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>
                Tick this when the existing column stores 19.99 rather than 1999.
                backlex reads and writes it as it is, so other systems writing to the
                same table keep working — at the cost of the exactness whole numbers
                give.
              </Trans>
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

/** Whether a draft is complete enough to save. Mirrors `validateMoneySpec`
 *  server-side; the dialog uses it to gate the save button so the operator is
 *  told before the round trip rather than by a 422 after it. */
export const moneyDraftReady = (d: MoneyDraft): boolean => cleanMoney(d) !== undefined;

/** Upper bound the server enforces on a pinned exponent — re-exported so the
 *  dialog and the API cannot disagree about it. */
export { MAX_MINOR_UNIT_EXPONENT };
