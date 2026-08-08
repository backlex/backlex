
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Label } from "@backlex/ui/components/label";
import { cn } from "@backlex/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import { I } from "../../../icons";
import { Select } from "../../../select";
import { Button, } from "../../../ui";
import {
  type ApiBookingRule,
} from "../../../api";
import { DatePicker } from "@/components/date-picker";
import { TimeField } from "@/components/time-field";
import { asOneOf } from "../../../types";
import { RULE_KINDS, blankRule, isBreakRule, type DailyBreak } from "./rules";
import { WEEKDAYS, DaySet, shortWeekday, todayIn } from "./time";

export function HoursTab({
  rules,
  zone,
  editRules,
  brk,
  addOpenings,
  addBreak,
  setBreakTimes,
  toggleBreakDay,
  removeBreak,
}: {
  rules: ApiBookingRule[];
  zone: string;
  editRules: (fn: (arr: ApiBookingRule[]) => ApiBookingRule[]) => void;
  brk: DailyBreak | null;
  addOpenings: (set: DaySet) => void;
  addBreak: () => void;
  setBreakTimes: (patch: { startMinute?: number; endMinute?: number }) => void;
  toggleBreakDay: (weekday: number) => void;
  removeBreak: () => void;
}) {
  const { t } = useLingui();
  return (
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              <Trans>Opening hours</Trans>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans>
                Written in {zone}, so "Mondays 09:00" keeps meaning nine in the morning there when
                the clocks change. An "open" rule adds bookable time and a "block" takes it away; a
                span crossing midnight is two rules.
              </Trans>
            </p>
          </div>
          {/* A calendar is almost never one weekday, and adding Monday to
              Friday a row at a time is five times the work for the most
              ordinary answer there is. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="ml-auto">
                <I.Plus className="size-4" />
                <span className="max-sm:sr-only">
                  <Trans>Add rule</Trans>
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem onClick={() => addOpenings("weekdays")}>
                <Trans>Weekdays</Trans>
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                  09:00–17:00
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addOpenings("weekend")}>
                <Trans>Weekend</Trans>
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                  09:00–17:00
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addOpenings("all")}>
                <Trans>Every day</Trans>
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                  09:00–17:00
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => editRules((arr) => [...arr, blankRule()])}>
                <Trans>One day</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* The break, as one thing rather than as one row per day. It is not
            a field of its own — it IS these block rules — so the card says
            where they are kept and hands them back to the list the moment it
            stops being able to speak for them. */}
        <div className="rounded-md border border-dashed p-3">
          {brk ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  <Trans>Daily break</Trans>
                </span>
                <div className="flex items-center gap-1.5">
                  <TimeField
                    aria-label={t`Break starts at`}
                    className="w-[92px]"
                    value={brk.startMinute}
                    onChange={(m) => setBreakTimes({ startMinute: m })}
                  />
                  <span className="text-muted-foreground">–</span>
                  <TimeField
                    aria-label={t`Break ends at`}
                    className="w-[92px]"
                    value={brk.endMinute}
                    onChange={(m) => setBreakTimes({ endMinute: m })}
                  />
                </div>
                <Button variant="outline" className="ml-auto" onClick={removeBreak}>
                  <I.Trash className="size-4" />
                  <span className="max-sm:sr-only">
                    <Trans>Remove</Trans>
                  </span>
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
                  const on = brk.weekdays.includes(wd);
                  return (
                    <button
                      key={wd}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleBreakDay(wd)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors",
                        on
                          ? "border-primary/40 bg-primary/20 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {shortWeekday(wd)}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Taken out of every opening on the days above. Stored as one closed rule per day
                  — edit it here and they all move together.
                </Trans>
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  <Trans>Daily break</Trans>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  <Trans>
                    A lunch hour, say — closed on every day you are otherwise open, without
                    splitting each opening in two.
                  </Trans>
                </p>
              </div>
              <Button variant="outline" className="ml-auto" onClick={addBreak}>
                <I.Plus className="size-4" />
                <span className="max-sm:sr-only">
                  <Trans>Add a break</Trans>
                </span>
              </Button>
            </div>
          )}
        </div>

        {rules.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <Trans>No hours — the public page has nothing to offer.</Trans>
          </p>
        ) : (
          rules.map((r, i) =>
            // Drawn on the card above instead; drawing it twice would offer
            // two places to change one thing.
            isBreakRule(r, brk) ? null : (
            <div
              key={i}
              className="grid gap-2 rounded-md border p-2 sm:grid-cols-[110px_140px_1fr_1fr_auto]"
            >
              <Select
                value={r.kind}
                onChange={(v) =>
                  editRules((arr) =>
                    arr.map((x, j) => (j === i ? { ...x, kind: asOneOf(RULE_KINDS, v, "open") } : x)),
                  )
                }
                className="min-w-0"
                options={[
                  { value: "open", label: t`Open` },
                  { value: "block", label: t`Block` },
                ]}
              />
              <Select
                value={r.weekday === null ? "" : String(r.weekday)}
                onChange={(v) =>
                  editRules((arr) =>
                    arr.map((x, j) => {
                      if (j !== i) return x;
                      if (v !== "") return { ...x, weekday: Number(v) };
                      // Turning a rule on to dates asks a question nobody has
                      // answered yet — an empty range here is not a mistake to
                      // shout about, so the rule arrives already meaning
                      // "today". Autosave stays unblocked and the operator
                      // moves the day rather than being told off for the click
                      // they just made.
                      const from = x.startsOn ?? todayIn(zone);
                      return { ...x, weekday: null, startsOn: from, endsOn: x.endsOn ?? from };
                    }),
                  )
                }
                className="min-w-0"
                options={[...WEEKDAYS, { value: "", label: t`Specific dates` }]}
              />
              <TimeField
                aria-label={t`Opens at`}
                value={r.startMinute}
                onChange={(m) =>
                  editRules((arr) => arr.map((x, j) => (j === i ? { ...x, startMinute: m } : x)))
                }
              />
              <TimeField
                aria-label={t`Closes at`}
                value={r.endMinute}
                onChange={(m) =>
                  editRules((arr) => arr.map((x, j) => (j === i ? { ...x, endMinute: m } : x)))
                }
              />
              <Button
                variant="outline"
                onClick={() => editRules((arr) => arr.filter((_, j) => j !== i))}
              >
                <I.Trash className="size-4" />
                <span className="sr-only">
                  <Trans>Remove rule</Trans>
                </span>
              </Button>
              {r.weekday === null && (
                <div className="grid gap-2 sm:col-span-5 sm:grid-cols-2">
                  {/* Two bare date boxes side by side never said which end was
                      which. Either may stand alone — a start with no end runs
                      on forever, an end with no start covers everything up to
                      it — so both carry a label. */}
                  <div className="grid gap-1">
                    <Label className="text-[11px] font-normal text-muted-foreground">
                      <Trans>First day</Trans>
                    </Label>
                    <DatePicker
                      dateOnly
                      value={r.startsOn}
                      placeholder={t`Any day up to the end`}
                      onChange={(d) =>
                        editRules((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, startsOn: d } : x)),
                        )
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-[11px] font-normal text-muted-foreground">
                      <Trans>Last day</Trans>
                    </Label>
                    <DatePicker
                      dateOnly
                      value={r.endsOn}
                      placeholder={t`No end`}
                      onChange={(d) =>
                        editRules((arr) => arr.map((x, j) => (j === i ? { ...x, endsOn: d } : x)))
                      }
                    />
                  </div>
                </div>
              )}
            </div>
            ),
          )
        )}
      </Card>
  );
}
