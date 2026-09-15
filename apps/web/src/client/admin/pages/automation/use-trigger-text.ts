import type { ScheduleOffsetUnit } from "@backlex/core";
import { useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "../../icons";
import { readTrigger, type CronCadence } from "./flow-trigger-view";

/** A trigger in words. The flows list, its preview node and the builder's
 *  trigger node all read from one of these, so no two describe a flow
 *  differently. */
export type TriggerText = {
  icon: IconComponent;
  /** What starts the flow: "Item created", "Every day at 03:00", "3 days before". */
  title: string;
  /** The identifier it acts on, set in mono: a collection, `collection.field`, a cron pattern. */
  target: string | null;
  /** What qualifies it: a schedule's wall clock and its filter count. */
  meta: string | null;
  /** False where the title already says the target in words — a cron cadence
   *  next to its own pattern would say the same thing twice on one line. */
  rowTarget: boolean;
  /** The whole reading on one line, for the tooltip a truncated line needs. */
  summary: string;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (hour: number, minute: number) => `${pad2(hour)}:${pad2(minute)}`;
const INTL_UNIT: Record<ScheduleOffsetUnit, string> = { minutes: "minute", hours: "hour", days: "day", weeks: "week" };

export function useTriggerText(): (trigger: string) => TriggerText {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";
  // Intl carries the plural and the unit word ("1 day" / "3 days", "3 gün"),
  // which a template string per unit and count would have to spell out.
  const amount = (value: number, unit: ScheduleOffsetUnit) => {
    try {
      return new Intl.NumberFormat(locale, { style: "unit", unit: INTL_UNIT[unit], unitDisplay: "long" }).format(value);
    } catch {
      return `${value} ${unit}`;
    }
  };
  // 2024-01-07 was a Sunday, so cron's day 0–6 lands on the matching name.
  const weekday = (day: number, width: "long" | "short") => {
    try {
      return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + day)));
    } catch {
      return String(day);
    }
  };
  const joined = (parts: string[]) => {
    try {
      return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
    } catch {
      return parts.join(", ");
    }
  };

  const cadence = (c: CronCadence): string => {
    switch (c.every) {
      case "minute": {
        const n = c.step;
        return n === 1 ? t`Every minute` : t`Every ${n} minutes`;
      }
      case "hour": {
        const n = c.step;
        const minute = `:${pad2(c.minute)}`;
        if (n === 1) return c.minute === 0 ? t`Every hour` : t`Every hour at ${minute}`;
        return c.minute === 0 ? t`Every ${n} hours` : t`Every ${n} hours at ${minute}`;
      }
      case "day": {
        const time = clock(c.hour, c.minute);
        return t`Every day at ${time}`;
      }
      case "weekdays": {
        const time = clock(c.hour, c.minute);
        return t`Weekdays at ${time}`;
      }
      case "week": {
        const time = clock(c.hour, c.minute);
        const days = joined(c.days.map((d) => weekday(d, c.days.length === 1 ? "long" : "short")));
        return t`Every ${days} at ${time}`;
      }
      case "month": {
        const time = clock(c.hour, c.minute);
        const day = c.day;
        return t`Monthly on day ${day} at ${time}`;
      }
    }
  };

  return (trigger) => {
    const view = readTrigger(trigger);
    const text = ((): Omit<TriggerText, "summary"> => {
      switch (view.kind) {
        case "item": {
          const icon = view.event === "created" ? I.Plus : view.event === "updated" ? I.Pencil : view.event === "deleted" ? I.Trash : I.Database;
          const title =
            view.event === "created" ? t`Item created`
            : view.event === "updated" ? t`Item updated`
            : view.event === "deleted" ? t`Item deleted`
            : t`Any item change`;
          return view.collection
            ? { icon, title, target: view.collection, meta: null, rowTarget: true }
            : { icon, title, target: null, meta: t`any collection`, rowTarget: true };
        }
        case "transition": {
          const anyValue = t`any`;
          const target = [view.collection, view.field].filter(Boolean).join(".") || null;
          const facts = [
            view.collection ? null : t`any collection`,
            view.from || view.to ? `${view.from ?? anyValue} → ${view.to ?? anyValue}` : null,
          ].filter((fact): fact is string => fact !== null);
          return { icon: I.ArrowRight, title: t`Status change`, target, meta: facts.join(" · ") || null, rowTarget: true };
        }
        case "cron":
          return view.cadence
            ? { icon: I.Clock, title: cadence(view.cadence), target: view.pattern, meta: null, rowTarget: false }
            : { icon: I.Clock, title: t`Custom schedule`, target: view.pattern, meta: null, rowTarget: true };
        case "schedule": {
          const { collection, field, offset, at, timeZone } = view.spec;
          const n = amount(offset.value, offset.unit);
          const title = offset.value === 0 ? t`On the date` : offset.direction === "before" ? t`${n} before` : t`${n} after`;
          const count = view.filters;
          const facts = [
            // A null zone is UTC to the scheduler, so it is said, not implied.
            at === null ? null : `${clock(Math.floor(at / 60), at % 60)} ${timeZone ?? "UTC"}`,
            count === 0 ? null : count === 1 ? t`1 filter` : t`${count} filters`,
          ].filter((fact): fact is string => fact !== null);
          return { icon: I.CalendarClock, title, target: `${collection}.${field}`, meta: facts.join(" · ") || null, rowTarget: true };
        }
        case "webhook":
          return { icon: I.Webhook, title: t`Incoming webhook`, target: null, meta: null, rowTarget: true };
        case "signup":
          return { icon: I.Users, title: t`User signed up`, target: null, meta: null, rowTarget: true };
        case "manual":
          return { icon: I.Play, title: t`Run manually`, target: null, meta: null, rowTarget: true };
        case "event":
          return { icon: I.Bolt, title: t`Event`, target: view.key, meta: null, rowTarget: true };
        case "unknown":
          return { icon: I.AlertTriangle, title: t`Unreadable trigger`, target: view.raw || null, meta: null, rowTarget: true };
      }
    })();
    return { ...text, summary: [text.title, text.target, text.meta].filter(Boolean).join(" · ") };
  };
}
