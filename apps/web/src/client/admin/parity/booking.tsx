// @ts-nocheck
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@backlex/ui/components/badge";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Switch } from "@backlex/ui/components/switch";
import { Textarea } from "@backlex/ui/components/textarea";
import { cn } from "@backlex/ui/lib/utils";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Select } from "../select";
import { Button, EmptyState, PageHeader } from "../ui";
import { bookingApi, type ApiBooking, type ApiBookingResource, type ApiBookingRule } from "../api";
import { BookingSkeleton } from "../page-skeletons";
import { DatePicker } from "@/components/date-picker";
import { ConfirmAction } from "@/components/confirm-action";

/**
 * Availability & booking — what is bookable, when it is open, and who is coming.
 *
 * Two panes rather than one list, because an operator has two unrelated
 * questions here: "is my calendar set up right" and "who is coming on
 * Thursday". The resource editor answers the first; the booking list the
 * second.
 *
 * The public page link appears exactly once, right after a resource is created
 * or its token is rotated. Only the hash is stored, so this dialog is the only
 * chance to copy it — every later action mints a fresh link rather than showing
 * the old one.
 */

const WEEKDAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  confirmed: "default",
  held: "secondary",
  completed: "outline",
  cancelled: "destructive",
  no_show: "destructive",
  expired: "outline",
};

/**
 * A short list of zones, plus whatever the browser is in.
 *
 * A finite set of values belongs in a dropdown rather than a text field, and
 * this one has a genuine "Custom…" case — `Intl` knows several hundred names
 * and an operator abroad will want one that is not on any short list.
 */
const COMMON_ZONES = [
  "UTC",
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const minutesToClock = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const clockToMinutes = (raw: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]) * 60 + Number(m[2]);
  return value >= 0 && value <= 1440 ? value : null;
};

/** Instants come back in UTC; an operator reads them in the RESOURCE's zone,
 *  because a list of times for a clinic abroad read in the browser's zone is
 *  wrong on every line. */
const inZone = (iso: string, timeZone: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
};

/** The same instant with the year dropped — a stat tile is a quarter of a row
 *  wide, and a year is the one part of "next free" nobody is reading. */
const shortInZone = (iso: string, timeZone: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return inZone(iso, "UTC");
  }
};

/** Both ends of one booking, in the resource's zone, without repeating the day. */
const rangeInZone = (start: string, end: string, timeZone: string): string => {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  try {
    const day = new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium" }).format(a);
    const clock = new Intl.DateTimeFormat(undefined, { timeZone, timeStyle: "short" });
    return `${day} · ${clock.format(a)} – ${clock.format(b)}`;
  } catch {
    return inZone(start, "UTC");
  }
};

/** A booking can only be a no-show once its slot has actually passed — before
 *  that nobody has failed to turn up yet. The server agrees: it takes the
 *  STORED status, which stays `confirmed` while the derived one reads
 *  `completed`. */
const isOver = (b: ApiBooking, now: number): boolean => Date.parse(b.end) <= now;

/** How many rows one page of the booking list holds. */
const PAGE_SIZE = 20;

/** The window the list is read through. An operator's first question is "who is
 *  coming", not "what came in last", so upcoming-ascending is the default. */
const WINDOWS = {
  upcoming: { order: "asc" as const, from: () => new Date().toISOString(), to: () => undefined },
  past: { order: "desc" as const, from: () => undefined, to: () => new Date().toISOString() },
  all: { order: "desc" as const, from: () => undefined, to: () => undefined },
};
type WindowKey = keyof typeof WINDOWS;

/** Seven days out — far enough to read as a plan, near enough to be accurate. */
const HORIZON_DAYS = 7;

function StatTile({
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
function CopyLink({ value, pushToast }: { value: string; pushToast: (m: string) => void }) {
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
function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const blankRule = (): ApiBookingRule => ({
  kind: "open",
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  startsOn: null,
  endsOn: null,
  reason: null,
});

const DEFAULT_FORM = {
  key: "",
  name: "",
  description: "",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  slotMinutes: "30",
  capacity: "1",
  bufferBeforeMinutes: "0",
  bufferAfterMinutes: "0",
  leadMinutes: "0",
  horizonDays: "60",
  holdMinutes: "10",
  confirmationMessage: "",
  mirrorCollection: "",
  active: true,
};

export function BookingPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [resources, setResources] = useState<ApiBookingResource[]>([]);
  const [bookings, setBookings] = useState<ApiBooking[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState("");
  const [windowKey, setWindowKey] = useState<WindowKey>("upcoming");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  /** Next-7-days plan for the selected resource: what is taken, what is left. */
  const [plan, setPlan] = useState<{ booked: number; free: number; nextFree: string | null } | null>(
    null,
  );

  const [detail, setDetail] = useState<ApiBooking | null>(null);
  const [moveAt, setMoveAt] = useState<string>("");

  const [editOpen, setEditOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [rules, setRules] = useState<ApiBookingRule[]>([blankRule()]);
  const [customZone, setCustomZone] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const [bookOpen, setBookOpen] = useState(false);
  const [bookForm, setBookForm] = useState({ start: "", name: "", email: "", phone: "", notes: "" });
  /** Set once a booking lands: the dialog becomes a receipt rather than an
   *  empty form, because the manage link is shown exactly once. */
  const [booked, setBooked] = useState<{
    url: string;
    booking: ApiBooking;
    /** A move ends on the same receipt — the link is reminted either way. */
    moved?: boolean;
  } | null>(null);

  const current = useMemo(
    () => resources.find((r) => r.key === selected) ?? resources[0] ?? null,
    [resources, selected],
  );

  /** Which side of "now" a booking sits on decides what can be done to it, so
   *  the clock is state rather than a read at render time — a slot that passes
   *  while the page is open changes the row without a reload. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadBookings = async (
    resourceKey?: string,
    status?: string,
    win: WindowKey = "upcoming",
    from = 0,
  ) => {
    const w = WINDOWS[win];
    const lower = w.from();
    const upper = w.to();
    const res = await bookingApi.listBookings({
      ...(resourceKey ? { resource: resourceKey } : {}),
      ...(status ? { status } : {}),
      ...(lower ? { from: lower } : {}),
      ...(upper ? { to: upper } : {}),
      order: w.order,
      limit: String(PAGE_SIZE),
      offset: String(from),
    });
    setBookings((res.data ?? []) as ApiBooking[]);
    setTotal(res.total ?? 0);
    setOffset(from);
  };

  /**
   * What the next week looks like: how much of the published grid is taken and
   * how much is left. `slots` only returns what is still free, so "taken" comes
   * from the bookings themselves rather than from subtracting one from the
   * other — a booking made off-grid by an operator belongs in the count too.
   */
  const loadPlan = async (resourceKey: string) => {
    const from = new Date();
    const to = new Date(from.getTime() + HORIZON_DAYS * 86400_000);
    setPlan(null);
    try {
      const [slots, live] = await Promise.all([
        bookingApi.slots(resourceKey, { from: from.toISOString(), to: to.toISOString() }),
        bookingApi.listBookings({
          resource: resourceKey,
          from: from.toISOString(),
          to: to.toISOString(),
          order: "asc",
          limit: "200",
        }),
      ]);
      const open = slots.data.slots ?? [];
      const taken = ((live.data ?? []) as ApiBooking[]).filter(
        (b) => b.status === "confirmed" || b.status === "held",
      ).length;
      setPlan({
        booked: taken,
        free: open.reduce((sum, s) => sum + s.remaining, 0),
        nextFree: open[0]?.start ?? null,
      });
    } catch {
      // A resource with no rules answers with an empty grid rather than an
      // error, so anything thrown here is worth staying quiet about — the
      // strip simply does not claim a number it does not have.
      setPlan({ booked: 0, free: 0, nextFree: null });
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await bookingApi.listResources();
        if (cancelled) return;
        const rows = (res.data ?? []) as ApiBookingResource[];
        setResources(rows);
        if (rows[0]) {
          setSelected(rows[0].key);
          await loadBookings(rows[0].key);
          void loadPlan(rows[0].key);
        }
      } catch {
        // Leave both panes empty; the page still offers "New resource".
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onPickResource = async (key: string) => {
    setSelected(key);
    void loadPlan(key);
    try {
      await loadBookings(key, statusFilter || undefined, windowKey, 0);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onFilterStatus = async (next: string) => {
    setStatusFilter(next);
    try {
      await loadBookings(current?.key, next || undefined, windowKey, 0);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onFilterWindow = async (next: string) => {
    const win = (next in WINDOWS ? next : "upcoming") as WindowKey;
    setWindowKey(win);
    try {
      await loadBookings(current?.key, statusFilter || undefined, win, 0);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onPage = async (next: number) => {
    try {
      await loadBookings(current?.key, statusFilter || undefined, windowKey, next);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  /** Every mutation re-reads the same page it was fired from, so the counts in
   *  the strip and the row itself never drift apart. */
  const refreshAfterMutation = () => {
    if (!current) return;
    void loadPlan(current.key);
    void loadBookings(current.key, statusFilter || undefined, windowKey, offset).catch(() => {});
  };

  const openNew = () => {
    setEditingKey(null);
    setForm({ ...DEFAULT_FORM });
    setRules([blankRule()]);
    setCustomZone(!COMMON_ZONES.includes(DEFAULT_FORM.timeZone));
    setLink(null);
    setEditOpen(true);
  };

  const openEdit = (r: ApiBookingResource) => {
    setEditingKey(r.key);
    setForm({
      key: r.key,
      name: r.name,
      description: r.description ?? "",
      timeZone: r.timeZone,
      slotMinutes: String(r.slotMinutes),
      capacity: String(r.capacity),
      bufferBeforeMinutes: String(r.bufferBeforeMinutes),
      bufferAfterMinutes: String(r.bufferAfterMinutes),
      leadMinutes: String(r.leadMinutes),
      horizonDays: String(r.horizonDays),
      holdMinutes: String(r.holdMinutes),
      confirmationMessage: r.confirmationMessage ?? "",
      mirrorCollection: r.mirrorCollection ?? "",
      active: r.active,
    });
    setRules(r.rules.length > 0 ? r.rules.map((x) => ({ ...x })) : [blankRule()]);
    setCustomZone(!COMMON_ZONES.includes(r.timeZone));
    setLink(null);
    setEditOpen(true);
  };

  const body = () => ({
    name: form.name.trim(),
    description: form.description.trim() || null,
    timeZone: form.timeZone.trim(),
    slotMinutes: Number(form.slotMinutes) || 30,
    capacity: Number(form.capacity) || 1,
    bufferBeforeMinutes: Number(form.bufferBeforeMinutes) || 0,
    bufferAfterMinutes: Number(form.bufferAfterMinutes) || 0,
    leadMinutes: Number(form.leadMinutes) || 0,
    horizonDays: Number(form.horizonDays) || 60,
    holdMinutes: Number(form.holdMinutes) || 10,
    confirmationMessage: form.confirmationMessage.trim() || null,
    mirrorCollection: form.mirrorCollection.trim() || null,
    active: form.active,
    rules: rules.map((r) => ({
      kind: r.kind,
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      reason: r.reason,
    })),
  });

  const onSave = async () => {
    if (!form.name.trim()) {
      pushToast(t`Give the resource a name.`);
      return;
    }
    if (!editingKey && !/^[a-z0-9][a-z0-9_-]*$/.test(form.key.trim())) {
      pushToast(t`The key must be lowercase letters, digits, dash or underscore.`);
      return;
    }
    for (const r of rules) {
      if (r.startMinute >= r.endMinute) {
        pushToast(t`Each rule must start before it ends. A span crossing midnight is two rules.`);
        return;
      }
      if (r.weekday === null && !r.startsOn) {
        pushToast(t`A rule with no weekday needs a date range.`);
        return;
      }
    }

    setBusy(true);
    try {
      if (editingKey) {
        const res = await bookingApi.updateResource(editingKey, body());
        // Optimistic in the direction that matters: the row is updated before
        // any refetch, so the page never looks like nothing happened.
        setResources((arr) => arr.map((r) => (r.key === editingKey ? res.data : r)));
        setEditOpen(false);
        pushToast(t`Saved.`);
      } else {
        const res = await bookingApi.createResource({ key: form.key.trim(), ...body() });
        setResources((arr) => [...arr, res.data.resource]);
        setSelected(res.data.resource.key);
        // Shown once — only the hash is stored, so the dialog stays open on
        // the link rather than closing over it.
        setLink(res.data.url);
        setEditingKey(res.data.resource.key);
        await loadBookings(res.data.resource.key).catch(() => {});
      }
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRotate = async (r: ApiBookingResource) => {
    setBusy(true);
    try {
      const res = await bookingApi.rotateToken(r.key);
      // Load the resource into the form BEFORE opening on it. The dialog is
      // the resource editor, and it kept whatever was last edited otherwise —
      // so "New link" offered a Save that would write another resource's
      // hours over this one.
      openEdit(r);
      setLink(res.data.url);
      pushToast(t`New link minted — the old one no longer works.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (r: ApiBookingResource) => {
    const snapshot = resources;
    setResources((arr) => arr.filter((x) => x.key !== r.key));
    if (selected === r.key) setSelected(snapshot.find((x) => x.key !== r.key)?.key ?? "");
    try {
      await bookingApi.deleteResource(r.key);
      pushToast(t`Deleted.`);
    } catch (e) {
      setResources(snapshot);
      pushToast((e as Error).message);
    }
  };

  const onBook = async () => {
    if (!current) return;
    if (!bookForm.start.trim()) {
      pushToast(t`Pick a start time.`);
      return;
    }
    setBusy(true);
    try {
      const res = await bookingApi.book({
        resource: current.key,
        // The picker emits an instant read off the operator's own clock, which
        // is the honest reading of a time taken over the phone — rather than
        // pasting the digits into the resource's zone as if the two agreed.
        start: bookForm.start,
        ...(bookForm.name.trim() ? { name: bookForm.name.trim() } : {}),
        ...(bookForm.email.trim() ? { email: bookForm.email.trim() } : {}),
        ...(bookForm.phone.trim() ? { phone: bookForm.phone.trim() } : {}),
        ...(bookForm.notes.trim() ? { notes: bookForm.notes.trim() } : {}),
      });
      setBookings((arr) => [res.data.booking, ...arr]);
      setBooked({ url: res.data.manageUrl, booking: res.data.booking });
      setBookForm({ start: "", name: "", email: "", phone: "", notes: "" });
      pushToast(t`Booked.`);
      refreshAfterMutation();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patchBooking = async (
    b: ApiBooking,
    next: ApiBooking["status"],
    call: () => Promise<{ data: ApiBooking }>,
    done: string,
  ) => {
    const snapshot = bookings;
    setBookings((arr) => arr.map((x) => (x.id === b.id ? { ...x, status: next } : x)));
    setDetail((d) => (d && d.id === b.id ? { ...d, status: next } : d));
    try {
      const res = await call();
      setBookings((arr) => arr.map((x) => (x.id === b.id ? res.data : x)));
      setDetail((d) => (d && d.id === b.id ? res.data : d));
      pushToast(done);
      // A freed or spent slot changes what the week looks like, so the strip
      // is re-read rather than left claiming the old numbers.
      if (current) void loadPlan(current.key);
    } catch (e) {
      setBookings(snapshot);
      setDetail((d) => (d && d.id === b.id ? b : d));
      pushToast((e as Error).message);
    }
  };

  /** Move a booking to another time. The old slot is released and a fresh
   *  manage link is minted, which is why this answers with the receipt panel
   *  rather than a toast alone. */
  const onMove = async (b: ApiBooking) => {
    if (!moveAt.trim()) {
      pushToast(t`Pick the new time first.`);
      return;
    }
    setBusy(true);
    try {
      const res = await bookingApi.reschedule(b.id, moveAt);
      setDetail(null);
      setMoveAt("");
      setBooked({ url: res.data.manageUrl, booking: res.data.booking, moved: true });
      setBookOpen(true);
      pushToast(t`Moved — the old slot is free again.`);
      refreshAfterMutation();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shownFrom = offset + 1;
  const shownTo = Math.min(offset + bookings.length, total);

  if (!loaded) return <BookingSkeleton />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t`Booking`}
        description={t`Publish a calendar people can pick a time from, and see who did.`}
        actions={
          <Button variant="primary" onClick={openNew} className="ml-auto">
            <I.Plus className="size-4" />
            <span className="max-sm:sr-only">
              <Trans>New resource</Trans>
            </span>
          </Button>
        }
      />

      {resources.length === 0 ? (
        <EmptyState
          icon={I.CalendarDays}
          title={<Trans>Nothing is bookable yet</Trans>}
          description={
            <Trans>
              A resource is the thing people book — a person, a room, a table — and it carries the
              opening hours, how long one booking lasts and how many fit at once.
            </Trans>
          }
          action={
            <Button variant="primary" icon={I.Plus} onClick={openNew}>
              <Trans>New resource</Trans>
            </Button>
          }
        />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[320px_1fr]">
          {/* `self-start` (via the grid's `items-start`) keeps the resource
              list hugging its rows — a grid cell stretches to the tallest
              column by default, which draws a mostly-empty card beside a busy
              booking list. */}
          <Card className="p-0">
            <ScrollArea viewportClassName="max-h-[60vh]" className="w-full">
              <div className="flex flex-col divide-y">
                {resources.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => void onPickResource(r.key)}
                    className={`flex flex-col items-start gap-1 p-3 text-left transition-colors hover:bg-accent ${
                      current?.key === r.key ? "bg-accent" : ""
                    }`}
                  >
                    <div className="flex w-full min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{r.name}</span>
                      {!r.active && (
                        <Badge variant="outline">
                          <Trans>Paused</Trans>
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {r.timeZone} · {r.slotMinutes}m ·{" "}
                      <Trans>{r.rules.length} rules</Trans>
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </Card>

          <div className="min-w-0 space-y-4">
            {current && (
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{current.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <Trans>
                        Times are written in {current.timeZone}. {current.capacity} at once,{" "}
                        {current.slotMinutes} minutes each.
                      </Trans>
                    </div>
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={() => openEdit(current)}>
                      <I.Settings className="size-4" />
                      <span className="max-sm:sr-only">
                        <Trans>Edit</Trans>
                      </span>
                    </Button>
                    <Button variant="outline" onClick={() => void onRotate(current)} disabled={busy}>
                      <I.Link className="size-4" />
                      <span className="max-sm:sr-only">
                        <Trans>New link</Trans>
                      </span>
                    </Button>
                    <Button variant="outline" onClick={() => setBookOpen(true)}>
                      <I.Plus className="size-4" />
                      <span className="max-sm:sr-only">
                        <Trans>Add booking</Trans>
                      </span>
                    </Button>
                    <ConfirmAction
                      title={t`Delete this resource?`}
                      description={t`Its rules and its public link go with it. A resource with upcoming bookings is refused — cancel or move those first.`}
                      actionLabel={t`Delete`}
                      destructive
                      onConfirm={() => onDelete(current)}
                    >
                      <Button variant="destructive">
                        <I.Trash className="size-4" />
                        <span className="sr-only">
                          <Trans>Delete</Trans>
                        </span>
                      </Button>
                    </ConfirmAction>
                  </div>
                </div>
              </Card>
            )}

            {/* ── the next week, in four numbers ─────────────────────────── */}
            {current && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile
                  label={t`Booked`}
                  value={plan ? String(plan.booked) : "—"}
                  sub={t`next ${HORIZON_DAYS} days`}
                />
                <StatTile
                  label={t`Still free`}
                  value={plan ? String(plan.free) : "—"}
                  sub={t`places on the published grid`}
                />
                <StatTile
                  label={t`Full`}
                  value={
                    plan && plan.booked + plan.free > 0
                      ? `${Math.round((plan.booked / (plan.booked + plan.free)) * 100)}%`
                      : "—"
                  }
                  sub={t`of what is open`}
                />
                <StatTile
                  label={t`Next free`}
                  size="sm"
                  value={plan?.nextFree ? shortInZone(plan.nextFree, current.timeZone) : "—"}
                  sub={plan?.nextFree ? current.timeZone : t`nothing open in the window`}
                />
              </div>
            )}

            <Card className="p-0">
              <div className="flex flex-wrap items-center gap-2 border-b p-3">
                <span className="text-sm font-medium">
                  <Trans>Bookings</Trans>
                </span>
                <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
                  <div className="w-36 max-sm:w-32">
                    <Select
                      value={windowKey}
                      onChange={(v) => void onFilterWindow(v)}
                      className="min-w-0"
                      options={[
                        { value: "upcoming", label: t`Upcoming` },
                        { value: "past", label: t`Past` },
                        { value: "all", label: t`Everything` },
                      ]}
                    />
                  </div>
                  <div className="w-44 max-sm:w-36">
                    <Select
                      value={statusFilter}
                      onChange={(v) => void onFilterStatus(v)}
                      className="min-w-0"
                      options={[
                        { value: "", label: t`Every status` },
                        { value: "confirmed", label: t`Confirmed` },
                        { value: "held", label: t`Held` },
                        { value: "completed", label: t`Completed` },
                        { value: "cancelled", label: t`Cancelled` },
                        { value: "no_show", label: t`No-show` },
                        { value: "expired", label: t`Expired` },
                      ]}
                    />
                  </div>
                </div>
              </div>

              {bookings.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  {windowKey === "upcoming" ? (
                    <Trans>Nothing is coming up in this view.</Trans>
                  ) : (
                    <Trans>No bookings match.</Trans>
                  )}
                </div>
              ) : (
                <ScrollArea viewportClassName="max-h-[55vh]" className="w-full">
                  <div className="flex flex-col divide-y">
                    {bookings.map((b) => (
                      <div
                        key={b.id}
                        className="flex flex-wrap items-center gap-2 p-3 transition-colors hover:bg-accent/50"
                      >
                        {/* The row itself opens the record — the quick actions
                            beside it are the two or three moves an operator
                            makes without needing to read anything first. */}
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            setMoveAt(b.start);
                            setDetail(b);
                          }}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {b.customerName || b.customerEmail || t`(no name)`}
                            </span>
                            <Badge variant={STATUS_TONE[b.status] ?? "secondary"}>{b.status}</Badge>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {inZone(b.start, current?.timeZone ?? "UTC")} · {b.source}
                          </div>
                        </button>
                        <div className="flex flex-wrap items-center gap-1">
                          {b.status === "held" && (
                            <Button
                              variant="outline"
                              onClick={() =>
                                void patchBooking(b, "confirmed", () => bookingApi.confirm(b.id), t`Confirmed.`)
                              }
                            >
                              <Trans>Confirm</Trans>
                            </Button>
                          )}
                          {/* Only once the slot has passed: before that nobody
                              has failed to turn up yet. A booking that is over
                              reads as `completed`, which is precisely the one
                              that can still be corrected to a no-show. */}
                          {b.storedStatus === "confirmed" && isOver(b, now) && (
                            <Button
                              variant="outline"
                              title={t`They did not turn up.`}
                              onClick={() =>
                                void patchBooking(b, "no_show", () => bookingApi.noShow(b.id), t`Marked as a no-show.`)
                              }
                            >
                              <Trans>No-show</Trans>
                            </Button>
                          )}
                          {(b.status === "confirmed" || b.status === "held") && (
                            <ConfirmAction
                              title={t`Cancel this booking?`}
                              description={t`The slot goes back on sale and the customer is emailed.`}
                              actionLabel={t`Cancel the booking`}
                              cancelLabel={t`Keep it`}
                              destructive
                              onConfirm={() =>
                                patchBooking(
                                  b,
                                  "cancelled",
                                  () => bookingApi.cancel(b.id),
                                  t`Cancelled — the slot is free again.`,
                                )
                              }
                            >
                              <Button variant="destructive">
                                <Trans>Cancel</Trans>
                              </Button>
                            </ConfirmAction>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              {total > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t p-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    <Trans>
                      {shownFrom}–{shownTo} of {total}
                    </Trans>
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="outline"
                      disabled={offset === 0}
                      onClick={() => void onPage(Math.max(offset - PAGE_SIZE, 0))}
                    >
                      <Trans>Previous</Trans>
                    </Button>
                    <Button
                      variant="outline"
                      disabled={offset + bookings.length >= total}
                      onClick={() => void onPage(offset + PAGE_SIZE)}
                    >
                      <Trans>Next</Trans>
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ── resource editor ─────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-2xl [&>*]:min-w-0">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {editingKey ? <Trans>Edit resource</Trans> : <Trans>New bookable resource</Trans>}
            </DialogTitle>
            <DialogDescription>
              <Trans>
                The opening hours are written in the resource's own zone, so "Mondays 09:00" keeps
                meaning nine in the morning there when the clocks change.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="grid gap-4 p-1">
              {link && (
                <Card className="border-primary/40 bg-primary/5 p-3">
                  <div className="text-sm font-medium">
                    <Trans>The public booking link</Trans>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>
                      Copy it now. Only its hash is stored, so nothing can show it again — "New
                      link" mints a replacement and kills this one.
                    </Trans>
                  </p>
                  <CopyLink value={link} pushToast={pushToast} />
                </Card>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                {!editingKey && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="bk-key">
                      <Trans>Key</Trans>
                    </Label>
                    <Input
                      id="bk-key"
                      value={form.key}
                      onChange={(e) => setForm({ ...form, key: e.target.value })}
                      placeholder="clinic"
                    />
                    <p className="text-xs text-muted-foreground">
                      <Trans>How the API and CLI address it. Cannot be changed later.</Trans>
                    </p>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="bk-name">
                    <Trans>Name</Trans>
                  </Label>
                  <Input
                    id="bk-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={t`Dr Yılmaz`}
                  />
                  <p className="text-xs text-muted-foreground">
                    <Trans>Shown on the public page.</Trans>
                  </p>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>
                  <Trans>Time zone</Trans>
                </Label>
                {customZone ? (
                  <Input
                    value={form.timeZone}
                    onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
                    placeholder="Europe/Istanbul"
                  />
                ) : (
                  <Select
                    value={form.timeZone}
                    onChange={(v) =>
                      v === "__custom" ? setCustomZone(true) : setForm({ ...form, timeZone: v })
                    }
                    className="min-w-0"
                    options={[
                      ...COMMON_ZONES.map((z) => ({ value: z, label: z })),
                      { value: "__custom", label: t`Custom…` },
                    ]}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    The zone the opening hours are written in — not a display preference.
                  </Trans>
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                {(
                  [
                    ["slotMinutes", t`Slot length`, t`Minutes one booking lasts.`],
                    ["capacity", t`Capacity`, t`How many fit at once.`],
                    ["holdMinutes", t`Hold`, t`Minutes an unconfirmed hold survives.`],
                    ["bufferBeforeMinutes", t`Buffer before`, t`Protected minutes before each booking.`],
                    ["bufferAfterMinutes", t`Buffer after`, t`Both sides apply, so 15+15 is a 30-minute gap.`],
                    ["leadMinutes", t`Notice`, t`Minimum minutes of warning.`],
                    ["horizonDays", t`Horizon`, t`How many days ahead the calendar is open.`],
                  ] as const
                ).map(([field, label, hint]) => (
                  <div key={field} className="grid gap-1.5">
                    <Label htmlFor={`bk-${field}`}>{label}</Label>
                    <Input
                      id={`bk-${field}`}
                      type="number"
                      inputMode="numeric"
                      value={form[field]}
                      onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Label>
                    <Trans>Opening hours</Trans>
                  </Label>
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() => setRules((arr) => [...arr, blankRule()])}
                  >
                    <I.Plus className="size-4" />
                    <Trans>Add rule</Trans>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    An "open" rule adds bookable time and a "block" takes it away. A span crossing
                    midnight is two rules.
                  </Trans>
                </p>
                {rules.map((r, i) => (
                  <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[110px_140px_1fr_1fr_auto]">
                    <Select
                      value={r.kind}
                      onChange={(v) =>
                        setRules((arr) => arr.map((x, j) => (j === i ? { ...x, kind: v } : x)))
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
                        setRules((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, weekday: v === "" ? null : Number(v) } : x)),
                        )
                      }
                      className="min-w-0"
                      options={[...WEEKDAYS, { value: "", label: t`Specific dates` }]}
                    />
                    <Input
                      value={minutesToClock(r.startMinute)}
                      onChange={(e) => {
                        const m = clockToMinutes(e.target.value);
                        if (m !== null)
                          setRules((arr) => arr.map((x, j) => (j === i ? { ...x, startMinute: m } : x)));
                      }}
                      placeholder="09:00"
                    />
                    <Input
                      value={minutesToClock(r.endMinute)}
                      onChange={(e) => {
                        const m = clockToMinutes(e.target.value);
                        if (m !== null)
                          setRules((arr) => arr.map((x, j) => (j === i ? { ...x, endMinute: m } : x)));
                      }}
                      placeholder="17:00"
                    />
                    <Button
                      variant="outline"
                      onClick={() => setRules((arr) => arr.filter((_, j) => j !== i))}
                    >
                      <I.Trash className="size-4" />
                      <span className="sr-only">
                        <Trans>Remove rule</Trans>
                      </span>
                    </Button>
                    {r.weekday === null && (
                      <div className="grid gap-2 sm:col-span-5 sm:grid-cols-2">
                        <Input
                          type="date"
                          value={r.startsOn ?? ""}
                          onChange={(e) =>
                            setRules((arr) =>
                              arr.map((x, j) => (j === i ? { ...x, startsOn: e.target.value || null } : x)),
                            )
                          }
                        />
                        <Input
                          type="date"
                          value={r.endsOn ?? ""}
                          onChange={(e) =>
                            setRules((arr) =>
                              arr.map((x, j) => (j === i ? { ...x, endsOn: e.target.value || null } : x)),
                            )
                          }
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="bk-mirror">
                  <Trans>Mirror into a collection</Trans>
                </Label>
                <Input
                  id="bk-mirror"
                  value={form.mirrorCollection}
                  onChange={(e) => setForm({ ...form, mirrorCollection: e.target.value })}
                  placeholder="appointments"
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    Optional. Each booking is also written as a row there, so permissions, flows and
                    exports apply to it as usual.
                  </Trans>
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="bk-confirm">
                  <Trans>Confirmation message</Trans>
                </Label>
                <Textarea
                  id="bk-confirm"
                  rows={2}
                  value={form.confirmationMessage}
                  onChange={(e) => setForm({ ...form, confirmationMessage: e.target.value })}
                  placeholder={t`Please arrive ten minutes early.`}
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="bk-active"
                  checked={form.active}
                  onCheckedChange={(v) => setForm({ ...form, active: v })}
                />
                <Label htmlFor="bk-active">
                  <Trans>Accepting bookings</Trans>
                </Label>
              </div>
            </div>
          </DialogBody>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              <Trans>Close</Trans>
            </Button>
            <Button onClick={() => void onSave()} disabled={busy}>
              {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── one booking, in full ────────────────────────────────────────── */}
      <Dialog
        open={detail !== null}
        onOpenChange={(v) => {
          if (!v) setDetail(null);
        }}
      >
        <DialogContent className="[&>*]:min-w-0">
          <DialogHeader className="shrink-0">
            <DialogTitle className="truncate">
              {detail?.customerName || detail?.customerEmail || t`(no name)`}
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Everything the booking carries, and the moves still open to it. Times are in the
                resource's zone.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          {detail && (
            <DialogBody>
              <div className="grid gap-3 p-1">
                <div className="divide-y">
                  <Detail label={<Trans>Status</Trans>}>
                    <Badge variant={STATUS_TONE[detail.status] ?? "secondary"}>{detail.status}</Badge>
                  </Detail>
                  <Detail label={<Trans>When</Trans>}>
                    {rangeInZone(detail.start, detail.end, current?.timeZone ?? "UTC")}
                  </Detail>
                  <Detail label={<Trans>Email</Trans>}>{detail.customerEmail || "—"}</Detail>
                  <Detail label={<Trans>Phone</Trans>}>{detail.customerPhone || "—"}</Detail>
                  <Detail label={<Trans>Booked via</Trans>}>{detail.source}</Detail>
                  {detail.notes && <Detail label={<Trans>Notes</Trans>}>{detail.notes}</Detail>}
                  {detail.cancelReason && (
                    <Detail label={<Trans>Reason</Trans>}>{detail.cancelReason}</Detail>
                  )}
                  {Object.entries(detail.answers ?? {}).map(([k, v]) => (
                    <Detail key={k} label={k}>
                      {typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)}
                    </Detail>
                  ))}
                </div>

                {(detail.status === "confirmed" || detail.status === "held") && (
                  <Card className="p-3">
                    <div className="text-sm font-medium">
                      <Trans>Move it</Trans>
                    </div>
                    <p className="mt-1 mb-2 text-xs text-muted-foreground">
                      <Trans>
                        The old slot goes back on sale, the customer is emailed, and a fresh link to
                        change or cancel is minted.
                      </Trans>
                    </p>
                    <DatePicker value={moveAt} onChange={(iso) => setMoveAt(iso ?? "")} />
                    <div className="mt-2">
                      <Button variant="outline" disabled={busy} onClick={() => void onMove(detail)}>
                        <I.CalendarDays className="size-4" />
                        {busy ? <Trans>Moving…</Trans> : <Trans>Move to this time</Trans>}
                      </Button>
                    </div>
                  </Card>
                )}
              </div>
            </DialogBody>
          )}

          <DialogFooter className="shrink-0">
            {detail && detail.storedStatus === "confirmed" && isOver(detail, now) && (
              <Button
                variant="outline"
                onClick={() =>
                  void patchBooking(detail, "no_show", () => bookingApi.noShow(detail.id), t`Marked as a no-show.`)
                }
              >
                <Trans>No-show</Trans>
              </Button>
            )}
            {detail && detail.status === "held" && (
              <Button
                variant="outline"
                onClick={() =>
                  void patchBooking(detail, "confirmed", () => bookingApi.confirm(detail.id), t`Confirmed.`)
                }
              >
                <Trans>Confirm</Trans>
              </Button>
            )}
            <Button variant="outline" onClick={() => setDetail(null)}>
              <Trans>Close</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── operator booking ────────────────────────────────────────────── */}
      <Dialog
        open={bookOpen}
        onOpenChange={(v) => {
          setBookOpen(v);
          if (!v) setBooked(null);
        }}
      >
        <DialogContent className="[&>*]:min-w-0">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {booked ? (
                booked.moved ? (
                  <Trans>Moved</Trans>
                ) : (
                  <Trans>Booked</Trans>
                )
              ) : (
                <Trans>Add a booking</Trans>
              )}
            </DialogTitle>
            <DialogDescription>
              {booked ? (
                <Trans>
                  The slot is taken. Their link to change or cancel is shown here once and nowhere
                  else.
                </Trans>
              ) : (
                <Trans>
                  Taken over the phone, so it is not limited to the published times — but a slot that
                  is already full is still refused.
                </Trans>
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            {/* A receipt, not a second empty form: the manage link is shown
                exactly once, and re-drawing the fields underneath it reads as
                if nothing was saved. */}
            {booked ? (
              <div className="grid gap-3 p-1">
                <Card className="border-primary/40 bg-primary/5 p-3">
                  <div className="text-sm font-medium">
                    <Trans>Their link to change or cancel</Trans>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>Shown once. It also went out with the confirmation email.</Trans>
                  </p>
                  <CopyLink value={booked.url} pushToast={pushToast} />
                </Card>
                <div className="divide-y">
                  <Detail label={<Trans>Who</Trans>}>
                    {booked.booking.customerName || booked.booking.customerEmail || t`(no name)`}
                  </Detail>
                  <Detail label={<Trans>When</Trans>}>
                    {rangeInZone(booked.booking.start, booked.booking.end, current?.timeZone ?? "UTC")}
                  </Detail>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 p-1">
                <div className="grid gap-1.5">
                  <Label htmlFor="bk-start">
                    <Trans>Starts</Trans>
                  </Label>
                  <DatePicker
                    value={bookForm.start}
                    onChange={(iso) => setBookForm({ ...bookForm, start: iso ?? "" })}
                  />
                  <p className="text-xs text-muted-foreground">
                    <Trans>Read on your own clock, then stored as an instant.</Trans>
                  </p>
                </div>
                {(
                  [
                    ["name", t`Name`],
                    ["email", t`Email`],
                    ["phone", t`Phone`],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field} className="grid gap-1.5">
                    <Label htmlFor={`bk-c-${field}`}>{label}</Label>
                    <Input
                      id={`bk-c-${field}`}
                      value={bookForm[field]}
                      onChange={(e) => setBookForm({ ...bookForm, [field]: e.target.value })}
                    />
                  </div>
                ))}
                <div className="grid gap-1.5">
                  <Label htmlFor="bk-c-notes">
                    <Trans>Notes</Trans>
                  </Label>
                  <Textarea
                    id="bk-c-notes"
                    rows={2}
                    value={bookForm.notes}
                    onChange={(e) => setBookForm({ ...bookForm, notes: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    <Trans>Yours only — the customer never sees these.</Trans>
                  </p>
                </div>
              </div>
            )}
          </DialogBody>

          <DialogFooter className="shrink-0">
            {booked ? (
              <>
                <Button variant="outline" onClick={() => setBooked(null)}>
                  <Trans>Add another</Trans>
                </Button>
                <Button
                  onClick={() => {
                    setBooked(null);
                    setBookOpen(false);
                  }}
                >
                  <Trans>Done</Trans>
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setBookOpen(false)}>
                  <Trans>Close</Trans>
                </Button>
                <Button onClick={() => void onBook()} disabled={busy}>
                  {busy ? <Trans>Booking…</Trans> : <Trans>Book</Trans>}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
