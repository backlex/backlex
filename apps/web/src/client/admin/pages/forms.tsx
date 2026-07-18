// Public forms — Tally-style builder implementing the "Backlex Forms" design:
// a card list view, then a full builder with an Edit tab (canvas of blocks +
// insert palette + right settings panel), a Share tab (link / embed / rotate /
// delivery) and a Submissions tab (counters + rows straight from the target
// collection). Changes autosave (debounced PATCH) with a saved indicator; the
// one-time token is cached per-session so Share can show the link right after
// create/rotate and stays honest ("hidden — rotate") otherwise.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Switch,
} from "../ui";
import { Select } from "../select";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@backlex/ui/components/command";
import { Card } from "@backlex/ui/components/card";
import { ColorPicker } from "@backlex/ui/components/color-picker";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ConfirmDialog } from "../sheet";
import {
  collectionsApi,
  formsApi,
  itemsApi,
  type ApiForm,
  type ApiFormBlock,
  type ApiFormEligibleField,
  type ApiFormSettings,
} from "../api";

/* ── helpers ───────────────────────────────────────────────────────── */

let blockSeq = 0;
const newBlockId = () => `b_${Date.now().toString(36)}_${++blockSeq}`;

/** Ensure every block carries a stable client id for selection/reorder. */
const withIds = (blocks: ApiFormBlock[]): ApiFormBlock[] =>
  blocks.map((b) => (b.id ? b : { ...b, id: newBlockId() }));

const humanize = (name: string): string =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (ch) => ch.toUpperCase());

const relTime = (v: unknown): string => {
  if (!v) return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
};

const ACCENTS = [
  "#8B6CFF",
  "#FF8A5C",
  "#34C79A",
  "#4FB7E8",
  "#E85CA8",
  "#F2C14E",
  "#E5484D",
  "#5B8DEF",
];

const blockIcon = (ef: ApiFormEligibleField | null | undefined, block: ApiFormBlock) => {
  if ((block.kind ?? "field") === "step") return I.Layers;
  if (!ef) return I.Type;
  if (ef.choices) return I.LayoutList;
  if (ef.format === "email") return I.Mail;
  if (ef.format === "url") return I.Link;
  switch (ef.type) {
    case "integer":
      return block.rating ? I.Star : I.Hash;
    case "number":
      return I.Hash;
    case "boolean":
      return I.Check;
    case "timestamp":
      return I.Calendar;
    case "longtext":
      return I.Type;
    default:
      return I.Type;
  }
};

/** Session-only cache of the last-minted public URLs per form id — the token
 *  is stored hashed server-side, so a reload legitimately loses these. */
const tokenCache = new Map<string, { url: string; embedUrl: string }>();

/** Common form locales offered by the add-language picker (code + native name). */
const LANGUAGE_OPTIONS: Array<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "tr", name: "Türkçe" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "sv", name: "Svenska" },
  { code: "da", name: "Dansk" },
  { code: "nb", name: "Norsk" },
  { code: "fi", name: "Suomi" },
  { code: "cs", name: "Čeština" },
  { code: "ro", name: "Română" },
  { code: "hu", name: "Magyar" },
  { code: "el", name: "Ελληνικά" },
  { code: "ru", name: "Русский" },
  { code: "uk", name: "Українська" },
  { code: "ar", name: "العربية" },
  { code: "fa", name: "فارسی" },
  { code: "hi", name: "हिन्दी" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "th", name: "ไทย" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh", name: "中文" },
  { code: "az", name: "Azərbaycanca" },
];

/** shadcn combobox (Popover + Command) for adding a form locale. */
function AddLanguagePopover({
  languages,
  onAdd,
  compact,
}: {
  languages: string[];
  onAdd: (code: string) => void;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const available = LANGUAGE_OPTIONS.filter((l) => !languages.includes(l.code));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t`Add language`}
          className={
            compact
              ? "rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
              : "flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground hover:border-primary hover:text-primary"
          }
        >
          {compact ? "+" : <><I.Plus size={9} /> {t`add`}</>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="end">
        <Command>
          <CommandInput placeholder={t`Search languages…`} />
          <CommandList>
            <CommandEmpty><Trans>No language found.</Trans></CommandEmpty>
            {available.map((l) => (
              <CommandItem
                key={l.code}
                value={`${l.code} ${l.name}`}
                onSelect={() => {
                  onAdd(l.code);
                  setOpen(false);
                }}
              >
                <span className="font-mono text-[10.5px] uppercase text-muted-foreground">{l.code}</span>
                <span>{l.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ── token reveal ──────────────────────────────────────────────────── */

function TokenRevealDialog({
  reveal,
  onClose,
  pushToast,
}: {
  reveal: { url: string; embedUrl: string } | null;
  onClose: () => void;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const absolute = `${origin}${reveal?.url ?? ""}`;
  const iframe = `<iframe src="${origin}${reveal?.embedUrl ?? ""}" width="100%" height="620" frameborder="0"></iframe>`;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(t`Copied.`);
    } catch {
      pushToast(t`Copy failed — select and copy manually.`);
    }
  };
  return (
    <Dialog open={!!reveal} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle><Trans>Form link ready</Trans></DialogTitle>
          <DialogDescription>
            <Trans>This link is shown once — rotating the token later replaces it and
            kills the old one.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3.5 py-1">
          <div className="flex flex-col gap-1 text-[12.5px] font-medium">
            <Trans>Public link</Trans>
            <div className="flex items-center gap-1.5">
              <Input readOnly value={absolute} className="font-mono text-[12px]" />
              <IconButton icon={I.Copy} title={t`Copy link`} onClick={() => void copy(absolute)} />
            </div>
          </div>
          <div className="flex flex-col gap-1 text-[12.5px] font-medium">
            <Trans>Embed snippet</Trans>
            <div className="flex items-start gap-1.5">
              <Textarea readOnly rows={3} value={iframe} className="font-mono text-[11.5px]" />
              <IconButton icon={I.Copy} title={t`Copy embed snippet`} onClick={() => void copy(iframe)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}><Trans>Done</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── list view ─────────────────────────────────────────────────────── */

function FormCards({
  forms,
  onOpen,
  onNew,
  loaded,
}: {
  forms: ApiForm[];
  onOpen: (f: ApiForm) => void;
  onNew: () => void;
  loaded: boolean;
}) {
  const { t } = useLingui();
  if (!loaded) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="gap-3 p-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-full" />
          </Card>
        ))}
      </div>
    );
  }
  if (forms.length === 0) {
    return (
      <Card className="py-0">
        <EmptyState
          size="md"
          icon={I.Inbox}
          title={<Trans>No forms yet</Trans>}
          description={<Trans>Create a form to collect submissions from visitors — no account or code required on their side.</Trans>}
          action={
            <Button variant="primary" icon={I.Plus} onClick={onNew}>
              <Trans>New form</Trans>
            </Button>
          }
        />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
      {forms.map((f) => {
        const fieldCount = f.fields.filter((b) => (b.kind ?? "field") === "field").length;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onOpen(f)}
            className="flex flex-col gap-3 rounded-surface border border-border bg-card p-4 text-left transition-colors hover:border-primary/50"
          >
            <div className="flex w-full items-center gap-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                <I.Inbox size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{f.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  → {f.collection}
                </div>
              </div>
              {f.active ? (
                <Badge variant="secondary" className="text-emerald-400">
                  <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-400" />
                  <Trans>live</Trans>
                </Badge>
              ) : (
                <Badge variant="outline"><Trans>paused</Trans></Badge>
              )}
            </div>
            <div className="flex w-full items-center justify-between border-t border-border pt-2.5 text-[13px]">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground"><Trans>Fields</Trans></div>
                <div className="font-semibold tabular-nums">{fieldCount}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground"><Trans>Submissions</Trans></div>
                <div className="font-semibold tabular-nums">{f.submissionCount}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground"><Trans>Last</Trans></div>
                <div className="font-semibold tabular-nums" title={t`Last submission`}>
                  {relTime(f.lastSubmissionAt)}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ── canvas ────────────────────────────────────────────────────────── */

function CanvasFieldPreview({
  block,
  ef,
  locale,
  base,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField | null;
  locale: string;
  base: string;
}) {
  const { t } = useLingui();
  const loc = locale !== base ? block.i18n?.[locale] : undefined;
  const ph = loc?.placeholder || block.placeholder || "";
  if (!ef) return null;
  const LeadIcon = blockIcon(ef, block);
  if (ef.choices) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-control border border-border bg-background/60 px-3 text-[13px] text-muted-foreground">
        <LeadIcon size={13} />
        <span>{t`Select one…`}</span>
        <span className="ml-auto"><I.ChevronDown size={14} /></span>
      </div>
    );
  }
  if (ef.type === "boolean") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="size-4 rounded-sm border border-border bg-background/60" />
        <Trans>Yes</Trans>
      </div>
    );
  }
  if (ef.type === "integer" && block.rating) {
    return (
      <div className="flex items-center gap-1 text-muted-foreground">
        {[1, 2, 3, 4, 5].map((n) => (
          <I.Star key={n} size={17} />
        ))}
        <span className="ml-1 text-[11px]">1–5</span>
      </div>
    );
  }
  if (ef.type === "longtext") {
    return (
      <div className="flex h-[74px] items-start gap-2 rounded-control border border-border bg-background/60 px-3 py-2 text-[13px] text-muted-foreground/60">
        <span className="mt-0.5 text-muted-foreground"><LeadIcon size={13} /></span>
        {ph}
      </div>
    );
  }
  return (
    <div className="flex h-9 items-center gap-2 rounded-control border border-border bg-background/60 px-3 text-[13px] text-muted-foreground/60">
      <span className="text-muted-foreground"><LeadIcon size={13} /></span>
      {ph || (ef.type === "timestamp" ? "YYYY-MM-DD" : "")}
    </div>
  );
}

function InsertDot({ onClick }: { onClick: () => void }) {
  const { t } = useLingui();
  return (
    <div className="group/ins relative flex h-4 items-center justify-center">
      <div className="h-px w-full bg-transparent transition-colors group-hover/ins:bg-primary/30" />
      <button
        type="button"
        title={t`Add block`}
        onClick={onClick}
        className="absolute grid size-5 place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 transition-opacity hover:border-primary hover:text-primary group-hover/ins:opacity-100"
      >
        <I.Plus size={11} />
      </button>
    </div>
  );
}

/* ── builder ───────────────────────────────────────────────────────── */

type BuilderTab = "edit" | "share" | "submissions";
type Selection = { kind: "block"; id: string } | { kind: "ending" } | null;

export function FormsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [forms, setForms] = useState<ApiForm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collections, setCollections] = useState<{ slug: string }[]>([]);

  // Builder state — `form` is the working copy; edits autosave.
  const [form, setForm] = useState<ApiForm | null>(null);
  const [tab, setTab] = useState<BuilderTab>("edit");
  const [sel, setSel] = useState<Selection>(null);
  const [locale, setLocale] = useState("en");
  const [eligible, setEligible] = useState<ApiFormEligibleField[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [insertAt, setInsertAt] = useState<number | null>(null);
  // Drag-reorder state: the block being dragged and the index the pointer is
  // currently over (drop position, 0..fields.length). Refs mirror the state so
  // the synchronous dragover→drop event chain never reads a stale value.
  const [dragId, setDragIdState] = useState<string | null>(null);
  const [dropIdx, setDropIdxState] = useState<number | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dropIdxRef = useRef<number | null>(null);
  const setDragId = (v: string | null) => {
    dragIdRef.current = v;
    setDragIdState(v);
  };
  const setDropIdx = (v: number | null) => {
    dropIdxRef.current = v;
    setDropIdxState(v);
  };
  const [reveal, setReveal] = useState<{ url: string; embedUrl: string } | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "rotate" | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<ApiForm | null>(null);
  formRef.current = form;

  const reload = useCallback(async () => {
    try {
      const r = await formsApi.list();
      setForms((r.data ?? []).map((f) => ({ ...f, fields: withIds(f.fields) })));
    } catch (e) {
      pushToast((e as Error).message);
    }
  }, [pushToast]);

  useEffect(() => {
    void Promise.all([
      reload(),
      collectionsApi
        .list()
        .then((r) => setCollections(r.data.map((c) => ({ slug: c.slug }))))
        .catch(() => setCollections([])),
    ]).finally(() => setLoaded(true));
  }, [reload]);

  // Eligible fields for the open form's collection.
  useEffect(() => {
    if (!form?.collection) {
      setEligible([]);
      return;
    }
    let cancelled = false;
    formsApi
      .eligibleFields(form.collection)
      .then((r) => {
        if (!cancelled) setEligible(r.data);
      })
      .catch(() => {
        if (!cancelled) setEligible([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.collection]);

  const efByName = useMemo(
    () => new Map(eligible.map((f) => [f.name, f])),
    [eligible],
  );

  const settings: ApiFormSettings = form?.settings ?? {};
  const languages = settings.languages?.length ? settings.languages : ["en"];
  const base = languages[0] ?? "en";

  /* autosave — debounce every mutation of the working copy */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const f = formRef.current;
      if (!f) return;
      try {
        await formsApi.update(f.id, {
          name: f.name,
          fields: f.fields,
          settings: f.settings ?? undefined,
          active: f.active,
        });
        setSaveState("saved");
        setForms((prev) => prev.map((x) => (x.id === f.id ? f : x)));
      } catch (e) {
        setSaveState("error");
        pushToast((e as Error).message);
      }
    }, 700);
  }, [pushToast]);

  const patchForm = useCallback(
    (patch: Partial<ApiForm>) => {
      setForm((prev) => (prev ? { ...prev, ...patch } : prev));
      scheduleSave();
    },
    [scheduleSave],
  );

  const patchSettings = useCallback(
    (patch: Partial<ApiFormSettings>) => {
      setForm((prev) =>
        prev ? { ...prev, settings: { ...(prev.settings ?? {}), ...patch } } : prev,
      );
      scheduleSave();
    },
    [scheduleSave],
  );

  const patchBlock = useCallback(
    (id: string, patch: Partial<ApiFormBlock>) => {
      setForm((prev) =>
        prev
          ? {
              ...prev,
              fields: prev.fields.map((b) => (b.id === id ? { ...b, ...patch } : b)),
            }
          : prev,
      );
      scheduleSave();
    },
    [scheduleSave],
  );

  /** Patch a block's base string or its per-locale override, depending on the
   *  canvas locale. Empty locale values are dropped so fallback kicks in. */
  const patchBlockText = useCallback(
    (id: string, key: "label" | "placeholder" | "help", value: string) => {
      setForm((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          fields: prev.fields.map((b) => {
            if (b.id !== id) return b;
            if (locale === base) return { ...b, [key]: value };
            const langMap = { ...(b.i18n?.[locale] ?? {}) };
            if (value) langMap[key] = value;
            else delete langMap[key];
            return { ...b, i18n: { ...(b.i18n ?? {}), [locale]: langMap } };
          }),
        };
      });
      scheduleSave();
    },
    [locale, base, scheduleSave],
  );

  const patchFormText = useCallback(
    (key: "title" | "description" | "submitLabel" | "successMessage", value: string) => {
      setForm((prev) => {
        if (!prev) return prev;
        const s = { ...(prev.settings ?? {}) };
        if (locale === base) {
          if (key === "title") return { ...prev, name: value };
          s[key] = value;
          return { ...prev, settings: s };
        }
        const langMap = { ...(s.i18n?.[locale] ?? {}) };
        if (value) langMap[key] = value;
        else delete langMap[key];
        s.i18n = { ...(s.i18n ?? {}), [locale]: langMap };
        return { ...prev, settings: s };
      });
      scheduleSave();
    },
    [locale, base, scheduleSave],
  );

  const moveBlock = useCallback(
    (id: string, dir: -1 | 1) => {
      setForm((prev) => {
        if (!prev) return prev;
        const idx = prev.fields.findIndex((b) => b.id === id);
        const to = idx + dir;
        if (idx < 0 || to < 0 || to >= prev.fields.length) return prev;
        const next = [...prev.fields];
        const [b] = next.splice(idx, 1);
        next.splice(to, 0, b!);
        return { ...prev, fields: next };
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  /** Move a block to an absolute drop position (indices are pre-removal). */
  const moveBlockTo = useCallback(
    (id: string, to: number) => {
      setForm((prev) => {
        if (!prev) return prev;
        const idx = prev.fields.findIndex((b) => b.id === id);
        if (idx < 0) return prev;
        const next = [...prev.fields];
        const [b] = next.splice(idx, 1);
        next.splice(to > idx ? to - 1 : to, 0, b!);
        return { ...prev, fields: next };
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  const removeBlock = useCallback(
    (id: string) => {
      setForm((prev) =>
        prev ? { ...prev, fields: prev.fields.filter((b) => b.id !== id) } : prev,
      );
      setSel(null);
      scheduleSave();
    },
    [scheduleSave],
  );

  const insertBlock = useCallback(
    (block: ApiFormBlock, at: number | null) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = [...prev.fields];
        const idx = at === null ? next.length : at;
        next.splice(idx, 0, block);
        return { ...prev, fields: next };
      });
      setInsertAt(null);
      setSel({ kind: "block", id: block.id! });
      scheduleSave();
    },
    [scheduleSave],
  );

  const openForm = (f: ApiForm) => {
    setForm({ ...f, fields: withIds(f.fields) });
    setTab("edit");
    setSel(null);
    setLocale((f.settings?.languages?.[0] ?? "en"));
    setSaveState("saved");
  };

  const closeBuilder = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setForm(null);
    void reload();
  };

  const doRotate = async () => {
    if (!form) return;
    setConfirm(null);
    try {
      const r = await formsApi.rotateToken(form.id);
      tokenCache.set(form.id, { url: r.data.url, embedUrl: r.data.embedUrl });
      setReveal({ url: r.data.url, embedUrl: r.data.embedUrl });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const doDelete = async () => {
    if (!form) return;
    setConfirm(null);
    const id = form.id;
    setForm(null);
    setForms((prev) => prev.filter((f) => f.id !== id));
    try {
      await formsApi.remove(id);
    } catch (e) {
      pushToast((e as Error).message);
      void reload();
    }
  };

  /* ── render ── */

  if (!form) {
    return (
      <div className="flex flex-col gap-4.5">
        <PageHeader
          title={t`Forms`}
          description={t`Public, embeddable forms that write straight into a collection — share a link or drop the iframe anywhere.`}
          actions={
            <Button variant="primary" icon={I.Plus} onClick={() => setNewOpen(true)}>
              <Trans>New form</Trans>
            </Button>
          }
        />
        <FormCards forms={forms} loaded={loaded} onOpen={openForm} onNew={() => setNewOpen(true)} />
        <NewFormDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          collections={collections}
          pushToast={pushToast}
          onCreated={(created, urls) => {
            tokenCache.set(created.id, urls);
            setForms((prev) => [created, ...prev]);
            setNewOpen(false);
            setReveal(urls);
            openForm(created);
          }}
        />
        <TokenRevealDialog reveal={reveal} onClose={() => setReveal(null)} pushToast={pushToast} />
      </div>
    );
  }

  const fieldBlocks = form.fields.filter((b) => (b.kind ?? "field") === "field");
  const usedNames = new Set(fieldBlocks.map((b) => b.name));
  const selBlock =
    sel?.kind === "block" ? form.fields.find((b) => b.id === sel.id) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <IconButton icon={I.ChevronLeft} title={t`Back to forms`} onClick={closeBuilder} />
        <div className="min-w-0">
          <div className="truncate text-[14.5px] font-semibold">{form.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">→ {form.collection}</div>
        </div>
        {/* Design tokens: active tab = accent-tinted pill w/ inset ring and
            near-white label; inactive = muted text on the frosted strip. */}
        <div className="mx-auto flex items-center gap-0.5 rounded-[10px] border border-white/10 bg-white/5 p-[3px]">
          {(["edit", "share", "submissions"] as BuilderTab[]).map((tb) => (
            <button
              key={tb}
              type="button"
              onClick={() => setTab(tb)}
              className={`flex items-center gap-1.5 rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
                tab === tb
                  ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tb === "edit" ? <Trans>Edit</Trans> : tb === "share" ? <Trans>Share</Trans> : <Trans>Submissions</Trans>}
              {tb === "submissions" && (
                <span className={`font-mono text-[10px] tabular-nums ${tab === tb ? "text-primary" : ""}`}>
                  {form.submissionCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
          {saveState === "saving" ? (
            <Trans>saving…</Trans>
          ) : saveState === "error" ? (
            <span className="text-destructive"><Trans>save failed</Trans></span>
          ) : (
            <>
              <I.Check size={12} />
              <Trans>saved</Trans>
            </>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground">{form.active ? t`live` : t`paused`}</span>
          <Switch checked={form.active} onChange={(v) => patchForm({ active: v })} />
        </div>
        {tokenCache.has(form.id) ? (
          <Button
            variant="primary"
            icon={I.ExternalLink}
            onClick={() => window.open(tokenCache.get(form.id)!.url, "_blank")}
          >
            <Trans>Open form</Trans>
          </Button>
        ) : (
          <IconButton icon={I.Trash} title={t`Delete form`} onClick={() => setConfirm("delete")} />
        )}
      </div>

      {tab === "edit" && (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4 max-[980px]:grid-cols-1">
          {/* canvas */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                <Trans>canvas · what visitors see</Trans>
              </span>
              <div className="ml-auto flex items-center gap-1">
                {languages.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLocale(l)}
                    className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${
                      locale === l
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {l}
                  </button>
                ))}
                <AddLanguagePopover
                  compact
                  languages={languages}
                  onAdd={(code) => {
                    patchSettings({ languages: [...languages, code] });
                    setLocale(code);
                  }}
                />
              </div>
            </div>
            {locale !== base && (
              <div className="mb-2 rounded-control border border-primary/30 bg-primary/10 px-3 py-1.5 text-[11.5px] text-primary">
                <Trans>editing {locale.toUpperCase()} — empty strings fall back to {base.toUpperCase()}</Trans>
              </div>
            )}
            <Card className="gap-0 p-6 sm:p-8">
              <input
                value={
                  locale === base
                    ? form.name
                    : settings.i18n?.[locale]?.title ?? ""
                }
                placeholder={locale === base ? t`Form title` : form.name}
                onChange={(e) => patchFormText("title", e.target.value)}
                className="w-full bg-transparent text-[24px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
              />
              <input
                value={
                  locale === base
                    ? settings.description ?? ""
                    : settings.i18n?.[locale]?.description ?? ""
                }
                placeholder={
                  locale === base
                    ? t`Add a description…`
                    : settings.description ?? t`Add a description…`
                }
                onChange={(e) => patchFormText("description", e.target.value)}
                className="mt-1 w-full bg-transparent text-[13.5px] text-muted-foreground outline-none placeholder:text-muted-foreground/40"
              />

              <div className="mt-5 flex flex-col">
                <InsertDot onClick={() => setInsertAt(0)} />
                {form.fields.map((b, i) => {
                  const kind = b.kind ?? "field";
                  const ef = kind === "field" ? efByName.get(b.name ?? "") ?? null : null;
                  const missing = kind === "field" && !ef;
                  const selected = sel?.kind === "block" && sel.id === b.id;
                  const loc = locale !== base ? b.i18n?.[locale] : undefined;
                  const label =
                    loc?.label || b.label || (ef ? ef.label ?? humanize(ef.name) : b.name ?? "");
                  const stepNo =
                    kind === "step"
                      ? form.fields.slice(0, i + 1).filter((x) => x.kind === "step").length + 1
                      : 0;
                  if (missing) return null;
                  return (
                    <div key={b.id}>
                      {dropIdx === i && dragId && (
                        <div className="h-0.5 rounded-full bg-primary" />
                      )}
                      <div
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(e) => {
                          setDragId(b.id!);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", b.id!);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setDropIdx(null);
                        }}
                        onDragOver={(e) => {
                          if (!dragIdRef.current) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          const r = e.currentTarget.getBoundingClientRect();
                          setDropIdx(e.clientY < r.top + r.height / 2 ? i : i + 1);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragIdRef.current && dropIdxRef.current !== null)
                            moveBlockTo(dragIdRef.current, dropIdxRef.current);
                          setDragId(null);
                          setDropIdx(null);
                        }}
                        onClick={() => setSel({ kind: "block", id: b.id! })}
                        onKeyDown={(e) => e.key === "Enter" && setSel({ kind: "block", id: b.id! })}
                        className={`group/blk relative -mx-6 cursor-pointer rounded-[11px] px-6 py-2.5 transition-colors hover:bg-foreground/[0.04] sm:-mx-8 sm:px-8 ${
                          selected ? "ring-[1.5px] ring-primary shadow-[0_0_14px_-2px] shadow-primary/40" : ""
                        } ${dragId === b.id ? "opacity-40" : ""}`}
                      >
                        {b.cond && (
                          <span className="pointer-events-none absolute -top-2 right-3 flex items-center gap-1 rounded-full border border-primary/50 bg-card px-2 py-0.5 font-mono text-[9.5px] text-primary">
                            <I.Network size={9} />
                            {t`if`} {b.cond.field} {b.cond.op === "is" ? "=" : "≠"} {b.cond.value}
                          </span>
                        )}
                        {/* chevron · grip · chevron — the design's hover rail
                            inside the row gutter; the whole row drags, the
                            grip is the affordance. */}
                        <div className="absolute left-1 top-1/2 flex -translate-y-1/2 flex-col items-center opacity-0 transition-opacity group-hover/blk:opacity-100">
                          <button
                            type="button"
                            title={t`Move up`}
                            onClick={(e) => {
                              e.stopPropagation();
                              moveBlock(b.id!, -1);
                            }}
                            className="grid size-4.5 place-items-center rounded text-muted-foreground hover:text-foreground"
                          >
                            <I.ChevronUp size={11} />
                          </button>
                          <span
                            title={t`Drag to reorder`}
                            className="grid size-4.5 cursor-grab place-items-center text-muted-foreground active:cursor-grabbing"
                          >
                            <I.Grip size={11} />
                          </span>
                          <button
                            type="button"
                            title={t`Move down`}
                            onClick={(e) => {
                              e.stopPropagation();
                              moveBlock(b.id!, 1);
                            }}
                            className="grid size-4.5 place-items-center rounded text-muted-foreground hover:text-foreground"
                          >
                            <I.ChevronDown size={11} />
                          </button>
                        </div>
                        {kind === "step" ? (
                          <div className="flex items-center gap-3 py-1">
                            <span className="rounded-control bg-primary/90 px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground">
                              <Trans>Next →</Trans>
                            </span>
                            <span className="font-mono text-[10px] uppercase tracking-wide text-primary">
                              <Trans>step {stepNo}</Trans>
                            </span>
                            <span className="text-[14px] font-semibold">{label}</span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5 text-[13px] font-medium">
                              <span>{label}</span>
                              {ef?.required && <span className="text-primary">*</span>}
                              {locale !== base && (
                                <span className="ml-auto font-mono text-[9.5px] uppercase text-muted-foreground/70">
                                  {loc?.label ? locale : base}
                                </span>
                              )}
                            </div>
                            <CanvasFieldPreview block={b} ef={ef} locale={locale} base={base} />
                            {(loc?.help || b.help) && (
                              <span className="text-[11.5px] text-muted-foreground">
                                {loc?.help || b.help}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <InsertDot onClick={() => setInsertAt(i + 1)} />
                    </div>
                  );
                })}

                {dropIdx === form.fields.length && dragId && (
                  <div className="h-0.5 rounded-full bg-primary" />
                )}

                {/* ending — also a drop target for "move to the end" */}
                <div
                  role="button"
                  tabIndex={0}
                  onDragOver={(e) => {
                    if (!dragIdRef.current) return;
                    e.preventDefault();
                    setDropIdx(form.fields.length);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIdRef.current) moveBlockTo(dragIdRef.current, form.fields.length);
                    setDragId(null);
                    setDropIdx(null);
                  }}
                  onClick={() => setSel({ kind: "ending" })}
                  onKeyDown={(e) => e.key === "Enter" && setSel({ kind: "ending" })}
                  className={`mt-2 cursor-pointer rounded-surface border px-4 py-4 transition-colors ${
                    sel?.kind === "ending" ? "border-primary/60 bg-primary/5" : "border-transparent hover:border-border"
                  }`}
                >
                  <span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <Trans>ending</Trans>
                  </span>
                  <span className="inline-block rounded-control bg-primary/90 px-4 py-2 text-[13px] font-semibold text-primary-foreground">
                    {(locale !== base ? settings.i18n?.[locale]?.submitLabel : undefined) ||
                      settings.submitLabel ||
                      t`Submit`}
                  </span>
                  <p className="mt-2 text-[12.5px] text-muted-foreground">
                    {(locale !== base ? settings.i18n?.[locale]?.successMessage : undefined) ||
                      settings.successMessage ||
                      t`Your submission has been received.`}
                  </p>
                </div>
              </div>
            </Card>
            <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <I.Lock size={11} />
              <Trans>submissions run collection validation · versioned collections land as drafts</Trans>
            </p>
          </div>

          {/* right panel — sticky beside the canvas so settings stay in view
              while scrolling long forms; static when stacked (<980px). */}
          <div className="flex flex-col gap-3 self-start min-[980px]:sticky min-[980px]:top-4 min-[980px]:w-[300px]">
            {selBlock ? (
              <BlockPanel
                block={selBlock}
                ef={efByName.get(selBlock.name ?? "") ?? null}
                fieldBlocks={fieldBlocks}
                efByName={efByName}
                locale={locale}
                base={base}
                collection={form.collection}
                onText={patchBlockText}
                onPatch={patchBlock}
                onRemove={removeBlock}
                onClose={() => setSel(null)}
              />
            ) : sel?.kind === "ending" ? (
              <EndingPanel
                settings={settings}
                locale={locale}
                base={base}
                onText={patchFormText}
                onPatch={patchSettings}
                onClose={() => setSel(null)}
              />
            ) : (
              <DesignPanel
                settings={settings}
                languages={languages}
                collection={form.collection}
                eligibleCount={eligible.length}
                onPatch={patchSettings}
              />
            )}
          </div>
        </div>
      )}

      {tab === "share" && (
        <ShareTab
          form={form}
          urls={tokenCache.get(form.id) ?? null}
          onRotate={() => setConfirm("rotate")}
          onToggleActive={(v) => patchForm({ active: v })}
          onToggleTurnstile={(v) => patchSettings({ turnstile: v })}
          pushToast={pushToast}
        />
      )}

      {tab === "submissions" && <SubmissionsTab form={form} fieldBlocks={fieldBlocks} />}

      <InsertPalette
        open={insertAt !== null}
        onClose={() => setInsertAt(null)}
        eligible={eligible.filter((f) => !usedNames.has(f.name))}
        onPick={(item) => {
          if (item === "step") {
            insertBlock({ id: newBlockId(), kind: "step", label: t`New step` }, insertAt);
          } else {
            insertBlock({ id: newBlockId(), kind: "field", name: item.name }, insertAt);
          }
        }}
      />

      <TokenRevealDialog reveal={reveal} onClose={() => setReveal(null)} pushToast={pushToast} />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t`Delete this form?`}
        description={t`The public link stops working immediately. Submitted rows stay in the collection.`}
        actionLabel={t`Delete form`}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => void doDelete()}
      />
      <ConfirmDialog
        open={confirm === "rotate"}
        title={t`Rotate the form link?`}
        description={t`The current link stops working immediately and a new one is generated. Anywhere the old link is embedded must be updated.`}
        actionLabel={t`Rotate link`}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void doRotate()}
      />
    </div>
  );
}

/* ── new form dialog ───────────────────────────────────────────────── */

function NewFormDialog({
  open,
  onClose,
  collections,
  pushToast,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  collections: { slug: string }[];
  pushToast: (m: string) => void;
  onCreated: (form: ApiForm, urls: { url: string; embedUrl: string }) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [collection, setCollection] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!name.trim()) return pushToast(t`Name is required.`);
    if (!collection) return pushToast(t`Pick a collection.`);
    setCreating(true);
    try {
      // Start with the collection's required eligible fields (or the first
      // one) so the form is valid immediately; the builder does the rest.
      const ef = await formsApi.eligibleFields(collection);
      const seed = ef.data.filter((f) => f.required);
      const initial = (seed.length > 0 ? seed : ef.data.slice(0, 1)).map((f) => ({
        id: newBlockId(),
        kind: "field" as const,
        name: f.name,
      }));
      if (initial.length === 0) {
        pushToast(t`This collection has no form-eligible fields (only scalar, non-private fields can be exposed).`);
        return;
      }
      const r = await formsApi.create({ name: name.trim(), collection, fields: initial });
      onCreated(r.data.form, { url: r.data.url, embedUrl: r.data.embedUrl });
      setName("");
      setCollection("");
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle><Trans>New form</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Pick where submissions land — you'll design the form next.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3.5 py-1">
          <label className="flex flex-col gap-1 text-[12.5px] font-medium">
            <Trans>Name</Trans>
            <Input value={name} placeholder={t`Contact us`} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-medium">
            <Trans>Collection</Trans>
            <Select
              value={collection}
              onChange={setCollection}
              options={collections.map((c) => ({ value: c.slug, label: c.slug }))}
              placeholder={t`Pick a collection…`}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" disabled={creating} onClick={() => void create()}>
            {creating ? <Trans>Creating…</Trans> : <Trans>Create form</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── right panel: form design ──────────────────────────────────────── */

function PanelCard({
  icon: Icon,
  title,
  children,
  onClose,
}: {
  icon: (p: { size?: number }) => React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const { t } = useLingui();
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-primary"><Icon size={14} /></span>
        {title}
        {onClose && (
          <span className="ml-auto">
            <IconButton icon={I.X} title={t`Deselect`} onClick={onClose} />
          </span>
        )}
      </div>
      {children}
    </Card>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </span>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-control border border-border bg-background/50 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-[6px] px-2 py-1.5 text-[12px] font-medium transition-colors ${
            value === o.value ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function DesignPanel({
  settings,
  languages,
  collection,
  eligibleCount,
  onPatch,
}: {
  settings: ApiFormSettings;
  languages: string[];
  collection: string;
  eligibleCount: number;
  onPatch: (p: Partial<ApiFormSettings>) => void;
}) {
  const { t } = useLingui();
  const accent = settings.accent ?? ACCENTS[0]!;
  return (
    <>
      <PanelCard icon={I.Palette} title={<Trans>Form design</Trans>}>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>theme</Trans></PanelLabel>
          <Segmented
            value={settings.theme ?? "dark"}
            onChange={(v) => onPatch({ theme: v })}
            options={[
              { value: "dark", label: t`Dark` },
              { value: "light", label: t`Light` },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>accent</Trans></PanelLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => onPatch({ accent: c })}
                className={`size-6 rounded-full border-2 ${accent === c ? "border-foreground" : "border-transparent"}`}
                style={{ background: c }}
              />
            ))}
            {/* custom color — the design-system picker, shown as a swatch */}
            <ColorPicker
              value={ACCENTS.includes(accent) ? "" : accent}
              onChange={(hex) => onPatch({ accent: hex })}
              triggerSize={24}
            />
          </div>
          <span className="font-mono text-[10.5px] text-muted-foreground">{accent}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>font</Trans></PanelLabel>
          <Segmented
            value={settings.font ?? "sans"}
            onChange={(v) => onPatch({ font: v })}
            options={[
              { value: "sans", label: "Manrope" },
              { value: "lexend", label: "Lexend" },
              { value: "mono", label: <span className="font-mono">Mono</span> },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>languages</Trans></PanelLabel>
          <div className="flex flex-wrap items-center gap-1">
            {languages.map((l, i) => (
              <span
                key={l}
                className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
              >
                {l}
                {i > 0 && (
                  <button
                    type="button"
                    title={t`Remove language`}
                    onClick={() => onPatch({ languages: languages.filter((x) => x !== l) })}
                    className="text-muted-foreground/60 hover:text-destructive"
                  >
                    <I.X size={9} />
                  </button>
                )}
              </span>
            ))}
            <AddLanguagePopover
              languages={languages}
              onAdd={(code) => onPatch({ languages: [...languages, code] })}
            />
          </div>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            <Trans>Visitors get their browser language; <span className="font-mono">?lang={languages[1] ?? "tr"}</span> forces
            one. Missing strings fall back to the base language.</Trans>
          </span>
        </div>
      </PanelCard>
      <PanelCard icon={I.Database} title={<Trans>source collection</Trans>}>
        <div className="flex items-center gap-2 rounded-control border border-border bg-background/50 px-3 py-2">
          <I.Database size={13} />
          <span className="font-mono text-[12px]">{collection}</span>
          <span className="ml-auto text-[10.5px] text-muted-foreground">
            <Trans>{eligibleCount} eligible fields</Trans>
          </span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          <Trans>Select a block on the canvas to edit its settings. Only scalar,
          non-private fields can be exposed.</Trans>
        </p>
      </PanelCard>
    </>
  );
}

/* ── right panel: block settings ───────────────────────────────────── */

function BlockPanel({
  block,
  ef,
  fieldBlocks,
  efByName,
  locale,
  base,
  collection,
  onText,
  onPatch,
  onRemove,
  onClose,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField | null;
  fieldBlocks: ApiFormBlock[];
  efByName: Map<string, ApiFormEligibleField>;
  locale: string;
  base: string;
  collection: string;
  onText: (id: string, key: "label" | "placeholder" | "help", value: string) => void;
  onPatch: (id: string, patch: Partial<ApiFormBlock>) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const isStep = (block.kind ?? "field") === "step";
  const loc = locale !== base ? block.i18n?.[locale] : undefined;
  const val = (key: "label" | "placeholder" | "help") =>
    locale === base ? (block[key] ?? "") : (loc?.[key] ?? "");
  const basePh = (key: "label" | "placeholder" | "help") =>
    locale === base
      ? key === "label" && ef
        ? ef.label ?? humanize(ef.name)
        : ""
      : block[key] || (key === "label" && ef ? ef.label ?? humanize(ef.name) : "");

  // Condition sources: other dropdown field-blocks (design: choice fields).
  const condSources = fieldBlocks.filter(
    (b) => b.name !== block.name && efByName.get(b.name ?? "")?.choices,
  );
  const condChoices = block.cond
    ? efByName.get(block.cond.field)?.choices ?? []
    : [];

  return (
    <PanelCard
      icon={isStep ? I.Layers : I.Type}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12px]">
            {isStep ? t`Step break` : block.name}
          </span>
          {ef && <span className="text-[10px] font-normal text-muted-foreground">{ef.type}</span>}
        </span>
      }
      onClose={onClose}
    >
      {locale !== base && (
        <div className="rounded-control border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary">
          <Trans>editing {locale.toUpperCase()} — empty falls back to {base.toUpperCase()}</Trans>
        </div>
      )}
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Label</Trans>
        <Input
          value={val("label")}
          placeholder={basePh("label")}
          onChange={(e) => onText(block.id!, "label", e.target.value)}
        />
      </label>
      {!isStep && ef && !ef.choices && ef.type !== "boolean" && !(ef.type === "integer" && block.rating) && (
        <label className="flex flex-col gap-1 text-[12px] font-medium">
          <Trans>Placeholder</Trans>
          <Input
            value={val("placeholder")}
            placeholder={basePh("placeholder")}
            onChange={(e) => onText(block.id!, "placeholder", e.target.value)}
          />
        </label>
      )}
      {!isStep && (
        <label className="flex flex-col gap-1 text-[12px] font-medium">
          <Trans>Help text</Trans>
          <Input
            value={val("help")}
            placeholder={basePh("help")}
            onChange={(e) => onText(block.id!, "help", e.target.value)}
          />
        </label>
      )}

      {!isStep && ef && (
        <div className="flex items-center justify-between text-[12px] font-medium">
          <Trans>Required</Trans>
          {ef.required ? (
            <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
              <I.Lock size={10} />
              <Trans>required by the collection schema</Trans>
            </span>
          ) : (
            <span className="text-[11px] font-normal text-muted-foreground"><Trans>optional</Trans></span>
          )}
        </div>
      )}

      {!isStep && ef?.type === "integer" && (
        <div className="flex items-center justify-between text-[12px] font-medium">
          <span className="flex items-center gap-1.5"><I.Star size={12} /><Trans>Star rating (1–5)</Trans></span>
          <Switch checked={Boolean(block.rating)} onChange={(v) => onPatch(block.id!, { rating: v })} />
        </div>
      )}

      {!isStep && ef?.choices && (
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>choices · from schema enum</Trans></PanelLabel>
          <div className="flex flex-wrap gap-1">
            {ef.choices.map((c) => (
              <span key={c} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {c}
              </span>
            ))}
          </div>
          <span className="text-[10.5px] text-muted-foreground">
            <Trans>edit choices on the field in <span className="font-mono">{collection}</span></Trans>
          </span>
        </div>
      )}

      {!isStep && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <PanelLabel>
            <span className="flex items-center gap-1"><I.Network size={11} /><Trans>Logic</Trans></span>
          </PanelLabel>
          {block.cond ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11.5px] text-muted-foreground"><Trans>Show this block only when</Trans></span>
              <Select
                value={block.cond.field}
                onChange={(v) =>
                  onPatch(block.id!, { cond: { ...block.cond!, field: v, value: efByName.get(v)?.choices?.[0] ?? "" } })
                }
                options={condSources.map((b) => ({ value: b.name!, label: b.name! }))}
              />
              <Segmented
                value={block.cond.op}
                onChange={(v) => onPatch(block.id!, { cond: { ...block.cond!, op: v } })}
                options={[
                  { value: "is", label: t`is` },
                  { value: "is_not", label: t`is not` },
                ]}
              />
              <Select
                value={block.cond.value}
                onChange={(v) => onPatch(block.id!, { cond: { ...block.cond!, value: v } })}
                options={condChoices.map((c) => ({ value: c, label: c }))}
              />
              <button
                type="button"
                onClick={() => onPatch(block.id!, { cond: undefined })}
                className="self-start text-[11.5px] text-destructive hover:underline"
              >
                <Trans>Remove condition</Trans>
              </button>
            </div>
          ) : condSources.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                const src = condSources[0]!;
                onPatch(block.id!, {
                  cond: {
                    field: src.name!,
                    op: "is",
                    value: efByName.get(src.name!)?.choices?.[0] ?? "",
                  },
                });
              }}
              className="flex w-full items-center justify-center gap-2 rounded-control border border-dashed border-primary/40 px-3 py-2.5 text-[13px] font-medium text-primary transition-colors hover:border-primary hover:bg-primary/5"
            >
              <I.Plus size={13} />
              <Trans>Show conditionally</Trans>
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              <Trans>Add a dropdown field to the form to build show-conditions on it.</Trans>
            </span>
          )}
        </div>
      )}

      {isStep && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          <Trans>Step breaks split the form into pages — presentation only, nothing is
          written to the collection.</Trans>
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => onRemove(block.id!)}
          className="flex w-full items-center justify-center gap-2 rounded-control border border-orange-300/40 bg-orange-300/5 px-3 py-2.5 text-[13px] font-medium text-orange-300 transition-colors hover:border-orange-300/70 hover:bg-orange-300/10"
        >
          <I.Trash size={13} />
          <Trans>Remove from form</Trans>
        </button>
        {!isStep && (
          <span className="text-center text-[11px] text-muted-foreground">
            <Trans>the field stays in the collection</Trans>
          </span>
        )}
      </div>
    </PanelCard>
  );
}

/* ── right panel: ending ───────────────────────────────────────────── */

function EndingPanel({
  settings,
  locale,
  base,
  onText,
  onPatch,
  onClose,
}: {
  settings: ApiFormSettings;
  locale: string;
  base: string;
  onText: (key: "title" | "description" | "submitLabel" | "successMessage", value: string) => void;
  onPatch: (p: Partial<ApiFormSettings>) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const loc = locale !== base ? settings.i18n?.[locale] : undefined;
  return (
    <PanelCard icon={I.Zap} title={<Trans>Ending</Trans>} onClose={onClose}>
      {locale !== base && (
        <div className="rounded-control border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary">
          <Trans>editing {locale.toUpperCase()} — empty falls back to {base.toUpperCase()}</Trans>
        </div>
      )}
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Submit button label</Trans>
        <Input
          value={locale === base ? settings.submitLabel ?? "" : loc?.submitLabel ?? ""}
          placeholder={locale === base ? t`Submit` : settings.submitLabel ?? t`Submit`}
          onChange={(e) => onText("submitLabel", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Success message</Trans>
        <Textarea
          rows={2}
          value={locale === base ? settings.successMessage ?? "" : loc?.successMessage ?? ""}
          placeholder={locale === base ? t`Thanks — we got it!` : settings.successMessage ?? ""}
          onChange={(e) => onText("successMessage", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Redirect URL</Trans>
        <Input
          value={settings.redirectUrl ?? ""}
          placeholder="https://example.com/thanks"
          onChange={(e) => onPatch({ redirectUrl: e.target.value || undefined })}
        />
        <span className="text-[11px] font-normal text-muted-foreground">
          <Trans>If set, visitors are sent there instead of seeing the message.</Trans>
        </span>
      </label>
    </PanelCard>
  );
}

/* ── share tab ─────────────────────────────────────────────────────── */

function ShareTab({
  form,
  urls,
  onRotate,
  onToggleActive,
  onToggleTurnstile,
  pushToast,
}: {
  form: ApiForm;
  urls: { url: string; embedUrl: string } | null;
  onRotate: () => void;
  onToggleActive: (v: boolean) => void;
  onToggleTurnstile: (v: boolean) => void;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const absolute = urls ? `${origin}${urls.url}` : null;
  const iframe = urls
    ? `<iframe src="${origin}${urls.embedUrl}" width="100%" height="620" frameborder="0"></iframe>`
    : null;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(t`Copied.`);
    } catch {
      pushToast(t`Copy failed — select and copy manually.`);
    }
  };
  return (
    <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
      <div className="flex flex-col gap-4">
        <PanelCard icon={I.Link} title={<Trans>Public link</Trans>}>
          <p className="text-[11.5px] text-muted-foreground">
            <Trans>No auth on the visitor's side — the token in the URL is the credential.</Trans>
          </p>
          {absolute ? (
            <div className="flex items-center gap-1.5">
              <Input readOnly value={absolute} className="font-mono text-[12px]" />
              <IconButton icon={I.Copy} title={t`Copy link`} onClick={() => void copy(absolute)} />
              <IconButton icon={I.ExternalLink} title={t`Open form`} onClick={() => window.open(absolute, "_blank")} />
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 rounded-control border border-dashed border-border px-3 py-3">
              <p className="text-[12px] text-muted-foreground">
                <Trans>The link was shown once when it was minted. Generate a new one to
                see it here — the old link stops working.</Trans>
              </p>
              <Button variant="primary" icon={I.Refresh} onClick={onRotate} className="self-start">
                <Trans>Get a new link</Trans>
              </Button>
            </div>
          )}
        </PanelCard>
        <PanelCard icon={I.Code} title={<Trans>Embed</Trans>}>
          <p className="text-[11.5px] text-muted-foreground">
            <Trans>Drop the iframe into any site — the form keeps its own theme.</Trans>
          </p>
          {iframe ? (
            <div className="flex items-start gap-1.5">
              <Textarea readOnly rows={4} value={iframe} className="font-mono text-[11.5px]" />
              <IconButton icon={I.Copy} title={t`Copy embed snippet`} onClick={() => void copy(iframe)} />
            </div>
          ) : (
            <p className="rounded-control border border-dashed border-border px-3 py-2.5 text-[12px] text-muted-foreground">
              <Trans>Use "Get a new link" above — the embed snippet is minted together
              with it.</Trans>
            </p>
          )}
        </PanelCard>
        <Card className="gap-2.5 border-destructive/40 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
            <I.Refresh size={13} />
            <Trans>Rotate link</Trans>
          </div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            <Trans>Generates a new token and kills the current link immediately. Every
            embed of the old link must be updated — the new link is shown exactly once.</Trans>
          </p>
          <Button variant="ghost" icon={I.Refresh} onClick={onRotate} className="self-start text-destructive">
            <Trans>Rotate token</Trans>
          </Button>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <PanelCard icon={I.Shield} title={<Trans>Delivery</Trans>}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12.5px] font-medium"><Trans>Accepting submissions</Trans></div>
              <div className="text-[11px] text-muted-foreground"><Trans>pausing returns 410 on the public link</Trans></div>
            </div>
            <Switch checked={form.active} onChange={onToggleActive} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12.5px] font-medium"><Trans>Turnstile</Trans></div>
              <div className="text-[11px] text-muted-foreground"><Trans>needs TURNSTILE_SITE_KEY on the server</Trans></div>
            </div>
            <Switch
              checked={Boolean(form.settings?.turnstile)}
              onChange={onToggleTurnstile}
            />
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border pt-2.5 font-mono text-[11.5px]">
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Honeypot</Trans></span><span className="text-emerald-400"><Trans>always on</Trans></span></div>
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Rate limit</Trans></span><span>10 / min / IP</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Writes to</Trans></span><span>{form.collection}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Blocked so far</Trans></span><span className="tabular-nums">{form.blockedCount}</span></div>
          </div>
        </PanelCard>
        <PanelCard icon={I.Zap} title={<Trans>On submit</Trans>}>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            <Trans>Submissions go through the standard items write path — validation,
            flows, webhooks, realtime, audit. Anything listening on this collection
            fires as if an authenticated user created the row.</Trans>
          </p>
        </PanelCard>
      </div>
    </div>
  );
}

/* ── submissions tab ───────────────────────────────────────────────── */

function SubmissionsTab({ form, fieldBlocks }: { form: ApiForm; fieldBlocks: ApiFormBlock[] }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [filter, setFilter] = useState<"all" | "draft" | "published">("all");
  const [total, setTotal] = useState<number | null>(null);
  const [versioned, setVersioned] = useState(false);

  const cols = fieldBlocks.slice(0, 4).map((b) => b.name!).filter(Boolean);

  // The draft/published filter follows the collection's `versioned` flag (not
  // row sniffing — an empty versioned collection must still show it).
  useEffect(() => {
    let cancelled = false;
    collectionsApi
      .get(form.collection)
      .then((r) => {
        if (!cancelled) setVersioned(Boolean(r.data.versioned));
      })
      .catch(() => {
        if (!cancelled) setVersioned(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.collection]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const query: Record<string, string | number> = { limit: 50, sort: "-created_at", meta: "filter_count" };
    if (filter !== "all") query.status = filter;
    itemsApi
      .list(form.collection, query)
      .then((r) => {
        if (cancelled) return;
        setRows(r.data);
        setTotal(r.meta?.filter_count ?? r.meta?.total_count ?? r.data.length);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.collection, filter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3 max-[860px]:grid-cols-2">
        {[
          { label: t`Total`, value: String(form.submissionCount), sub: t`accepted, all time` },
          { label: t`Blocked`, value: String(form.blockedCount), sub: t`turnstile + honeypot + rate limit` },
          { label: t`Last submission`, value: relTime(form.lastSubmissionAt), sub: t`ago` },
          {
            label: t`Rows in collection`,
            value: total === null ? "…" : String(total),
            sub: form.collection,
          },
        ].map((s, i) => (
          <Card key={i} className="gap-1 p-4">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">{s.label}</span>
            <span className="text-[22px] font-semibold tabular-nums">{s.value}</span>
            <span className="truncate text-[11px] text-muted-foreground">{s.sub}</span>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {versioned && (
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t`All` },
              { value: "draft", label: t`Drafts` },
              { value: "published", label: t`Published` },
            ]}
          />
        )}
        <div className="ml-auto">
          <Button
            variant="ghost"
            icon={I.Download}
            onClick={() => window.open(`/api/items/${form.collection}/export?format=csv`, "_blank")}
          >
            <Trans>Export CSV</Trans>
          </Button>
        </div>
      </div>

      <Card className="gap-0 py-0">
        {rows === null ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            size="md"
            icon={I.Inbox}
            title={<Trans>No submissions yet</Trans>}
            description={<Trans>Share the public link — rows land here (and in the collection) as they arrive.</Trans>}
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[calc(100vh-24rem)]" className="w-full">
            <div className="min-w-[720px]">
              <div
                className="grid items-center gap-3 border-b border-border px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                style={{ gridTemplateColumns: `110px repeat(${cols.length}, 1fr) ${versioned ? "90px" : ""}` }}
              >
                <span><Trans>When</Trans></span>
                {cols.map((c) => (
                  <span key={c} className="truncate">{c}</span>
                ))}
                {versioned && <span><Trans>Status</Trans></span>}
              </div>
              {rows.map((r, i) => (
                <div
                  key={String(r.id ?? i)}
                  className="grid items-center gap-3 border-b border-border px-3.5 py-[10px] text-[12.5px] last:border-b-0"
                  style={{ gridTemplateColumns: `110px repeat(${cols.length}, 1fr) ${versioned ? "90px" : ""}` }}
                >
                  {/* serialized rows expose camelCase system keys (createdAt) */}
                  <span className="font-mono text-[11px] text-muted-foreground">{relTime(r.createdAt ?? r.created_at)}</span>
                  {cols.map((c) => (
                    <span key={c} className="truncate">{r[c] === null || r[c] === undefined ? "—" : String(r[c])}</span>
                  ))}
                  {versioned && (
                    <span
                      className={`justify-self-start rounded-full border px-2 py-0.5 font-mono text-[10.5px] ${
                        r._status === "published"
                          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
                          : "border-amber-400/30 bg-amber-400/10 text-amber-400"
                      }`}
                    >
                      {String(r._status ?? "draft")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
            <span><Trans>Showing {rows.length} of {total ?? rows.length} rows</Trans></span>
            <span>
              <Trans>rows live in <span className="font-mono">{form.collection}</span></Trans>
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── insert palette ────────────────────────────────────────────────── */

function InsertPalette({
  open,
  onClose,
  eligible,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  eligible: ApiFormEligibleField[];
  onPick: (item: ApiFormEligibleField | "step") => void;
}) {
  const { t } = useLingui();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const ql = q.toLowerCase();
  const fields = eligible.filter(
    (f) => !ql || f.name.toLowerCase().includes(ql) || (f.label ?? "").toLowerCase().includes(ql),
  );
  const showStep = !ql || "step".includes(ql) || t`Step break`.toLowerCase().includes(ql);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md flex flex-col overflow-hidden max-h-[70vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle><Trans>Add block</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Collection fields not yet on the form, plus layout blocks.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={q}
          placeholder={t`Search blocks…`}
          onChange={(e) => setQ(e.target.value)}
        />
        <ScrollArea viewportClassName="max-h-[calc(70vh-14rem)] [&>div]:!block">
          <div className="flex flex-col py-1">
            {fields.map((f) => {
              const Icon = blockIcon(f, { name: f.name });
              return (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => onPick(f)}
                  className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left hover:bg-accent/50"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                    <Icon size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{f.label ?? humanize(f.name)}</span>
                    <span className="block font-mono text-[10.5px] text-muted-foreground">{f.name}</span>
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">{f.type}</span>
                  {f.required && <Badge variant="outline"><Trans>required</Trans></Badge>}
                </button>
              );
            })}
            {showStep && (
              <>
                <div className="mt-1 border-t border-border px-2.5 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
                  <Trans>layout</Trans>
                </div>
                <button
                  type="button"
                  onClick={() => onPick("step")}
                  className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left hover:bg-accent/50"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                    <I.Layers size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium"><Trans>Step break</Trans></span>
                    <span className="block text-[10.5px] text-muted-foreground"><Trans>Splits the form into pages</Trans></span>
                  </span>
                </button>
              </>
            )}
            {fields.length === 0 && !showStep && (
              <p className="px-2.5 py-4 text-center text-[12px] text-muted-foreground">
                <Trans>No blocks match "{q}"</Trans>
              </p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
