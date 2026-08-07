import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { cn } from "@backlex/ui/lib/utils";

/**
 * A time of day, held as minutes from local midnight.
 *
 * Opening hours are a finite set with an overwhelmingly common answer — the
 * quarter hours — so the control offers them rather than asking anyone to type
 * a clock. Typing one was the older shape and it fought back: the field was
 * controlled by the PARSED value, so clearing "09:00" to type "9:30" put
 * "09:00" straight back and the box read as frozen.
 *
 * Minutes are still open-ended on the wire, so "Custom…" hands the same slot a
 * text box; a value already off the grid (an opening at 09:20 saved before
 * this, or by the API) is merged into the list in its own place so it stays
 * pickable rather than being silently rounded away.
 */

const DAY = 24 * 60;

const pad = (n: number) => String(n).padStart(2, "0");

export const minutesToClock = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

export const clockToMinutes = (raw: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]) * 60 + Number(m[2]);
  return value >= 0 && value <= DAY ? value : null;
};

/** Radix reads "" as "nothing selected", so the escape hatch needs a value of
 *  its own that no clock can collide with. */
const CUSTOM = "__custom__";

export interface TimeFieldProps {
  /** Minutes from midnight, 0..1440. 1440 is midnight at the far end. */
  value: number;
  onChange: (minutes: number) => void;
  /** Spacing of the offered times, in minutes. */
  step?: number;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}

export function TimeField({
  value,
  onChange,
  step = 15,
  className,
  "aria-label": label,
  disabled,
}: TimeFieldProps) {
  const { t } = useLingui();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(() => minutesToClock(value));

  if (typing) {
    return (
      <Input
        autoFocus
        disabled={disabled}
        aria-label={label}
        className={cn("font-mono tabular-nums", className)}
        placeholder="09:00"
        value={draft}
        onChange={(e) => {
          // The draft is what is on screen; the rule only moves once what is
          // typed is actually a time.
          setDraft(e.target.value);
          const m = clockToMinutes(e.target.value);
          if (m !== null) onChange(m);
        }}
        onBlur={() => {
          // A half-typed clock is not a time — put back the one the rule
          // actually holds rather than leaving the field claiming otherwise.
          if (clockToMinutes(draft) === null) setDraft(minutesToClock(value));
          setTyping(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
    );
  }

  const current = minutesToClock(value);
  const times: string[] = [];
  for (let m = 0; m <= DAY; m += step) times.push(minutesToClock(m));
  if (!times.includes(current)) {
    times.push(current);
    times.sort();
  }

  return (
    <Select
      value={current}
      disabled={disabled}
      onValueChange={(v) => {
        if (v === CUSTOM) {
          setDraft(current);
          setTyping(true);
          return;
        }
        const m = clockToMinutes(v);
        if (m !== null) onChange(m);
      }}
    >
      <SelectTrigger
        aria-label={label}
        className={cn("w-full min-w-0 justify-between font-mono tabular-nums", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-[280px]">
        {times.map((clock) => (
          <SelectItem key={clock} value={clock} className="font-mono tabular-nums">
            {clock}
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM}>{t`Custom…`}</SelectItem>
      </SelectContent>
    </Select>
  );
}
