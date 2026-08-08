import type { PushToast } from "../../../types";
import { useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { cn } from "@backlex/ui/lib/utils";
import { I } from "../../../icons";
import { Button, } from "../../../ui";
import {
  type ApiBookingResource,
} from "../../../api";
import {
  type PublicFont,
  type PublicTheme,
} from "@/lib/public-theme";
import { shortInZone } from "./time";

export const PUBLIC_THEMES: readonly PublicTheme[] = ["dark", "light"];

export const PUBLIC_FONTS: readonly PublicFont[] = ["sans", "lexend", "mono", "system"];

export const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  confirmed: "default",
  held: "secondary",
  completed: "outline",
  cancelled: "destructive",
  no_show: "destructive",
  expired: "outline",
};

/** How many rows one page of the booking list holds. */
export const PAGE_SIZE = 20;

/** The five things a resource is managed through. Order is the order of the
 *  work: publish hours, decide what to ask, watch who comes, hand out the
 *  link, then the knobs you set once. */
export const TABS = ["hours", "questions", "bookings", "share", "settings"] as const;

export type Tab = (typeof TABS)[number];

/**
 * The public link, for as long as this tab is open.
 *
 * Module-level rather than state, and deliberately not persisted: only the
 * hash reaches the server, so this is the single copy in existence and it dies
 * with the page. Keyed by resource key. Mirrors the forms page's own cache.
 */
export const tokenCache = new Map<string, string>();

export function StatTile({
  label,
  value,
  sub,
  /** A time reads at body size — only counts get the display size, or the tile
   *  truncates the one thing it was drawn to say. */
  size = "lg",
}: {
  label: string;
  value: string;
  sub: string;
  size?: "lg" | "sm";
}) {
  return (
    <Card className="min-w-0 gap-0 px-[15px] py-3.5">
      <div className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-semibold leading-tight tabular-nums tracking-[-0.02em]",
          size === "lg" ? "text-[25px]" : "truncate py-[5px] text-[15px]",
        )}
      >
        {value}
      </div>
      <div className="truncate text-[11.5px] text-muted-foreground">{sub}</div>
    </Card>
  );
}

/** A link that is shown once. Selecting 60 characters of URL by hand is not a
 *  copy mechanism, so the button is part of the field rather than beside it. */
export function CopyLink({ value, pushToast }: { value: string; pushToast: PushToast }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        pushToast(t`Link copied.`);
        setTimeout(() => setCopied(false), 2000);
      },
      () => pushToast(t`Could not reach the clipboard — select the link and copy it.`),
    );
  };
  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 font-mono text-xs"
      />
      <Button variant="outline" className="shrink-0" onClick={copy}>
        {copied ? <I.Check className="size-4" /> : <I.Copy className="size-4" />}
        <span className="max-sm:sr-only">{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}</span>
      </Button>
    </div>
  );
}

/** One labelled line of the booking detail. Absent values are dashed rather
 *  than dropped, so the shape of the record stays readable. */
export function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** Live / paused, in the shape the forms list uses for the same fact. */
function LivePill({ active }: { active: boolean }) {
  return active ? (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-emerald-400">
      <Trans>live</Trans>
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-border bg-white/5 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
      <Trans>paused</Trans>
    </span>
  );
}

/**
 * One resource, as the list draws it.
 *
 * The three numbers and the bar come from a second read that lands after the
 * cards do, so `stats` is optional and the card shows its own skeleton in that
 * gap rather than a zero — "0 upcoming" and "not counted yet" are different
 * facts and a calendar owner acts differently on each.
 */
export function ResourceCard({
  resource,
  stats,
  onOpen,
}: {
  resource: ApiBookingResource;
  stats: { booked: number; free: number; nextFree: string | null } | undefined;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const total = stats ? stats.booked + stats.free : 0;
  const pct = stats && total > 0 ? Math.round((stats.booked / total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-3 rounded-surface border border-border bg-card p-4 text-left transition-colors hover:border-primary/50"
    >
      <div className="flex w-full items-center gap-2.5">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] bg-primary/10 text-primary">
          <I.CalendarDays size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{resource.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {resource.timeZone} · {resource.slotMinutes}m
          </div>
        </div>
        <LivePill active={resource.active} />
      </div>

      <div className="flex w-full items-center justify-between border-t border-border pt-2.5 text-[13px]">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <Trans>Rules</Trans>
          </div>
          <div className="font-semibold tabular-nums">{resource.rules.length}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <Trans>Upcoming</Trans>
          </div>
          <div className="font-semibold tabular-nums">
            {stats ? stats.booked : <Skeleton className="h-4 w-6" />}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <Trans>Next free</Trans>
          </div>
          <div className="truncate font-semibold tabular-nums" title={t`Next free slot`}>
            {stats ? (
              stats.nextFree ? (
                shortInZone(stats.nextFree, resource.timeZone)
              ) : (
                "—"
              )
            ) : (
              <Skeleton className="ml-auto h-4 w-16" />
            )}
          </div>
        </div>
      </div>

      {/* How full the next week is. Drawn even at 0% so the row of cards keeps
          one baseline — a bar that appears only on busy calendars makes the
          quiet ones look like a different card. */}
      <div className="flex w-full items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${stats ? pct : 0}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {stats && total > 0 ? `${pct}%` : "—"}
        </span>
      </div>
    </button>
  );
}
