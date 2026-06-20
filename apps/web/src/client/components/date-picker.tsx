import { useState } from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { Calendar } from "@backlex/ui/components/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { Popover, PopoverContent, PopoverTrigger } from "@backlex/ui/components/popover";
import { Label } from "@backlex/ui/components/label";
import { cn } from "@backlex/ui/lib/utils";

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

const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full min-w-0 justify-start">
            <CalendarIcon className="mr-2 size-4 shrink-0" />
            <span className={cn("truncate", date ? "" : "text-muted-foreground")}>
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
              <div className="flex items-center gap-1">
                <Select value={time.split(":")[0] ?? "00"} onValueChange={(h) => setTime(`${h}:${time.split(":")[1] ?? "00"}`)}>
                  <SelectTrigger size="sm" className="w-[68px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">:</span>
                <Select value={time.split(":")[1] ?? "00"} onValueChange={(m) => setTime(`${time.split(":")[0] ?? "00"}:${m}`)}>
                  <SelectTrigger size="sm" className="w-[68px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MINUTES.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
