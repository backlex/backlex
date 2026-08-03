// @ts-nocheck
// Shared sequence editor — the Numbering tab of the Add / Edit field dialogs,
// shown for the `sequence` interface. A sequence column is a document number
// the server issues on insert (INV-2026-0001), so nothing here is free text the
// user has to get right: the prefix is the only thing typed, and everything
// else — how the number is shaped, how wide it is, whether it restarts — is
// picked from a list and composed into the stored `pattern`.
//
// The raw pattern grammar is still reachable through "Custom pattern", because
// the composed form deliberately does not cover every arrangement (a trailing
// suffix, a day token, `{YY}`). What it does cover is every shape the schema
// templates actually use.
//
// NOTE for future edits: pattern examples must never go inside <Trans>. A
// literal brace in a Lingui message is an ICU parse error, and it takes the
// whole admin SPA down with a blank page — see the `INV-{YYYY}` strings below,
// which are all plain JSX expressions for exactly that reason.
import { useMemo } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { renderSequenceValue, sequencePreview } from "@backlex/db/sequence";
import { Select } from "./select";
import { offsetLabel, supportedTimeZones } from "./preferences";

/** How the counter is framed. Each shape maps to a fixed token arrangement. */
export type SequenceShape = "plain" | "year" | "year_month" | "custom";

export interface SequenceDraft {
  shape: SequenceShape;
  /** Literal text before the number, e.g. "INV-". Unused when shape=custom. */
  prefix: string;
  /** Counter width — the number of `#` in the token. */
  digits: number;
  /** First number in a fresh series. */
  start: number;
  /** Restart the counter each period. Only offered when the shape carries a
   *  date token, because restarting without one reissues last year's numbers. */
  restart: boolean;
  /** Raw pattern, used when shape=custom. */
  pattern: string;
  /** IANA zone the date tokens and the restart boundary resolve in. */
  timezone: string;
}

export const emptySequenceDraft = (defaultTimezone = "UTC"): SequenceDraft => ({
  shape: "year",
  prefix: "INV-",
  digits: 4,
  start: 1,
  restart: true,
  pattern: "",
  timezone: defaultTimezone || "UTC",
});

const hashes = (n: number) => "#".repeat(Math.max(1, Math.min(12, n)));

/** Compose the stored pattern from the shape controls. */
const composePattern = (d: SequenceDraft): string => {
  const n = `{${hashes(d.digits)}}`;
  if (d.shape === "custom") return d.pattern.trim();
  if (d.shape === "year") return `${d.prefix}{YYYY}-${n}`;
  if (d.shape === "year_month") return `${d.prefix}{YYYY}{MM}-${n}`;
  return `${d.prefix}${n}`;
};

/** Does this shape put the period into the rendered value? Only then may the
 *  counter restart — the server rejects the other combination outright. */
const shapeHasDate = (d: SequenceDraft): boolean =>
  d.shape === "year" || d.shape === "year_month" ||
  (d.shape === "custom" && /\{(YYYY|YY)\}/.test(d.pattern));

const resetOf = (d: SequenceDraft): "never" | "yearly" | "monthly" => {
  if (!d.restart || !shapeHasDate(d)) return "never";
  if (d.shape === "year_month") return "monthly";
  if (d.shape === "custom") return /\{MM\}/.test(d.pattern) ? "monthly" : "yearly";
  return "yearly";
};

/** Recover the shape controls from a stored `sequence` object. A pattern this
 *  editor did not compose falls back to custom mode rather than being
 *  approximated — round-tripping someone's exact pattern matters more than
 *  showing them friendly dropdowns. */
export const sequenceToDraft = (v: unknown, defaultTimezone = "UTC"): SequenceDraft => {
  const base = emptySequenceDraft(defaultTimezone);
  if (!v || typeof v !== "object") return base;
  const o = v as Record<string, unknown>;
  const pattern = typeof o.pattern === "string" ? o.pattern : "";
  const start = typeof o.start === "number" ? o.start : 1;
  const timezone = typeof o.timezone === "string" && o.timezone ? o.timezone : defaultTimezone;
  const reset = typeof o.reset === "string" ? o.reset : "never";

  const m =
    /^(.*)\{(#+)\}$/.exec(pattern) ??
    null;
  if (m) {
    const head = m[1];
    const digits = m[2].length;
    let shape: SequenceShape | null = null;
    let prefix = "";
    const ym = /^(.*)\{YYYY\}\{MM\}-$/.exec(head);
    const y = /^(.*)\{YYYY\}-$/.exec(head);
    if (ym) { shape = "year_month"; prefix = ym[1]; }
    else if (y) { shape = "year"; prefix = y[1]; }
    else if (!/[{}]/.test(head)) { shape = "plain"; prefix = head; }
    if (shape) {
      return { shape, prefix, digits, start, restart: reset !== "never", pattern, timezone };
    }
  }
  return { ...base, shape: "custom", pattern, start, restart: reset !== "never", timezone };
};

/** Compile a draft into the stored `sequence` object, or undefined when it is
 *  not yet usable. `undefined` is what the dialog treats as "this tab is
 *  incomplete", so returning it for an unrenderable pattern is what stops a
 *  half-typed `{YYY` being saved. */
export const cleanSequence = (d: SequenceDraft): Record<string, unknown> | undefined => {
  const pattern = composePattern(d);
  if (!pattern) return undefined;
  try {
    // The renderer is the validator: if it cannot produce a value, neither can
    // the server, and this is the same code that will run on every insert.
    renderSequenceValue({ pattern, timezone: d.timezone }, 1, new Date());
  } catch {
    return undefined;
  }
  const reset = resetOf(d);
  return {
    pattern,
    ...(d.start !== 1 ? { start: d.start } : {}),
    ...(reset !== "never" ? { reset } : {}),
    ...(d.timezone && d.timezone !== "UTC" ? { timezone: d.timezone } : {}),
  };
};

export function FieldSequenceEditor({
  value,
  onChange,
}: {
  value: SequenceDraft;
  onChange: (d: SequenceDraft) => void;
}) {
  const { t } = useLingui();
  const set = (patch: Partial<SequenceDraft>) => onChange({ ...value, ...patch });

  const pattern = composePattern(value);
  const withDate = shapeHasDate(value);

  const preview = useMemo(() => {
    try {
      return sequencePreview(
        { pattern, start: value.start, timezone: value.timezone },
        new Date(),
        3,
      );
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [pattern, value.start, value.timezone]);

  const zones = useMemo(
    () =>
      supportedTimeZones().map((z) => {
        const off = offsetLabel(z);
        return { value: z, label: z, ...(off ? { hint: off } : {}) };
      }),
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        <Trans>
          backlex issues this value when the row is created — it is read-only through the API and
          never changes afterwards. Numbers are unique and always go up; if a create fails, the
          number it took is skipped rather than reused.
        </Trans>
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium"><Trans>Format</Trans></span>
          <Select
            value={value.shape}
            onChange={(v) => set({ shape: v as SequenceShape })}
            className="min-w-0"
            options={[
              { value: "plain", label: t`Prefix + number`, hint: "INV-0001" },
              { value: "year", label: t`Prefix + year + number`, hint: "INV-2026-0001" },
              { value: "year_month", label: t`Prefix + year, month + number`, hint: "INV-202608-0001" },
              { value: "custom", label: t`Custom pattern…`, hint: t`write the tokens yourself` },
            ]}
          />
        </label>

        {value.shape === "custom" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium"><Trans>Pattern</Trans></span>
            <Input
              value={value.pattern}
              onChange={(e) => set({ pattern: e.target.value })}
              placeholder="INV-{YYYY}-{####}"
              className="min-w-0 font-mono"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium"><Trans>Prefix</Trans></span>
            <Input
              value={value.prefix}
              onChange={(e) => set({ prefix: e.target.value })}
              placeholder="INV-"
              className="min-w-0 font-mono"
            />
          </label>
        )}
      </div>

      {value.shape === "custom" && (
        <p className="text-muted-foreground text-[11px]">
          <Trans>Tokens:</Trans>{" "}
          <code className="font-mono">{"{YYYY}"}</code>,{" "}
          <code className="font-mono">{"{YY}"}</code>,{" "}
          <code className="font-mono">{"{MM}"}</code>,{" "}
          <code className="font-mono">{"{DD}"}</code>{" "}
          <Trans>and a run of</Trans> <code className="font-mono">#</code>{" "}
          <Trans>for the counter, padded to its width — e.g.</Trans>{" "}
          <code className="font-mono">{"INV-{YYYY}-{####}"}</code>.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        {value.shape !== "custom" && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium"><Trans>Digits</Trans></span>
            <Select
              value={String(value.digits)}
              onChange={(v) => set({ digits: Number(v) })}
              className="min-w-0"
              options={[3, 4, 5, 6].map((n) => ({
                value: String(n),
                label: String(n),
                hint: `${"0".repeat(n - 1)}1`,
              }))}
            />
            <span className="text-muted-foreground text-[11px]">
              <Trans>A number that outgrows this simply gets wider — nothing is cut off.</Trans>
            </span>
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium"><Trans>Start at</Trans></span>
          <Input
            type="number"
            min={0}
            value={String(value.start)}
            onChange={(e) => set({ start: Math.max(0, Number(e.target.value) || 0) })}
            className="min-w-0"
          />
          <span className="text-muted-foreground text-[11px]">
            <Trans>The first number this series issues. Existing rows are not renumbered.</Trans>
          </span>
        </label>
      </div>

      {withDate && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium"><Trans>Restart the count</Trans></span>
            <Select
              value={value.restart ? "yes" : "no"}
              onChange={(v) => set({ restart: v === "yes" })}
              className="min-w-0"
              options={[
                {
                  value: "yes",
                  label:
                    resetOf({ ...value, restart: true }) === "monthly"
                      ? t`Every month`
                      : t`Every year`,
                  hint: t`back to the starting number`,
                },
                { value: "no", label: t`Never`, hint: t`keep counting up forever` },
              ]}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium"><Trans>Calendar time zone</Trans></span>
            <Select
              value={value.timezone}
              onChange={(v) => set({ timezone: v })}
              className="min-w-0"
              options={zones}
            />
            <span className="text-muted-foreground text-[11px]">
              <Trans>
                Which clock decides the year and the restart. Stored with the field, so changing
                your display time zone later never renumbers anything.
              </Trans>
            </span>
          </label>
        </div>
      )}

      <div className="rounded-md border bg-muted/40 p-3">
        <div className="text-xs font-medium">
          <Trans>The first numbers this field will issue</Trans>
        </div>
        {Array.isArray(preview) ? (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {preview.map((v) => (
              <code key={v} className="rounded bg-background px-2 py-1 font-mono text-xs">
                {v}
              </code>
            ))}
          </div>
        ) : (
          <div className="mt-1.5 text-destructive text-xs">{preview.error}</div>
        )}
      </div>
    </div>
  );
}
