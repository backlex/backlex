import type { PushToast } from "../../../types";
import { useCallback, useEffect, useMemo, useRef, useState, } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import { I } from "../../../icons";
import { Select } from "../../../select";
import { Button, EmptyState, PageHeader } from "../../../ui";
import {
  bookingApi,
  collectionsApi,
  type ApiBooking,
  type ApiBookingQuestion,
  type ApiBookingResource,
  type ApiBookingRule,
} from "../../../api";
import { BookingSkeleton } from "../../../page-skeletons";
import { DatePicker } from "@/components/date-picker";
import { TimeField } from "@/components/time-field";
import { ConfirmAction } from "@/components/confirm-action";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import {
  ACCENTS,
  type PublicAppearance,
} from "@/lib/public-theme";
import { asOneOf } from "../../../types";
import { CopyLink, Detail, PAGE_SIZE, PUBLIC_FONTS, PUBLIC_THEMES, ResourceCard, STATUS_TONE, StatTile, TABS, Tab, tokenCache } from "./parts";
import { MAX_QUESTIONS, QUESTION_TYPES, blankQuestion, questionKind, questionName, slugKey } from "./questions";
import { DEFAULT_FORM, DEFAULT_RECORD_COLLECTION, MIRROR_KEYS, Problem, bodyOf, problemWith } from "./records";
import { DEFAULT_BREAK, DEFAULT_OPEN, RULE_KINDS, blankRule, isBreakRule, readBreak } from "./rules";
import { COMMON_ZONES, DAY_SETS, WEEKDAYS, DaySet, HORIZON_DAYS, WINDOWS, WindowKey, inZone, isOver, rangeInZone, shortInZone, shortWeekday, todayIn } from "./time";

/**
 * Availability & booking — what is bookable, when it is open, and who is coming.
 *
 * The page is the forms page's shape, because it is the forms page's job: a
 * list of published things, and one of them open. So it is a grid of resource
 * cards, and opening one replaces the page with a toolbar and five tabs —
 * Hours, Questions, Bookings, Share, Settings. An operator who has published a
 * form already knows how to drive this.
 *
 * Two consequences of that shape are worth knowing before editing:
 *
 * - **Edits autosave**, as the form builder's do. There is no Save button and
 *   no dialog to close, so the working copy is the page. A draft that cannot
 *   legally be saved — a rule that ends before it starts, two questions
 *   claiming one stored name — is not sent at all; the toolbar says why and
 *   the answer stays on screen until it is fixed. Silently POSTing a broken
 *   draft every 700ms would be worse than not saving.
 * - **The public link is shown once.** Only its hash is stored, so the Share
 *   tab can only show a link this browser minted this session (`tokenCache`);
 *   otherwise all it can offer is a replacement. Same posture as the forms
 *   page, and for the same reason.
 */

export function BookingPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [resources, setResources] = useState<ApiBookingResource[]>([]);
  const [bookings, setBookings] = useState<ApiBooking[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Which resource is open, or null for the list. The whole page turns on it. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("hours");

  const [statusFilter, setStatusFilter] = useState("");
  const [windowKey, setWindowKey] = useState<WindowKey>("upcoming");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  /** Next-7-days plan per resource: what is taken, what is left. One store for
   *  both the list cards and the open resource's strip, so the number a card
   *  shows and the number behind it agree after a cancellation. */
  const [stats, setStats] = useState<
    Record<string, { booked: number; free: number; nextFree: string | null }>
  >({});

  const [detail, setDetail] = useState<ApiBooking | null>(null);
  const [moveAt, setMoveAt] = useState<string>("");

  /* ── the open resource's working copy — edits autosave ───────────────── */
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [rules, setRules] = useState<ApiBookingRule[]>([blankRule()]);
  const [questions, setQuestions] = useState<ApiBookingQuestion[]>([]);
  /** How the public page paints itself. Empty = ours: the visitor's own
   *  light/dark preference and our accent, which is what every calendar
   *  created before this panel existed still means. */
  const [look, setLook] = useState<PublicAppearance>({});
  /** Only read when the resource points at a collection of its own — the
   *  provisioned default derives its map, so there is nothing to edit. */
  const [mirrorMap, setMirrorMap] = useState<Record<string, string>>({});
  /** What the panel names as the destination. The server resolves the same
   *  thing into `recordCollection`; this is the working copy's answer, so the
   *  sentence updates as the operator changes the setting rather than after
   *  the next save. */
  const recordTarget = form.mirrorCollection.trim() || DEFAULT_RECORD_COLLECTION;
  /** Slugs offered by the "my own collection" escape hatch. Fetched once and
   *  only used there, so a failure leaves the default path untouched. */
  const [collections, setCollections] = useState<string[]>([]);
  /** Names that already have answers stored against them. Retyping the label of
   *  such a question must NOT move its name: the answers on every booking taken
   *  so far are keyed by it, and a mirror map may point a column at it. */
  const [storedNames, setStoredNames] = useState<Set<string>>(() => new Set());
  const [customZone, setCustomZone] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "blocked" | "error">("saved");
  const [saveNote, setSaveNote] = useState<string | null>(null);

  /* ── creating one ────────────────────────────────────────────────────── */
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState({ key: "", name: "", timeZone: DEFAULT_FORM.timeZone, keyTouched: false });

  const [bookOpen, setBookOpen] = useState(false);
  const [bookForm, setBookForm] = useState({ start: "", name: "", email: "", phone: "", notes: "" });
  /** The resource's own questions, as the operator heard them on the phone.
   *  Held as strings; a yes/no becomes a real boolean on the way out. */
  const [bookAnswers, setBookAnswers] = useState<Record<string, string>>({});
  /** Set once a booking lands: the dialog becomes a receipt rather than an
   *  empty form, because the manage link is shown exactly once. */
  const [booked, setBooked] = useState<{
    url: string;
    booking: ApiBooking;
    /** A move ends on the same receipt — the link is reminted either way. */
    moved?: boolean;
  } | null>(null);

  const current = useMemo(
    () => resources.find((r) => r.key === openKey) ?? null,
    [resources, openKey],
  );
  /** The strip and the booking rows read the WORKING copy, not the saved row:
   *  a zone changed a second ago has to move the times on screen with it. */
  const zone = form.timeZone || current?.timeZone || "UTC";

  /** Which side of "now" a booking sits on decides what can be done to it, so
   *  the clock is state rather than a read at render time — a slot that passes
   *  while the page is open changes the row without a reload. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // The escape hatch's options. Deliberately not blocking anything: a workspace
  // whose collections fail to load still records into the default, which is the
  // path that needs no list at all.
  useEffect(() => {
    let alive = true;
    collectionsApi
      .list()
      .then((res) => {
        if (alive) setCollections((res.data ?? []).map((c) => c.slug).sort());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
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
      // An explicit status is the operator asking for exactly that one, so it
      // overrides the window's own idea of what is worth showing.
      ...(w.live && !status ? { live: "true" } : {}),
      order: w.order,
      limit: String(PAGE_SIZE),
      offset: String(from),
    });
    setBookings((res.data ?? []) as ApiBooking[]);
    setTotal(res.total ?? 0);
    setOffset(from);
  };

  /**
   * What the next week looks like for one resource: how much of the published
   * grid is taken and how much is left. `slots` only returns what is still
   * free, so "taken" comes from the bookings themselves rather than from
   * subtracting one from the other — a booking made off-grid by an operator
   * belongs in the count too.
   */
  const loadPlan = async (resourceKey: string) => {
    const from = new Date();
    const to = new Date(from.getTime() + HORIZON_DAYS * 86400_000);
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
      setStats((m) => ({
        ...m,
        [resourceKey]: {
          booked: taken,
          free: open.reduce((sum, s) => sum + s.remaining, 0),
          nextFree: open[0]?.start ?? null,
        },
      }));
    } catch {
      // A resource with no rules answers with an empty grid rather than an
      // error, so anything thrown here is worth staying quiet about — the
      // strip simply does not claim a number it does not have.
      setStats((m) => ({ ...m, [resourceKey]: { booked: 0, free: 0, nextFree: null } }));
    }
  };

  /**
   * The three numbers under every card on the list.
   *
   * The same read the open resource's strip uses, once per card, rather than a
   * second way of counting the same thing: one un-filtered list grouped by
   * `resourceId` would save a request per card, but it would be a second
   * implementation of "how full is the next week" to keep in step with this
   * one — and the endpoint caps a page at 200 rows, so on a busy workspace it
   * would quietly answer with a number that is merely most of the truth.
   *
   * Each card fills in as its own answer lands rather than the grid waiting on
   * the slowest one.
   */
  const loadCardStats = async (rows: ApiBookingResource[]) => {
    await Promise.all(rows.map((r) => loadPlan(r.key)));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await bookingApi.listResources();
        if (cancelled) return;
        const rows = (res.data ?? []) as ApiBookingResource[];
        setResources(rows);
        if (rows.length > 0) void loadCardStats(rows);
      } catch {
        // Leave the list empty; the page still offers "New resource".
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── autosave ────────────────────────────────────────────────────────── */

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Assigned every render so the timer never fires against a stale draft.
  const draftRef = useRef({ form, rules, questions, look, mirrorMap });
  draftRef.current = { form, rules, questions, look, mirrorMap };
  const openKeyRef = useRef<string | null>(openKey);
  openKeyRef.current = openKey;
  /**
   * Which resource the working copy was actually loaded FOR.
   *
   * Every write here replaces a resource's rules wholesale, so a save that
   * fires against a draft belonging to some other resource — or to no resource,
   * the initial `[blankRule()]` — does not edit a calendar, it flattens one.
   * `openKey` alone cannot rule that out: it is set by the click, while the
   * draft is filled by the render that follows. Both the timer and the flush
   * refuse unless the two agree.
   */
  const hydratedKey = useRef<string | null>(null);

  /** The one place a problem code becomes a sentence — inside the component,
   *  where the `t` macro is the real one. */
  const sayProblem = useCallback(
    (p: Problem): string => {
      switch (p.code) {
        case "name":
          return t`Give the resource a name.`;
        case "rule-order":
          return t`Each rule must start before it ends. A span crossing midnight is two rules.`;
        case "rule-dates":
          return t`A rule with no weekday needs a date range.`;
        case "rule-range":
          return t`A date range has to end on or after the day it starts.`;
        case "question-label":
          return t`Give every question a label.`;
        case "question-duplicate":
          return t`Two questions share the stored name "${p.name}". Names have to be unique.`;
        case "mirror-map":
          return t`Say which column of "${p.collection}" each booking field goes to — a target with no map records nothing.`;
        default:
          return t`"${p.label}" is a choice with nothing to choose from.`;
      }
    },
    [t],
  );

  const scheduleSave = useCallback(() => {
    // Nothing is open — this is the create dialog's own state, which is saved
    // by pressing a button rather than by typing.
    if (!openKeyRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const key = openKeyRef.current;
      if (!key || hydratedKey.current !== key) return;
      const d = draftRef.current;
      const problem = problemWith(d);
      if (problem) {
        setSaveNote(sayProblem(problem));
        setSaveState("blocked");
        return;
      }
      setSaveNote(null);
      try {
        const res = await bookingApi.updateResource(key, bodyOf(d));
        setResources((arr) => arr.map((r) => (r.key === key ? res.data : r)));
        setSaveState("saved");
      } catch (e) {
        setSaveState("error");
        pushToast((e as Error).message);
      }
    }, 700);
  }, [pushToast, sayProblem]);

  /**
   * Send whatever the timer was still holding, now.
   *
   * The 700ms that makes typing one save is also 700ms in which the work can
   * be walked away from — back to the list, or off the page entirely — and a
   * debounce that only ever cancels loses precisely the last thing anybody
   * typed. Held in a ref so the unmount cleanup can call the current one
   * without re-running on every render.
   */
  const flushSave = useCallback(() => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const key = openKeyRef.current;
    const d = draftRef.current;
    // A draft that could not be saved on the timer cannot be saved on the way
    // out either; the reason was already on screen.
    if (!key || hydratedKey.current !== key || problemWith(d)) return;
    void bookingApi
      .updateResource(key, bodyOf(d))
      .then((res) => setResources((arr) => arr.map((r) => (r.key === key ? res.data : r))))
      .catch((e) => pushToast((e as Error).message));
  }, [pushToast]);

  const flushRef = useRef(flushSave);
  flushRef.current = flushSave;

  // A page left mid-keystroke should still land the last edit.
  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  const patchForm = (patch: Partial<typeof DEFAULT_FORM>) => {
    setForm((f) => ({ ...f, ...patch }));
    scheduleSave();
  };
  const editRules = (fn: (arr: ApiBookingRule[]) => ApiBookingRule[]) => {
    setRules(fn);
    scheduleSave();
  };
  const editQuestions = (fn: (arr: ApiBookingQuestion[]) => ApiBookingQuestion[]) => {
    setQuestions(fn);
    scheduleSave();
  };
  const editLook = (fn: (l: PublicAppearance) => PublicAppearance) => {
    setLook(fn);
    scheduleSave();
  };
  const editMirrorMap = (fn: (m: Record<string, string>) => Record<string, string>) => {
    setMirrorMap(fn);
    scheduleSave();
  };

  /* ── hours: bulk add, and the break ──────────────────────────────────── */

  const brk = readBreak(rules);

  /** Add one opening per day in the set, skipping a day that already has that
   *  exact opening — "add weekdays" twice should not leave five duplicates. */
  const addOpenings = (set: DaySet) => {
    editRules((arr) => {
      const next = [...arr];
      for (const weekday of DAY_SETS[set]) {
        const dupe = next.some(
          (r) =>
            r.kind === "open" &&
            r.weekday === weekday &&
            r.startMinute === DEFAULT_OPEN.startMinute &&
            r.endMinute === DEFAULT_OPEN.endMinute,
        );
        if (dupe) continue;
        next.push({ ...blankRule(), weekday, ...DEFAULT_OPEN });
      }
      return next;
    });
  };

  /** The days a new break should cover: the ones actually open, because a
   *  closure on a day nothing is offered on is a row that does nothing. */
  const openWeekdays = (): number[] => {
    const days = [...new Set(rules.filter((r) => r.kind === "open" && r.weekday !== null).map((r) => Number(r.weekday)))];
    return days.length > 0 ? days.sort((a, b) => a - b) : [...DAY_SETS.weekdays];
  };

  const addBreak = () => {
    editRules((arr) => [
      ...arr,
      ...openWeekdays().map((weekday) => ({
        kind: "block" as const,
        weekday,
        ...DEFAULT_BREAK,
        startsOn: null,
        endsOn: null,
        reason: null,
      })),
    ]);
  };

  /** Move every row the card speaks for to new hours at once. */
  const setBreakTimes = (patch: { startMinute?: number; endMinute?: number }) => {
    editRules((arr) => arr.map((r) => (isBreakRule(r, brk) ? { ...r, ...patch } : r)));
  };

  const toggleBreakDay = (weekday: number) => {
    if (!brk) return;
    editRules((arr) =>
      brk.weekdays.includes(weekday)
        ? arr.filter((r) => !(isBreakRule(r, brk) && r.weekday === weekday))
        : [
            ...arr,
            {
              kind: "block" as const,
              weekday,
              startMinute: brk.startMinute,
              endMinute: brk.endMinute,
              startsOn: null,
              endsOn: null,
              reason: null,
            },
          ],
    );
  };

  const removeBreak = () => editRules((arr) => arr.filter((r) => !isBreakRule(r, brk)));

  /* ── opening and closing a resource ──────────────────────────────────── */

  const openResource = (r: ApiBookingResource, at: Tab = "hours") => {
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
      mirrorEnabled: r.mirrorEnabled !== false,
      mirrorCollection: r.mirrorCollection ?? "",
      active: r.active,
    });
    setMirrorMap({ ...(r.mirrorFieldMap ?? {}) });
    setRules(r.rules.length > 0 ? r.rules.map((x) => ({ ...x })) : [blankRule()]);
    setQuestions(
      (r.questions ?? []).map((q) => ({
        name: String(q.name ?? ""),
        label: String(q.label ?? ""),
        type: (q.type as ApiBookingQuestion["type"]) ?? "text",
        required: q.required === true,
        options: Array.isArray(q.options) ? q.options.map(String) : [],
      })),
    );
    setStoredNames(new Set((r.questions ?? []).map((q) => String(q.name ?? ""))));
    setLook({ ...(r.settings ?? {}) });
    setCustomZone(!COMMON_ZONES.includes(r.timeZone));
    setSaveState("saved");
    setSaveNote(null);
    setStatusFilter("");
    setWindowKey("upcoming");
    setBookings([]);
    setTotal(0);
    setOffset(0);
    hydratedKey.current = r.key;
    setOpenKey(r.key);
    setTab(at);
    void loadPlan(r.key);
    void loadBookings(r.key).catch(() => {});
  };

  const closeResource = () => {
    // Whatever is pending goes now rather than on a timer nobody is watching.
    flushSave();
    hydratedKey.current = null;
    setOpenKey(null);
    setDetail(null);
  };

  /* ── bookings list ───────────────────────────────────────────────────── */

  const onFilterStatus = async (next: string) => {
    setStatusFilter(next);
    try {
      await loadBookings(openKey ?? undefined, next || undefined, windowKey, 0);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onFilterWindow = async (next: string) => {
    const win = (next in WINDOWS ? next : "upcoming") as WindowKey;
    setWindowKey(win);
    try {
      await loadBookings(openKey ?? undefined, statusFilter || undefined, win, 0);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onPage = async (next: number) => {
    try {
      await loadBookings(openKey ?? undefined, statusFilter || undefined, windowKey, next);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  /** Every mutation re-reads the same page it was fired from, so the counts in
   *  the strip and the row itself never drift apart. */
  const refreshAfterMutation = () => {
    if (!openKey) return;
    void loadPlan(openKey);
    void loadBookings(openKey, statusFilter || undefined, windowKey, offset).catch(() => {});
  };

  /* ── create / rotate / delete ────────────────────────────────────────── */

  const onCreate = async () => {
    if (!draft.name.trim()) {
      pushToast(t`Give the resource a name.`);
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(draft.key.trim())) {
      pushToast(t`The key must be lowercase letters, digits, dash or underscore.`);
      return;
    }
    setBusy(true);
    try {
      const res = await bookingApi.createResource({
        key: draft.key.trim(),
        ...bodyOf({
          form: {
            ...DEFAULT_FORM,
            key: draft.key.trim(),
            name: draft.name.trim(),
            timeZone: draft.timeZone.trim(),
          },
          rules: [blankRule()],
          questions: [],
          look: {},
          mirrorMap: {},
        }),
      });
      const row = res.data.resource as ApiBookingResource;
      setResources((arr) => [...arr, row]);
      // Shown once — only the hash is stored, so it is held for as long as
      // this tab lives and the Share tab is where it is read from.
      tokenCache.set(row.key, res.data.url);
      setNewOpen(false);
      setDraft({ key: "", name: "", timeZone: DEFAULT_FORM.timeZone, keyTouched: false });
      openResource(row);
      pushToast(t`Created — the public link is on the Share tab.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRotate = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const res = await bookingApi.rotateToken(current.key);
      tokenCache.set(current.key, res.data.url);
      setTab("share");
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
    if (openKey === r.key) setOpenKey(null);
    try {
      await bookingApi.deleteResource(r.key);
      tokenCache.delete(r.key);
      pushToast(t`Deleted.`);
    } catch (e) {
      setResources(snapshot);
      pushToast((e as Error).message);
    }
  };

  /* ── bookings ────────────────────────────────────────────────────────── */

  const onBook = async () => {
    if (!current) return;
    if (!bookForm.start.trim()) {
      pushToast(t`Pick a start time.`);
      return;
    }
    // Required questions bind the public page, not this one — an operator
    // taking a call may not have asked yet, and losing the appointment over it
    // would be the wrong trade. Whatever WAS answered still travels.
    const answers: Record<string, unknown> = {};
    for (const q of current.questions ?? []) {
      const raw = bookAnswers[String(q.name)];
      if (raw === undefined || raw === "") continue;
      answers[String(q.name)] = questionKind(q) === "boolean" ? raw === "true" : raw;
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
        ...(Object.keys(answers).length > 0 ? { answers } : {}),
      });
      setBookings((arr) => [res.data.booking, ...arr]);
      setBooked({ url: res.data.manageUrl, booking: res.data.booking });
      setBookForm({ start: "", name: "", email: "", phone: "", notes: "" });
      setBookAnswers({});
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
      if (openKey) void loadPlan(openKey);
    } catch (e) {
      setBookings(snapshot);
      setDetail((d) => (d && d.id === b.id ? b : d));
      pushToast((e as Error).message);
    }
  };

  /**
   * Record a booking again after a failure.
   *
   * Not routed through `patchBooking`: nothing about the booking's own status
   * changes, so there is no optimistic next-state to show — the honest
   * optimistic move is clearing the error, and putting it back if the retry
   * fails for the same reason it failed the first time.
   */
  const onRecordAgain = async (b: ApiBooking) => {
    const snapshot = bookings;
    setBookings((arr) => arr.map((x) => (x.id === b.id ? { ...x, mirrorError: null } : x)));
    setDetail((d) => (d && d.id === b.id ? { ...d, mirrorError: null } : d));
    try {
      const res = await bookingApi.record(b.id);
      setBookings((arr) => arr.map((x) => (x.id === b.id ? res.data : x)));
      setDetail((d) => (d && d.id === b.id ? res.data : d));
      pushToast(t`Recorded.`);
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
  const plan = openKey ? stats[openKey] : undefined;
  const link = current ? tokenCache.get(current.key) : undefined;

  if (!loaded) return <BookingSkeleton />;

  /* ── the create dialog, shared by both views ─────────────────────────── */

  const newDialog = (
    <Dialog open={newOpen} onOpenChange={setNewOpen}>
      <DialogContent className="[&>*]:min-w-0">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>New bookable resource</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Enough to create it — the opening hours, the questions and the rest are set on the
              resource itself.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4 p-1">
            <div className="grid gap-1.5">
              <Label htmlFor="bk-new-name">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="bk-new-name"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    name: e.target.value,
                    // The key follows the name until it is typed into directly,
                    // which is the only moment it can still be chosen.
                    key: d.keyTouched ? d.key : slugKey(e.target.value),
                  }))
                }
                placeholder={t`Dr Yılmaz`}
              />
              <p className="text-xs text-muted-foreground">
                <Trans>Shown on the public page.</Trans>
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bk-new-key">
                <Trans>Key</Trans>
              </Label>
              <Input
                id="bk-new-key"
                value={draft.key}
                onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value, keyTouched: true }))}
                placeholder="clinic"
              />
              <p className="text-xs text-muted-foreground">
                <Trans>How the API and CLI address it. Cannot be changed later.</Trans>
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label>
                <Trans>Time zone</Trans>
              </Label>
              <Select
                value={COMMON_ZONES.includes(draft.timeZone) ? draft.timeZone : "__custom"}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, timeZone: v === "__custom" ? "" : v }))
                }
                className="min-w-0"
                options={[
                  ...COMMON_ZONES.map((z) => ({ value: z, label: z })),
                  { value: "__custom", label: t`Custom…` },
                ]}
              />
              {!COMMON_ZONES.includes(draft.timeZone) && (
                <Input
                  value={draft.timeZone}
                  onChange={(e) => setDraft((d) => ({ ...d, timeZone: e.target.value }))}
                  placeholder="Europe/Istanbul"
                />
              )}
              <p className="text-xs text-muted-foreground">
                <Trans>The zone the opening hours are written in — not a display preference.</Trans>
              </p>
            </div>
          </div>
        </DialogBody>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => setNewOpen(false)}>
            <Trans>Close</Trans>
          </Button>
          <Button onClick={() => void onCreate()} disabled={busy}>
            {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  /* ── list ────────────────────────────────────────────────────────────── */

  if (!openKey || !current) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t`Booking`}
          description={t`Publish a calendar people can pick a time from, and see who did.`}
          actions={
            <Button
              variant="primary"
              onClick={() => {
                setDraft({ key: "", name: "", timeZone: DEFAULT_FORM.timeZone, keyTouched: false });
                setNewOpen(true);
              }}
              className="ml-auto"
            >
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
              <Button
                variant="primary"
                icon={I.Plus}
                onClick={() => {
                  setDraft({ key: "", name: "", timeZone: DEFAULT_FORM.timeZone, keyTouched: false });
                  setNewOpen(true);
                }}
              >
                <Trans>New resource</Trans>
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {resources.map((r) => (
              <ResourceCard
                key={r.key}
                resource={r}
                stats={stats[r.key]}
                onOpen={() => openResource(r)}
              />
            ))}
          </div>
        )}

        {newDialog}
      </div>
    );
  }

  /* ── one resource ────────────────────────────────────────────────────── */

  const saveIndicator = (
    <span
      className={cn(
        "flex items-center gap-1 text-[11.5px]",
        saveState === "blocked" || saveState === "error"
          ? "text-destructive"
          : "text-muted-foreground",
      )}
      title={saveNote ?? undefined}
    >
      {saveState === "saving" ? (
        <Trans>saving…</Trans>
      ) : saveState === "error" ? (
        <Trans>save failed</Trans>
      ) : saveState === "blocked" ? (
        <Trans>not saved</Trans>
      ) : (
        <>
          <I.Check size={12} />
          <Trans>saved</Trans>
        </>
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          title={t`Back to resources`}
          onClick={closeResource}
          className="grid size-[30px] shrink-0 place-items-center rounded-[8px] border border-white/10 bg-white/[0.03] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <I.ChevronLeft size={14} />
        </button>
        <div className="min-w-0 flex-1 sm:flex-none">
          <div className="truncate text-[14.5px] font-semibold">{form.name || current.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {current.key} · {zone}
          </div>
        </div>
        {/* Mobile: the save indicator rides the title row (right edge); the
            fixed-width desktop copy below keeps the centered tabs stable. */}
        <span className="shrink-0 sm:hidden">{saveIndicator}</span>
        {/* Five tabs do not fit a phone with their labels on, so the label is
            the thing that goes — an icon row still reads, a squeezed strip of
            half-words does not. */}
        <div className="flex w-full justify-center sm:mx-auto sm:w-auto">
          <div className="flex items-center gap-0.5 rounded-[10px] border border-white/10 bg-white/5 p-[3px]">
            {TABS.map((tb) => {
              const Icon =
                tb === "hours"
                  ? I.Clock
                  : tb === "questions"
                    ? I.MessageSquare
                    : tb === "bookings"
                      ? I.CalendarDays
                      : tb === "share"
                        ? I.Share
                        : I.Settings;
              return (
                <button
                  key={tb}
                  type="button"
                  onClick={() => setTab(tb)}
                  title={
                    tb === "hours"
                      ? t`Hours`
                      : tb === "questions"
                        ? t`Questions`
                        : tb === "bookings"
                          ? t`Bookings`
                          : tb === "share"
                            ? t`Share`
                            : t`Settings`
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors sm:px-3.5",
                    tab === tb
                      ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon size={14} className="shrink-0 sm:hidden" />
                  <span className="max-sm:sr-only">
                    {tb === "hours" ? (
                      <Trans>Hours</Trans>
                    ) : tb === "questions" ? (
                      <Trans>Questions</Trans>
                    ) : tb === "bookings" ? (
                      <Trans>Bookings</Trans>
                    ) : tb === "share" ? (
                      <Trans>Share</Trans>
                    ) : (
                      <Trans>Settings</Trans>
                    )}
                  </span>
                  {tb === "bookings" && total > 0 && (
                    <span
                      className={cn(
                        "font-mono text-[10px] tabular-nums",
                        tab === tb ? "text-primary" : "",
                      )}
                    >
                      {total}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {/* fixed width so saved↔saving… can't shift the centered tab strip */}
        <span className="hidden w-[76px] shrink-0 justify-end sm:flex">{saveIndicator}</span>
        {/* Actions hug the right edge on mobile (own row via ml-auto). */}
        <div className="ml-auto flex items-center gap-2.5 sm:ml-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">
              {form.active ? t`live` : t`paused`}
            </span>
            <Switch
              checked={form.active}
              onCheckedChange={(v) => patchForm({ active: v })}
            />
          </div>
          <ConfirmAction
            title={t`Delete this resource?`}
            description={t`Its rules and its public link go with it. A resource with upcoming bookings is refused — cancel or move those first.`}
            actionLabel={t`Delete`}
            destructive
            onConfirm={() => onDelete(current)}
          >
            <button
              type="button"
              title={t`Delete resource`}
              className="grid size-[30px] shrink-0 place-items-center rounded-[8px] border border-white/10 bg-white/[0.03] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <I.Trash size={14} />
            </button>
          </ConfirmAction>
          <Button
            variant="primary"
            icon={I.ExternalLink}
            onClick={() => {
              if (link) window.open(link, "_blank");
              else {
                setTab("share");
                pushToast(t`Mint a link first — the token is only shown once.`);
              }
            }}
          >
            <Trans>Open page</Trans>
          </Button>
        </div>
      </div>

      {/* Why nothing is being written. A tooltip on the word "not saved" is
          not enough for this: the operator is typing into a page that has
          quietly stopped saving, and the one thing they need is the sentence
          that says which field to go back to. */}
      {saveState === "blocked" && saveNote && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-surface border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive"
        >
          <I.AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{saveNote}</span>
        </div>
      )}

      {/* ── hours ─────────────────────────────────────────────────────── */}
      {tab === "hours" && (
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
      )}

      {/* ── questions ─────────────────────────────────────────────────── */}
      {tab === "questions" && (
        <Card className="gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                <Trans>Intake questions</Trans>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>
                  What the booker is asked beyond name, email and phone. The answers ride along with
                  the booking and can be mapped into the mirrored collection.
                </Trans>
              </p>
            </div>
            <Button
              variant="outline"
              className="ml-auto"
              disabled={questions.length >= MAX_QUESTIONS}
              onClick={() => editQuestions((arr) => [...arr, blankQuestion()])}
            >
              <I.Plus className="size-4" />
              <span className="max-sm:sr-only">
                <Trans>Add question</Trans>
              </span>
            </Button>
          </div>

          {questions.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              <Trans>No questions — the page asks only for name, email and phone.</Trans>
            </p>
          ) : (
            questions.map((q, i) => {
              const locked = storedNames.has(q.name);
              const patch = (next: Partial<ApiBookingQuestion>) =>
                editQuestions((arr) => arr.map((x, j) => (j === i ? { ...x, ...next } : x)));
              return (
                <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_170px_auto]">
                  <div className="grid min-w-0 gap-1">
                    <Input
                      value={q.label ?? ""}
                      onChange={(e) =>
                        patch({
                          label: e.target.value,
                          // A question nobody has answered yet still has its
                          // name follow the label; once answers exist the name
                          // is frozen.
                          ...(locked ? {} : { name: questionName(e.target.value) }),
                        })
                      }
                      placeholder={t`Reason for visit`}
                    />
                    {q.name && (
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{q.name}</p>
                    )}
                  </div>
                  <Select
                    value={q.type ?? "text"}
                    onChange={(v) => patch({ type: asOneOf(QUESTION_TYPES, v, "text") })}
                    className="min-w-0"
                    options={[
                      { value: "text", label: t`Short text` },
                      { value: "textarea", label: t`Long text` },
                      { value: "select", label: t`Choice` },
                      { value: "boolean", label: t`Yes / no` },
                    ]}
                  />
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`bk-q-req-${i}`}
                        checked={q.required === true}
                        onCheckedChange={(v) => patch({ required: v })}
                      />
                      <Label htmlFor={`bk-q-req-${i}`} className="text-xs">
                        <Trans>Required</Trans>
                      </Label>
                    </div>
                    <Button
                      variant="outline"
                      className="ml-auto"
                      onClick={() => editQuestions((arr) => arr.filter((_, j) => j !== i))}
                    >
                      <I.Trash className="size-4" />
                      <span className="sr-only">
                        <Trans>Remove question</Trans>
                      </span>
                    </Button>
                  </div>
                  {q.type === "select" && (
                    <div className="grid gap-1 sm:col-span-3">
                      <Input
                        value={(q.options ?? []).join(", ")}
                        onChange={(e) =>
                          // Empty entries survive the keystroke on purpose —
                          // dropping them here would eat the comma the operator
                          // just typed. `bodyOf` filters them on the way out.
                          patch({ options: e.target.value.split(",").map((o) => o.trim()) })
                        }
                        placeholder={t`Check-up, Follow-up, Emergency`}
                      />
                      <p className="text-xs text-muted-foreground">
                        <Trans>Comma-separated. The page offers exactly these.</Trans>
                      </p>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </Card>
      )}

      {/* ── bookings ──────────────────────────────────────────────────── */}
      {tab === "bookings" && (
        <>
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
              value={plan?.nextFree ? shortInZone(plan.nextFree, zone) : "—"}
              sub={plan?.nextFree ? zone : t`nothing open in the window`}
            />
          </div>

          <Card className="p-0">
            <div className="flex flex-wrap items-center gap-2 border-b p-3">
              <span className="text-sm font-medium">
                <Trans>Bookings</Trans>
              </span>
              <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setBookOpen(true)}>
                  <I.Plus className="size-4" />
                  <span className="max-sm:sr-only">
                    <Trans>Add booking</Trans>
                  </span>
                </Button>
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
                          {inZone(b.start, zone)} · {b.source}
                        </div>
                        {/* Recording is best-effort, so a failure has to be
                            visible somewhere or a workspace finds out months
                            later that nothing was written. */}
                        {b.mirrorError ? (
                          <div className="truncate text-xs text-destructive" title={b.mirrorError}>
                            <Trans>Not recorded — {b.mirrorError}</Trans>
                          </div>
                        ) : null}
                      </button>
                      <div className="flex flex-wrap items-center gap-1">
                        {b.mirrorError ? (
                          <Button
                            variant="outline"
                            title={t`Try recording it into the collection again.`}
                            onClick={() => void onRecordAgain(b)}
                          >
                            <Trans>Record again</Trans>
                          </Button>
                        ) : null}
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
        </>
      )}

      {/* ── share ─────────────────────────────────────────────────────── */}
      {tab === "share" && (
        <Card className="gap-3 p-4">
          <div className="text-sm font-medium">
            <Trans>The public booking link</Trans>
          </div>
          {link ? (
            <>
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Copy it now. Only its hash is stored, so nothing can show it again once this tab
                  is closed — "New link" mints a replacement and kills this one.
                </Trans>
              </p>
              <CopyLink value={link} pushToast={pushToast} />
              <div className="mt-3 text-sm font-medium">
                <Trans>Or embed it</Trans>
              </div>
              <p className="text-xs text-muted-foreground">
                <Trans>
                  The same link in an iframe. The page is framable on purpose — a booking widget
                  belongs on your site — so there is no second URL to keep track of.
                </Trans>
              </p>
              <CopyLink
                value={`<iframe src="${link}" width="100%" height="720" frameborder="0" title="${form.name || t`Booking`}"></iframe>`}
                pushToast={pushToast}
              />
            </>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              <Trans>
                Only the hash of the link is stored, so the one handed out when this resource was
                created cannot be shown again. Mint a replacement to see one — the old link stops
                working the moment you do.
              </Trans>
            </p>
          )}
          <div className="mt-1">
            <ConfirmAction
              title={t`Mint a new link?`}
              description={t`The link in circulation stops working immediately. Anyone holding it — an email, a QR code, your own website — has to be given the new one.`}
              actionLabel={t`Mint it`}
              destructive
              onConfirm={onRotate}
            >
              <Button variant="outline" disabled={busy}>
                <I.Link className="size-4" />
                <Trans>New link</Trans>
              </Button>
            </ConfirmAction>
          </div>
        </Card>
      )}

      {/* ── settings ──────────────────────────────────────────────────── */}
      {tab === "settings" && (
        <div className="flex flex-col gap-4">
          <Card className="gap-4 p-4">
            <div className="grid gap-1.5">
              <Label htmlFor="bk-name">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="bk-name"
                value={form.name}
                onChange={(e) => patchForm({ name: e.target.value })}
                placeholder={t`Dr Yılmaz`}
              />
              <p className="text-xs text-muted-foreground">
                <Trans>Shown on the public page.</Trans>
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="bk-desc">
                <Trans>Description</Trans>
              </Label>
              <Textarea
                id="bk-desc"
                rows={2}
                value={form.description}
                onChange={(e) => patchForm({ description: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                <Trans>A line under the name, on the public page.</Trans>
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label>
                <Trans>Time zone</Trans>
              </Label>
              {customZone ? (
                <Input
                  value={form.timeZone}
                  onChange={(e) => patchForm({ timeZone: e.target.value })}
                  placeholder="Europe/Istanbul"
                />
              ) : (
                <Select
                  value={form.timeZone}
                  onChange={(v) =>
                    v === "__custom" ? setCustomZone(true) : patchForm({ timeZone: v })
                  }
                  className="min-w-0"
                  options={[
                    ...COMMON_ZONES.map((z) => ({ value: z, label: z })),
                    { value: "__custom", label: t`Custom…` },
                  ]}
                />
              )}
              <p className="text-xs text-muted-foreground">
                <Trans>The zone the opening hours are written in — not a display preference.</Trans>
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
                    onChange={(e) => patchForm({ [field]: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="gap-4 p-4">
            <div className="grid gap-1.5">
              <Label>
                <Trans>Where bookings are recorded</Trans>
              </Label>
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-sm">
                  {form.mirrorEnabled ? (
                    <Trans>
                      Every booking is written as a row in{" "}
                      <span className="font-medium">{recordTarget}</span>, where permissions, flows
                      and exports apply to it as usual.
                    </Trans>
                  ) : (
                    <Trans>
                      Bookings are not recorded anywhere but here. The ledger stays the only place
                      these customers exist.
                    </Trans>
                  )}
                </p>
                <Switch
                  checked={form.mirrorEnabled}
                  onCheckedChange={(v) => patchForm({ mirrorEnabled: v })}
                  aria-label={t`Record bookings into a collection`}
                />
              </div>
              {form.mirrorEnabled && !form.mirrorCollection.trim() ? (
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    The collection is created for you and kept in step — nothing to map. Editing a
                    row there does not move or cancel an appointment.
                  </Trans>
                </p>
              ) : null}
            </div>

            {form.mirrorEnabled ? (
              <details className="group">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  <Trans>Record into a collection of my own instead</Trans>
                </summary>
                <div className="mt-3 grid gap-3">
                  <Select
                    value={form.mirrorCollection}
                    onChange={(v) => patchForm({ mirrorCollection: v })}
                    className="min-w-0"
                    options={[
                      { value: "", label: t`The default collection` },
                      ...collections.map((c) => ({ value: c, label: c })),
                    ]}
                  />
                  {form.mirrorCollection ? (
                    <div className="grid gap-2">
                      <p className="text-xs text-muted-foreground">
                        <Trans>
                          Your collection, your column names — so each booking field needs one. A
                          target with no map records nothing, so saving without one is refused.
                        </Trans>
                      </p>
                      {MIRROR_KEYS.map((key) => (
                        <div key={key} className="grid grid-cols-[7rem_1fr] items-center gap-2">
                          <Label className="truncate text-xs text-muted-foreground">{key}</Label>
                          <Input
                            value={mirrorMap[key] ?? ""}
                            onChange={(e) =>
                              editMirrorMap((m) => {
                                const next = { ...m };
                                const column = e.target.value.trim();
                                if (column) next[key] = column;
                                else delete next[key];
                                return next;
                              })
                            }
                            placeholder={t`column name`}
                            className="min-w-0"
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="bk-confirm">
                <Trans>Confirmation message</Trans>
              </Label>
              <Textarea
                id="bk-confirm"
                rows={2}
                value={form.confirmationMessage}
                onChange={(e) => patchForm({ confirmationMessage: e.target.value })}
                placeholder={t`Please arrive ten minutes early.`}
              />
            </div>
          </Card>

          <Card className="gap-2 p-4">
            <Label>
              <Trans>Public page appearance</Trans>
            </Label>
            <p className="text-xs text-muted-foreground">
              <Trans>
                The booking page belongs on your site, so it takes your colours rather than ours.
                "Visitor's choice" follows each visitor's own light/dark setting — fine for a link
                you send, but pick a theme when you embed it, or a dark widget can land on a light
                page.
              </Trans>
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="bk-theme" className="text-xs text-muted-foreground">
                  <Trans>Theme</Trans>
                </Label>
                <Select
                  value={look.theme ?? ""}
                  onChange={(v) =>
                    editLook(({ theme, ...rest }) => (v ? { ...rest, theme: asOneOf(PUBLIC_THEMES, v, "light") } : rest))
                  }
                  className="min-w-0"
                  options={[
                    { value: "", label: t`Visitor's choice` },
                    { value: "dark", label: t`Dark` },
                    { value: "light", label: t`Light` },
                  ]}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="bk-font" className="text-xs text-muted-foreground">
                  <Trans>Font</Trans>
                </Label>
                <Select
                  // No "default" entry, and unset shows as Manrope: that is
                  // what the page now draws, and it is what the form's own
                  // picker offers. A choice the panel does not name is a choice
                  // an operator cannot see is being made.
                  value={look.font ?? "sans"}
                  onChange={(v) =>
                    editLook(({ font, ...rest }) => (v ? { ...rest, font: asOneOf(PUBLIC_FONTS, v, "sans") } : rest))
                  }
                  className="min-w-0"
                  options={[
                    { value: "sans", label: "Manrope" },
                    { value: "lexend", label: "Lexend" },
                    { value: "mono", label: t`Mono` },
                    { value: "system", label: t`System` },
                  ]}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">
                <Trans>Accent</Trans>
              </Label>
              <ColorSwatchPicker
                options={[
                  { value: "", swatch: "var(--muted-foreground)", label: t`Default` },
                  ...ACCENTS.map((c) => ({ value: c, swatch: c })),
                ]}
                value={look.accent ?? ""}
                onChange={(accent) =>
                  editLook(({ accent: _drop, ...rest }) => (accent ? { ...rest, accent } : rest))
                }
                showValue
              />
            </div>
          </Card>
        </div>
      )}

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
                    {rangeInZone(detail.start, detail.end, zone)}
                  </Detail>
                  <Detail label={<Trans>Email</Trans>}>{detail.customerEmail || "—"}</Detail>
                  <Detail label={<Trans>Phone</Trans>}>{detail.customerPhone || "—"}</Detail>
                  <Detail label={<Trans>Booked via</Trans>}>{detail.source}</Detail>
                  {detail.notes && <Detail label={<Trans>Notes</Trans>}>{detail.notes}</Detail>}
                  {detail.cancelReason && (
                    <Detail label={<Trans>Reason</Trans>}>{detail.cancelReason}</Detail>
                  )}
                  {/* The row truncates it — a reason worth acting on has to be
                      readable in full somewhere, and this is where there is
                      room for it. */}
                  {detail.mirrorError && (
                    <Detail label={<Trans>Not recorded</Trans>}>
                      <span className="text-destructive">{detail.mirrorError}</span>
                    </Detail>
                  )}
                  {/* Read back through the questions rather than raw: the stored
                      key is a column name, and a yes/no is a boolean nobody
                      wants to read as "true". A question deleted since the
                      booking was taken still shows — its answer was given. */}
                  {Object.entries(detail.answers ?? {}).map(([k, v]) => {
                    const q = (current?.questions ?? []).find((x) => String(x.name) === k);
                    return (
                      <Detail key={k} label={String(q?.label || k)}>
                        {typeof v === "boolean"
                          ? v
                            ? t`Yes`
                            : t`No`
                          : typeof v === "string" || typeof v === "number"
                            ? String(v)
                            : JSON.stringify(v)}
                      </Detail>
                    );
                  })}
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
            {detail?.mirrorError && (
              <Button variant="outline" onClick={() => void onRecordAgain(detail)}>
                <Trans>Record again</Trans>
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
                    {rangeInZone(booked.booking.start, booked.booking.end, zone)}
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

                {(current?.questions ?? []).map((q) => {
                  const key = String(q.name ?? "");
                  const options = Array.isArray(q.options) ? q.options.map(String) : [];
                  const kind = questionKind(q);
                  const set = (v: string) => setBookAnswers({ ...bookAnswers, [key]: v });
                  return (
                    <div key={key} className="grid gap-1.5">
                      <Label htmlFor={`bk-c-q-${key}`}>{String(q.label || key)}</Label>
                      {kind === "select" ? (
                        <Select
                          value={bookAnswers[key] ?? ""}
                          onChange={set}
                          className="min-w-0"
                          options={[
                            { value: "", label: t`Not asked` },
                            ...options.map((o) => ({ value: o, label: o })),
                          ]}
                        />
                      ) : kind === "boolean" ? (
                        <Select
                          value={bookAnswers[key] ?? ""}
                          onChange={set}
                          className="min-w-0"
                          options={[
                            { value: "", label: t`Not asked` },
                            { value: "true", label: t`Yes` },
                            { value: "false", label: t`No` },
                          ]}
                        />
                      ) : kind === "textarea" ? (
                        <Textarea
                          id={`bk-c-q-${key}`}
                          rows={2}
                          value={bookAnswers[key] ?? ""}
                          onChange={(e) => set(e.target.value)}
                        />
                      ) : (
                        <Input
                          id={`bk-c-q-${key}`}
                          value={bookAnswers[key] ?? ""}
                          onChange={(e) => set(e.target.value)}
                        />
                      )}
                    </div>
                  );
                })}
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
