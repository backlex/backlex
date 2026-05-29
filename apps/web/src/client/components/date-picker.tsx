import { useState } from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { Calendar } from "@backlex/ui/components/calendar";
import { Input } from "@backlex/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@backlex/ui/components/popover";
import { Label } from "@backlex/ui/components/label";

interface DatePickerProps {
  value: string | number | null | undefined;
  onChange: (iso: string | null) => void;
  /** When true, also expose hh:mm input. Default true. */
  withTime?: boolean;
}

const toDate = (v: string | number | null | undefined): Date | undefined => {
  if (v === null || v === undefined) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const pad = (n: number) => String(n).padStart(2, "0");
const toTimeString = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Calendar + Popover + optional time input. Emits ISO 8601 strings on change
 * (or null when cleared). Suitable for `timestamp` collection fields.
 */
export const DatePicker = ({ value, onChange, withTime = true }: DatePickerProps) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const date = toDate(value);
  const time = date ? toTimeString(date) : "00:00";

  const fmtLabel = (d: Date | undefined, wt: boolean): string => {
    if (!d) return t`Pick a date…`;
    return wt
      ? `${d.toLocaleDateString()} ${toTimeString(d)}`
      : d.toLocaleDateString();
  };

  const setDate = (d: Date | undefined) => {
    if (!d) {
      onChange(null);
      return;
    }
    if (withTime && date) {
      d.setHours(date.getHours(), date.getMinutes(), 0, 0);
    } else if (withTime) {
      d.setHours(0, 0, 0, 0);
    }
    onChange(d.toISOString());
  };

  const setTime = (t: string) => {
    const [hh, mm] = t.split(":").map(Number);
    const next = date ? new Date(date) : new Date();
    next.setHours(hh ?? 0, mm ?? 0, 0, 0);
    onChange(next.toISOString());
  };

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-start">
            <CalendarIcon className="mr-2 size-4" />
            <span className={date ? "" : "text-muted-foreground"}>
              {fmtLabel(date, withTime)}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={(d) => {
              setDate(d);
            }}
            autoFocus
          />
          {withTime && (
            <div className="flex items-center gap-2 border-t p-3">
              <Label className="text-xs text-muted-foreground"><Trans>Time</Trans></Label>
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-auto"
              />
            </div>
          )}
        </PopoverContent>
      </Popover>
      {date && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={t`Clear`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
};
