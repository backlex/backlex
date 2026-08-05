// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@backlex/ui/components/badge";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Switch } from "@backlex/ui/components/switch";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
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

  const [editOpen, setEditOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [rules, setRules] = useState<ApiBookingRule[]>([blankRule()]);
  const [customZone, setCustomZone] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const [bookOpen, setBookOpen] = useState(false);
  const [bookForm, setBookForm] = useState({ start: "", name: "", email: "", phone: "", notes: "" });
  const [manageLink, setManageLink] = useState<string | null>(null);

  const current = useMemo(
    () => resources.find((r) => r.key === selected) ?? resources[0] ?? null,
    [resources, selected],
  );

  const loadBookings = async (resourceKey?: string, status?: string) => {
    const res = await bookingApi.listBookings({
      ...(resourceKey ? { resource: resourceKey } : {}),
      ...(status ? { status } : {}),
    });
    setBookings((res.data ?? []) as ApiBooking[]);
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
    try {
      await loadBookings(key, statusFilter || undefined);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onFilterStatus = async (next: string) => {
    setStatusFilter(next);
    try {
      await loadBookings(current?.key, next || undefined);
    } catch (e) {
      pushToast((e as Error).message);
    }
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
      setLink(res.data.url);
      setEditingKey(r.key);
      setEditOpen(true);
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
        // `datetime-local` has no zone, and the operator typed a time on their
        // own clock — so it is read in the browser's zone and sent as an
        // instant, rather than being pasted into the resource's zone as if the
        // two agreed.
        start: new Date(bookForm.start).toISOString(),
        ...(bookForm.name.trim() ? { name: bookForm.name.trim() } : {}),
        ...(bookForm.email.trim() ? { email: bookForm.email.trim() } : {}),
        ...(bookForm.phone.trim() ? { phone: bookForm.phone.trim() } : {}),
        ...(bookForm.notes.trim() ? { notes: bookForm.notes.trim() } : {}),
      });
      setBookings((arr) => [res.data.booking, ...arr]);
      setManageLink(res.data.manageUrl);
      setBookForm({ start: "", name: "", email: "", phone: "", notes: "" });
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
    try {
      const res = await call();
      setBookings((arr) => arr.map((x) => (x.id === b.id ? res.data : x)));
      pushToast(done);
    } catch (e) {
      setBookings(snapshot);
      pushToast((e as Error).message);
    }
  };

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
                    <Button variant="destructive" onClick={() => void onDelete(current)}>
                      <I.Trash className="size-4" />
                      <span className="sr-only">
                        <Trans>Delete</Trans>
                      </span>
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            <Card className="p-0">
              <div className="flex flex-wrap items-center gap-2 border-b p-3">
                <span className="text-sm font-medium">
                  <Trans>Bookings</Trans>
                </span>
                <div className="ml-auto w-44 max-sm:w-36">
                  <Select
                    value={statusFilter}
                    onValueChange={(v) => void onFilterStatus(v)}
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

              {bookings.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  <Trans>No bookings match.</Trans>
                </div>
              ) : (
                <ScrollArea viewportClassName="max-h-[55vh]" className="w-full">
                  <div className="flex flex-col divide-y">
                    {bookings.map((b) => (
                      <div key={b.id} className="flex flex-wrap items-center gap-2 p-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {b.customerName || b.customerEmail || t`(no name)`}
                            </span>
                            <Badge variant={STATUS_TONE[b.status] ?? "secondary"}>{b.status}</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {inZone(b.start, current?.timeZone ?? "UTC")} · {b.source}
                          </div>
                        </div>
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
                          {b.status === "confirmed" && (
                            <Button
                              variant="outline"
                              onClick={() =>
                                void patchBooking(b, "no_show", () => bookingApi.noShow(b.id), t`Marked as a no-show.`)
                              }
                            >
                              <Trans>No-show</Trans>
                            </Button>
                          )}
                          {(b.status === "confirmed" || b.status === "held") && (
                            <Button
                              variant="destructive"
                              onClick={() =>
                                void patchBooking(
                                  b,
                                  "cancelled",
                                  () => bookingApi.cancel(b.id),
                                  t`Cancelled — the slot is free again.`,
                                )
                              }
                            >
                              <Trans>Cancel</Trans>
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ── resource editor ─────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl [&>*]:min-w-0">
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

          <ScrollArea
            viewportClassName="max-h-[calc(85vh-10rem)] max-[640px]:max-h-[calc(85vh-15rem)]"
            className="w-full"
          >
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
                  <Input readOnly value={link} className="mt-2 font-mono text-xs" />
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
                    onValueChange={(v) =>
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
                      onValueChange={(v) =>
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
                      onValueChange={(v) =>
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
          </ScrollArea>

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

      {/* ── operator booking ────────────────────────────────────────────── */}
      <Dialog
        open={bookOpen}
        onOpenChange={(v) => {
          setBookOpen(v);
          if (!v) setManageLink(null);
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden [&>*]:min-w-0">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              <Trans>Add a booking</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Taken over the phone, so it is not limited to the published times — but a slot that
                is already full is still refused.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <ScrollArea
            viewportClassName="max-h-[calc(85vh-10rem)] max-[640px]:max-h-[calc(85vh-15rem)]"
            className="w-full"
          >
            <div className="grid gap-4 p-1">
              {manageLink && (
                <Card className="border-primary/40 bg-primary/5 p-3">
                  <div className="text-sm font-medium">
                    <Trans>Their link to change or cancel</Trans>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>Shown once. It also went out with the confirmation email.</Trans>
                  </p>
                  <Input readOnly value={manageLink} className="mt-2 font-mono text-xs" />
                </Card>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="bk-start">
                  <Trans>Starts</Trans>
                </Label>
                <Input
                  id="bk-start"
                  type="datetime-local"
                  value={bookForm.start}
                  onChange={(e) => setBookForm({ ...bookForm, start: e.target.value })}
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
          </ScrollArea>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setBookOpen(false)}>
              <Trans>Close</Trans>
            </Button>
            <Button onClick={() => void onBook()} disabled={busy}>
              {busy ? <Trans>Booking…</Trans> : <Trans>Book</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
