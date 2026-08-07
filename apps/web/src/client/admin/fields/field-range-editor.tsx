// Shared period editor — the Period tab of the Add / Edit field dialogs, shown
// for the date / datetime interfaces.
//
// There is deliberately no value editor to go with this, and that is a
// consequence of the design rather than an omission: a period is DECLARED over
// two timestamp columns that already exist, so both keep rendering as the
// ordinary date inputs they already were. Nothing about the form changes. What
// the declaration buys is on the query side — `_overlaps` / `_covers`, a NULL
// endpoint read as an OPEN one, and a write-time check that the period is
// ordered.
//
// The one genuinely consequential control here is `bounds`, so it is the one
// stated in plain language rather than as brackets: whether a period ending when
// another begins counts as a clash decides whether a room can be booked
// back-to-back, and getting it wrong is invisible until something double-books.
import { Trans, useLingui } from "@lingui/react/macro";
import { Select } from "../select";
import { Checkbox } from "../ui";

export interface RangeDraft {
  /** Sibling column holding the end, or "" for "this is not a period". */
  end: string;
  /** True = closed `[]` (a range of days). False = half-open `[)` (instants). */
  inclusiveEnd: boolean;
  /** Enforce end-after-start on write. */
  ordered: boolean;
}

export const emptyRangeDraft = (): RangeDraft => ({
  end: "",
  inclusiveEnd: false,
  ordered: true,
});

/** Shape the stored `range` spec, or `undefined` when no end column was picked —
 *  a period with no end column is not a period. */
export const cleanRange = (d: RangeDraft): Record<string, unknown> | undefined => {
  if (!d.end) return undefined;
  const out: Record<string, unknown> = { end: d.end };
  // `[)` is the default, so storing it says nothing.
  if (d.inclusiveEnd) out.bounds = "[]";
  // …and so is `ordered: true`.
  if (!d.ordered) out.ordered = false;
  return out;
};

/** Rehydrate the draft from a stored spec, so re-opening Edit shows what is
 *  actually saved rather than an empty form. */
export const rangeDraftFrom = (spec: unknown): RangeDraft => {
  const s = (spec ?? {}) as { end?: string; bounds?: string; ordered?: boolean };
  return {
    end: typeof s.end === "string" ? s.end : "",
    inclusiveEnd: s.bounds === "[]",
    ordered: s.ordered !== false,
  };
};

interface RangeEditorProps {
  value: RangeDraft;
  onChange: (v: RangeDraft) => void;
  /** The collection's other fields — only a timestamp can end a period. */
  candidates: { name: string; type?: string; label?: string }[];
  /** The interface of the field being edited, which is what makes the default
   *  bounds a good one rather than a coin toss. */
  interfaceId?: string;
}

export function FieldRangeEditor({
  value,
  onChange,
  candidates,
  interfaceId,
}: RangeEditorProps) {
  const { t } = useLingui();
  const endOptions = candidates.filter((f) => (f.type ?? "") === "timestamp");
  const isDayRange = interfaceId === "date";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>This period ends at</Trans>
        </span>
        <Select
          value={value.end}
          onChange={(v: string) => onChange({ ...value, end: v })}
          placeholder={t`Not a period`}
          options={[
            { value: "", label: t`Not a period` },
            ...endOptions.map((f) => ({
              value: f.name,
              label: f.label ? `${f.label} (${f.name})` : f.name,
            })),
          ]}
        />
        <span className="text-[11.5px] text-muted-foreground">
          {endOptions.length === 0 ? (
            <Trans>
              This collection has no other date column to end a period at.
            </Trans>
          ) : (
            <Trans>
              Pick the column holding the end. Both columns stay exactly as they
              are — declaring the pair is what makes overlap searches possible.
            </Trans>
          )}
        </span>
      </div>

      {value.end && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-foreground">
              <Trans>When one period ends exactly as another begins</Trans>
            </span>
            <Select
              value={value.inclusiveEnd ? "closed" : "half"}
              onChange={(v: string) => onChange({ ...value, inclusiveEnd: v === "closed" })}
              options={[
                {
                  value: "half",
                  label: t`They do not clash — the end is not inside the period`,
                },
                {
                  value: "closed",
                  label: t`They clash — the end day is inside the period`,
                },
              ]}
            />
            <span className="text-[11.5px] text-muted-foreground">
              {isDayRange ? (
                <Trans>
                  For whole days, pick the second: leave "through Friday" includes
                  Friday, so another request starting Friday really does clash.
                </Trans>
              ) : (
                <Trans>
                  For times, pick the first: a room booked 09:00–10:00 and one
                  booked 10:00–11:00 must both be allowed.
                </Trans>
              )}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-control px-1 py-1 hover:bg-muted/50">
              <Checkbox
                checked={value.ordered}
                onChange={() => onChange({ ...value, ordered: !value.ordered })}
              />
              <span className="min-w-0 text-[12.5px] text-foreground">
                <Trans>Refuse a row whose end is before its start</Trans>
              </span>
            </label>
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>
                Leave this on unless the two dates are genuinely independent. An
                empty end is always allowed — it means the period has not finished,
                and searches treat it as still running.
              </Trans>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
