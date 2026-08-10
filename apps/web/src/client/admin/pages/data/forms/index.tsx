// Public forms — Tally-style builder implementing the "Backlex Forms" design:
// a card list view, then a full builder with an Edit tab (canvas of blocks +
// insert palette + right settings panel), a Share tab (link / embed / rotate /
// delivery) and a Submissions tab (counters + rows straight from the target
// collection). Changes autosave (debounced PATCH) with a saved indicator; the
// one-time token is cached per-session so Share can show the link right after
// create/rotate and stays honest ("hidden — rotate") otherwise.
import type { PushToast } from "../../../types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { accentInk, fontStack, safeAccent, useFonts } from "@/lib/public-theme";
import { I } from "../../../icons";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Switch,
} from "../../../ui";
import { useUrlTab } from "../../../use-url-tab";
import { Select } from "../../../select";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ConfirmDialog } from "../../../sheet";
import {
  collectionsApi,
  formsApi,
  type ApiForm,
  type ApiFormBlock,
  type ApiFormEligibleField,
  type ApiFormSettings,
} from "../../../api";
import { BlockPanel } from "./block-panel";
import { CANVAS_DARK, CANVAS_LIGHT, CanvasFieldPreview, CanvasMatrixPreview, CanvasPalette, InsertDot } from "./canvas";
import { DesignPanel, EndingPanel } from "./panels";
import { ResultsTab } from "./results-tab";
import { AddLanguagePopover, ShareTab } from "./share-tab";
import { LivePill, blockIcon, choiceSignature, humanize, relTime } from "./shared";
import { SubmissionsTab } from "./submissions-tab";

/* ── helpers ───────────────────────────────────────────────────────── */

let blockSeq = 0;
const newBlockId = () => `b_${Date.now().toString(36)}_${++blockSeq}`;

/** Ensure every block carries a stable client id for selection/reorder. */
const withIds = (blocks: ApiFormBlock[]): ApiFormBlock[] =>
  blocks.map((b) => (b.id ? b : { ...b, id: newBlockId() }));

/**
 * A matrix that is already valid the moment it is added.
 *
 * The builder saves as you type, so a block that has to be finished before it
 * can be saved is a block that fails to save. Two rows that already agree on
 * their columns — two number fields on a 1–5 scale, or two dropdowns offering
 * the same choices — is the smallest thing worth calling a grid.
 */
const seedMatrix = (eligible: ApiFormEligibleField[]): Partial<ApiFormBlock> | null => {
  const numbers = eligible.filter((f) => f.type === "integer" && !f.choices);
  if (numbers.length >= 2) {
    return {
      kind: "matrix",
      scale: { min: 1, max: 5, style: "number" },
      rows: numbers.slice(0, 2).map((f) => ({ name: f.name })),
    };
  }
  const groups = new Map<string, ApiFormEligibleField[]>();
  for (const f of eligible) {
    const sig = choiceSignature(f);
    if (!sig) continue;
    groups.set(sig, [...(groups.get(sig) ?? []), f]);
  }
  const shared = [...groups.values()].find((g) => g.length >= 2);
  if (!shared) return null;
  return { kind: "matrix", rows: shared.slice(0, 2).map((f) => ({ name: f.name })) };
};

/** Session-only cache of the last-minted public URLs per form id — the token
 *  is stored hashed server-side, so a reload legitimately loses these. */
const tokenCache = new Map<string, { url: string; embedUrl: string }>();

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
      // EmptyState renders its own Card — no wrapper, or it double-borders.
      <EmptyState
        size="md"
        icon={I.Form}
        title={<Trans>No forms yet</Trans>}
        description={<Trans>Create a form to collect submissions from visitors — no account or code required on their side.</Trans>}
        action={
          <Button variant="primary" icon={I.Plus} onClick={onNew}>
            <Trans>New form</Trans>
          </Button>
        }
      />
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
              <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] bg-primary/10 text-primary">
                <I.Form size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{f.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  → {f.collection}
                </div>
              </div>
              <LivePill active={f.active} />
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

const BUILDER_TABS = ["edit", "share", "results", "submissions"] as const;
type BuilderTab = (typeof BUILDER_TABS)[number];

type Selection = { kind: "block"; id: string } | { kind: "ending" } | null;

export function FormsPage({
  pushToast,
  setActiveNav,
  activeForm,
  openFormAt,
}: {
  pushToast: PushToast;
  setActiveNav?: (nav: string) => void;
  activeForm?: string | null;
  openFormAt?: (id: string | null, tab?: string) => void;
}) {
  const { t } = useLingui();
  const [forms, setForms] = useState<ApiForm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collections, setCollections] = useState<{ slug: string }[]>([]);

  // Builder state — `form` is the working copy; edits autosave.
  const [form, setForm] = useState<ApiForm | null>(null);
  /**
   * Which form is open and which of its tabs — both from the path
   * (`/forms/:id/:tab`), not from state.
   *
   * Submissions is a tab people sit on, watching for answers to land, and
   * asking for them used to mean reloading the admin — which closed the form
   * and came back on Edit.
   */
  const openId = activeForm ?? null;
  const [tab, setTab] = useUrlTab(BUILDER_TABS, "edit", 2);
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
  const [confirm, setConfirm] = useState<"delete" | "rotate" | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  // Bumped when the session-cached share link is hidden/cleared so dependent
  // UI re-renders (tokenCache is a module-level Map, not state).
  const [, bumpTokenCache] = useState(0);

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

  /**
   * Re-read the open form's tallies — how many answers arrived, how many were
   * turned away, when the last one landed.
   *
   * They are the server's count rather than part of the draft, so replacing
   * them under an edit in progress loses nothing the operator typed; only the
   * three counters are copied across for that reason, and the autosave is left
   * alone because it fires on `scheduleSave` and not on `form` changing.
   * Without this the numbers above the submissions list stayed at whatever they
   * were when the form was opened.
   */
  const refreshCounts = useCallback(async () => {
    const open = formRef.current;
    if (!open) return;
    const r = await formsApi.list();
    const fresh = (r.data ?? []).find((f) => f.id === open.id);
    if (!fresh) return;
    setForms((prev) =>
      prev.map((f) => (f.id === fresh.id ? { ...fresh, fields: withIds(fresh.fields) } : f)),
    );
    setForm((cur) =>
      cur && cur.id === fresh.id
        ? {
            ...cur,
            submissionCount: fresh.submissionCount,
            blockedCount: fresh.blockedCount,
            lastSubmissionAt: fresh.lastSubmissionAt,
          }
        : cur,
    );
  }, []);

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
  const cp: CanvasPalette = settings.theme === "light" ? CANVAS_LIGHT : CANVAS_DARK;
  const accent = safeAccent(settings.accent);
  const family = fontStack(settings.font);

  // The canvas renders in the form's own fonts — the same stylesheet the
  // public page loads, so the preview and the real thing agree.
  useFonts();

  // Collection meta for the open form (versioned drives the submissions
  // filter + the source-collection caption).
  const [collVersioned, setCollVersioned] = useState(false);
  useEffect(() => {
    if (!form?.collection) return;
    let cancelled = false;
    collectionsApi
      .get(form.collection)
      .then((r) => {
        if (!cancelled) setCollVersioned(Boolean(r.data.versioned));
      })
      .catch(() => {
        if (!cancelled) setCollVersioned(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.collection]);

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
    openFormAt?.(f.id, "edit");
  };

  /**
   * Fill the working copy whenever the path names a form it does not already
   * hold.
   *
   * Keyed on the id, so switching tabs — which changes the path but not which
   * form is open — leaves the draft alone, and so do the `setForms` calls the
   * autosave and the submission-count refresh make.
   */
  useEffect(() => {
    if (!openId) {
      setForm(null);
      return;
    }
    if (formRef.current?.id === openId) return;
    const f = forms.find((x) => x.id === openId);
    if (!f) return;
    setForm({ ...f, fields: withIds(f.fields) });
    setSel(null);
    setLocale(f.settings?.languages?.[0] ?? "en");
    setSaveState("saved");
  }, [openId, forms]);

  /** An id that outlived the form it named points at nothing; the list is the
   *  honest answer, and the path should say so too. */
  useEffect(() => {
    if (loaded && openId && !forms.some((f) => f.id === openId)) openFormAt?.(null);
  }, [loaded, openId, forms, openFormAt]);

  const closeBuilder = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    openFormAt?.(null);
    void reload();
  };

  const doRotate = async () => {
    if (!form) return;
    setConfirm(null);
    try {
      const r = await formsApi.rotateToken(form.id);
      tokenCache.set(form.id, { url: r.data.url, embedUrl: r.data.embedUrl });
      // No modal: the Share tab's amber reveal state shows the new link inline.
      setTab("share");
      bumpTokenCache((x) => x + 1);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const doDelete = async () => {
    if (!form) return;
    setConfirm(null);
    const id = form.id;
    // Leave the builder first: the row is about to stop existing, and the
    // not-found effect would otherwise send the page to the list a beat later
    // for a reason that reads like a failure.
    openFormAt?.(null);
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
        {/* A deep link names a form whose row has landed but whose working copy
            is filled one render later. Cards under it would flash the list on
            the way to the builder, so the skeleton stays up until it opens. */}
        <FormCards
          forms={forms}
          loaded={loaded && !(openId && forms.some((f) => f.id === openId))}
          onOpen={openForm}
          onNew={() => setNewOpen(true)}
        />
        <NewFormDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          collections={collections}
          pushToast={pushToast}
          onCreated={(created, urls) => {
            tokenCache.set(created.id, urls);
            setForms((prev) => [created, ...prev]);
            setNewOpen(false);
            openForm(created);
          }}
        />
      </div>
    );
  }

  const fieldBlocks = form.fields.filter((b) => (b.kind ?? "field") === "field");
  // Matrix rows hold their fields as surely as a field block does — a name the
  // picker still offers is a duplicate the server refuses on the next save.
  const usedNames = new Set([
    ...fieldBlocks.map((b) => b.name),
    ...form.fields.flatMap((b) =>
      b.kind === "matrix" ? (b.rows ?? []).map((r) => r.name) : [],
    ),
  ]);
  const selBlock =
    sel?.kind === "block" ? form.fields.find((b) => b.id === sel.id) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          title={t`Back to forms`}
          onClick={closeBuilder}
          className="grid size-[30px] shrink-0 place-items-center rounded-[8px] border border-white/10 bg-white/[0.03] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <I.ChevronLeft size={14} />
        </button>
        <div className="min-w-0 flex-1 sm:flex-none">
          <div className="truncate text-[14.5px] font-semibold">{form.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">→ {form.collection}</div>
        </div>
        {/* Mobile: the save indicator rides the title row (right edge); the
            fixed-width desktop copy below keeps the centered tabs stable. */}
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground sm:hidden">
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
        {/* Design tokens: active tab = accent-tinted pill w/ inset ring and
            near-white label; inactive = muted text on the frosted strip.
            Mobile: the wrapper takes its own row and centers the pill, so the
            strip never squeezes the title and never stretches full width. */}
        <div className="flex w-full justify-center sm:mx-auto sm:w-auto">
        <div className="flex items-center gap-0.5 rounded-[10px] border border-white/10 bg-white/5 p-[3px]">
          {(["edit", "share", "results", "submissions"] as BuilderTab[]).map((tb) => (
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
              {tb === "edit" ? (
                <Trans>Edit</Trans>
              ) : tb === "share" ? (
                <Trans>Share</Trans>
              ) : tb === "results" ? (
                <Trans>Results</Trans>
              ) : (
                <Trans>Submissions</Trans>
              )}
              {tb === "submissions" && (
                <span className={`font-mono text-[10px] tabular-nums ${tab === tb ? "text-primary" : ""}`}>
                  {form.submissionCount}
                </span>
              )}
            </button>
          ))}
        </div>
        </div>
        {/* fixed width so saved↔saving… can't shift the centered tab strip */}
        <span className="hidden w-[76px] shrink-0 items-center justify-end gap-1 text-[11.5px] text-muted-foreground sm:flex">
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
        {/* Actions hug the right edge on mobile (own row via ml-auto). */}
        <div className="ml-auto flex items-center gap-2.5 sm:ml-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">{form.active ? t`live` : t`paused`}</span>
            <Switch checked={form.active} onChange={(v) => patchForm({ active: v })} />
          </div>
          <button
            type="button"
            title={t`Delete form`}
            onClick={() => setConfirm("delete")}
            className="grid size-[30px] shrink-0 place-items-center rounded-[8px] border border-white/10 bg-white/[0.03] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <I.Trash size={14} />
          </button>
          <Button
            variant="primary"
            icon={I.ExternalLink}
            onClick={() => {
              const cached = tokenCache.get(form.id);
              if (cached) window.open(cached.url, "_blank");
              else {
                setTab("share");
                pushToast(t`Generate a link first — the token is only shown once.`);
              }
            }}
          >
            <Trans>Open form</Trans>
          </Button>
        </div>
      </div>

      {tab === "edit" && (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4 max-[980px]:grid-cols-1">
          {/* canvas */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                <Trans>canvas · what visitors see</Trans>
              </span>
              <div className="ml-auto flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5">
                {languages.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLocale(l)}
                    className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase ${
                      locale === l
                        ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                        : "text-muted-foreground hover:text-foreground"
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
              <span className="font-mono text-[10px] text-muted-foreground/70">
                theme: {settings.theme ?? "dark"} · {accent.toLowerCase()}
              </span>
            </div>
            {locale !== base && (
              <div className="mb-2 rounded-control border border-primary/30 bg-primary/10 px-3 py-1.5 text-[11.5px] text-primary">
                <Trans>editing {locale.toUpperCase()} — empty strings fall back to {base.toUpperCase()}</Trans>
              </div>
            )}
            <div
              className="rounded-[20px] border p-7 shadow-[0_24px_70px_rgba(0,0,0,0.35)] transition-colors sm:p-[52px] sm:pb-10"
              style={{ background: cp.bg, borderColor: cp.border, color: cp.text, fontFamily: family }}
            >
              <input
                value={
                  locale === base
                    ? form.name
                    : settings.i18n?.[locale]?.title ?? ""
                }
                placeholder={locale === base ? t`Form title` : form.name}
                onChange={(e) => patchFormText("title", e.target.value)}
                className="w-full bg-transparent text-[28px] font-medium tracking-tight outline-none placeholder:opacity-40"
                style={{ color: cp.text, fontFamily: `'Lexend',${family}` }}
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
                className="mt-1 w-full bg-transparent text-[13.5px] outline-none placeholder:opacity-40"
                style={{ color: cp.muted }}
              />

              <div className="mt-5 flex flex-col">
                <InsertDot bg={cp.bg} onClick={() => setInsertAt(0)} />
                {form.fields.map((b, i) => {
                  const kind = b.kind ?? "field";
                  const ef = kind === "field" ? efByName.get(b.name ?? "") ?? null : null;
                  // A block whose field is gone from the schema isn't drawn —
                  // and a matrix is gone once none of its rows survive.
                  const missing =
                    kind === "field"
                      ? !ef
                      : kind === "matrix" &&
                        !(b.rows ?? []).some((r) => efByName.has(r.name));
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
                        className={`group/blk relative -mx-6 my-0.5 cursor-pointer rounded-[11px] px-6 py-3.5 transition-colors sm:-mx-8 sm:px-8 ${
                          settings.theme === "light" ? "hover:bg-black/[0.04]" : "hover:bg-white/[0.04]"
                        } ${dragId === b.id ? "opacity-40" : ""}`}
                        style={
                          selected
                            ? { boxShadow: "0 0 0 1.5px var(--primary), 0 0 14px color-mix(in oklab, var(--primary) 25%, transparent)" }
                            : undefined
                        }
                      >
                        {b.cond && (
                          <span
                            className="pointer-events-none absolute -top-2 right-3 flex items-center gap-1 rounded-full border border-primary/50 px-2 py-0.5 font-mono text-[9.5px] text-primary"
                            style={{ background: cp.bg }}
                          >
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
                            <span
                              className="rounded-[10px] px-4 py-2 text-[12.5px] font-bold opacity-90"
                              style={{ background: accent, color: accentInk(accent) }}
                            >
                              <Trans>Next →</Trans>
                            </span>
                            <span className="font-mono text-[10px] uppercase tracking-wide text-primary">
                              <Trans>step {stepNo}</Trans>
                            </span>
                            <span className="text-[14px] font-semibold">{label}</span>
                          </div>
                        ) : kind === "matrix" ? (
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                              <span>{label}</span>
                              {locale !== base && (
                                <span className="ml-1 font-mono text-[9.5px] uppercase opacity-50">
                                  {loc?.label ? locale : base}
                                </span>
                              )}
                            </div>
                            <CanvasMatrixPreview
                              block={b}
                              efByName={efByName}
                              locale={locale}
                              base={base}
                              accent={accent}
                              p={cp}
                            />
                            {(loc?.help || b.help) && (
                              <span className="text-[12px]" style={{ color: cp.muted }}>
                                {loc?.help || b.help}
                              </span>
                            )}
                          </div>
                        ) : ef?.type === "boolean" && !b.consent ? (
                          <div className="flex items-center gap-2.5 py-0.5 text-[13.5px]">
                            <span
                              className="size-[19px] shrink-0 rounded-[6px] border-[1.5px]"
                              style={{ borderColor: cp.border, background: cp.inputBg }}
                            />
                            <span className="min-w-0 flex-1">{label}</span>
                            {ef.required && (
                              <span className="font-bold" style={{ color: accent }}>*</span>
                            )}
                          </div>
                        ) : b.consent && ef?.type === "boolean" ? (
                          <div
                            className="flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3"
                            style={{ borderColor: `${accent}52`, background: `${accent}0f` }}
                          >
                            <span
                              className="mt-0.5 size-[19px] shrink-0 rounded-[6px] border-[1.5px]"
                              style={{ borderColor: accent, background: cp.inputBg }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-1.5 text-[13.5px]">
                                <span className="min-w-0 flex-1">{label}</span>
                                <span className="font-bold" style={{ color: accent }}>*</span>
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: cp.muted }}>
                                <I.Shield size={10} />
                                <Trans>must be accepted to submit</Trans>
                                {b.policyUrl && (
                                  <>
                                    <span>·</span>
                                    <span className="underline underline-offset-2" style={{ color: accent }}>
                                      <Trans>read the full text</Trans>
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                              <span>{label}</span>
                              {locale !== base && (
                                <span className="ml-1 font-mono text-[9.5px] uppercase opacity-50">
                                  {loc?.label ? locale : base}
                                </span>
                              )}
                              {ef?.required && (
                                <span className="ml-auto" style={{ color: accent }}>*</span>
                              )}
                            </div>
                            <CanvasFieldPreview block={b} ef={ef} locale={locale} base={base} p={cp} />
                            {(loc?.help || b.help) && (
                              <span className="text-[12px]" style={{ color: cp.muted }}>
                                {loc?.help || b.help}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <InsertDot bg={cp.bg} onClick={() => setInsertAt(i + 1)} />
                    </div>
                  );
                })}

                {dropIdx === form.fields.length && dragId && (
                  <div className="h-0.5 rounded-full bg-primary" />
                )}

                <button
                  type="button"
                  onClick={() => setInsertAt(form.fields.length)}
                  className="mt-1 flex w-full items-center justify-center gap-2 rounded-[11px] border border-dashed py-2.5 font-mono text-[11.5px] transition-colors"
                  style={{ borderColor: cp.border, color: cp.muted }}
                >
                  <I.Plus size={12} />
                  <Trans>add block</Trans>
                </button>

                <div className="mb-3 mt-6 flex items-center gap-2.5">
                  <span className="h-px flex-1" style={{ background: cp.border }} />
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.14em]" style={{ color: cp.muted }}>
                    <Trans>ending</Trans>
                  </span>
                  <span className="h-px flex-1" style={{ background: cp.border }} />
                </div>

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
                  className="-mx-2 cursor-pointer rounded-[11px] px-2 py-1 transition-shadow"
                  style={
                    sel?.kind === "ending"
                      ? { boxShadow: "0 0 0 1.5px var(--primary), 0 0 14px color-mix(in oklab, var(--primary) 25%, transparent)" }
                      : undefined
                  }
                >
                  <span
                    className="inline-block rounded-[10px] px-5 py-2.5 text-[13px] font-bold opacity-90"
                    style={{ background: accent, color: accentInk(accent) }}
                  >
                    {(locale !== base ? settings.i18n?.[locale]?.submitLabel : undefined) ||
                      settings.submitLabel ||
                      t`Submit`}
                  </span>
                  <p className="mt-2.5 text-[12.5px]" style={{ color: cp.muted }}>
                    {(locale !== base ? settings.i18n?.[locale]?.successMessage : undefined) ||
                      settings.successMessage ||
                      t`Your submission has been received.`}
                  </p>
                </div>
              </div>
            </div>
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
                eligible={eligible}
                usedNames={usedNames}
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
                versioned={collVersioned}
                onOpenCollection={() => setActiveNav?.("collections/" + form.collection)}
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
          languages={languages}
          onRotate={() => setConfirm("rotate")}
          onHideLink={() => {
            tokenCache.delete(form.id);
            bumpTokenCache((x) => x + 1);
          }}
          onToggleActive={(v) => patchForm({ active: v })}
          onToggleTurnstile={(v) => patchSettings({ turnstile: v })}
          onPatchSettings={patchSettings}
          pushToast={pushToast}
        />
      )}

      {tab === "results" && (
        <ResultsTab
          form={form}
          onOpenCollection={() => setActiveNav?.("collections/" + form.collection)}
        />
      )}

      {tab === "submissions" && (
        <SubmissionsTab
          form={form}
          fieldBlocks={fieldBlocks}
          efByName={efByName}
          pushToast={pushToast}
          refreshCounts={refreshCounts}
          onOpenCollection={() => setActiveNav?.("collections/" + form.collection)}
        />
      )}

      <InsertPalette
        open={insertAt !== null}
        onClose={() => setInsertAt(null)}
        eligible={eligible.filter((f) => !usedNames.has(f.name))}
        onPick={(item) => {
          if (item === "step") {
            insertBlock({ id: newBlockId(), kind: "step", label: t`New step` }, insertAt);
          } else if (item === "matrix") {
            // Seeded with two rows that already agree on their columns: the
            // builder saves as you type, and an empty matrix is a block the
            // server is right to refuse.
            const seeded = seedMatrix(eligible.filter((f) => !usedNames.has(f.name)));
            if (!seeded) {
              pushToast(
                t`A matrix needs two fields that can share one set of columns — two number fields, or two dropdowns offering the same choices.`,
              );
              return;
            }
            insertBlock({ id: newBlockId(), label: t`New matrix`, ...seeded }, insertAt);
          } else {
            insertBlock({ id: newBlockId(), kind: "field", name: item.name }, insertAt);
          }
        }}
      />

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
  pushToast: PushToast;
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
      // Start with the collection's required eligible fields so the form is
      // valid immediately; the builder does the rest. When nothing is
      // required, seed ONE sensible field — preferring human-facing names and
      // skipping identifier-ish ones (slug/id/code…) a visitor shouldn't type.
      const ef = await formsApi.eligibleFields(collection);
      const seed = ef.data.filter((f) => f.required);
      const IDENTIFIER_RE = /^(slug|id|uuid|key|code|sort([-_]?order)?|position|order|external[-_]?id)$/i;
      const PREFERRED_RE = /^(name|full[-_]?name|title|email|subject|message)$/i;
      const fallback =
        ef.data.find((f) => PREFERRED_RE.test(f.name)) ??
        ef.data.find((f) => !IDENTIFIER_RE.test(f.name)) ??
        ef.data[0];
      const initial = (seed.length > 0 ? seed : fallback ? [fallback] : []).map((f) => ({
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

function InsertPalette({
  open,
  onClose,
  eligible,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  eligible: ApiFormEligibleField[];
  onPick: (item: ApiFormEligibleField | "step" | "matrix") => void;
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
  // A matrix has nothing to ask until two fields can share one set of columns.
  const matrixCandidates = eligible.filter((f) => f.type === "integer" || f.choices);
  const showMatrix =
    matrixCandidates.length >= 2 &&
    (!ql || "matrix".includes(ql) || t`Matrix`.toLowerCase().includes(ql));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
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
        <DialogBody>
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
            {(showStep || showMatrix) && (
              <div className="mt-1 border-t border-border px-2.5 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
                <Trans>layout</Trans>
              </div>
            )}
            {showStep && (
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
            )}
            {showMatrix && (
              <button
                type="button"
                onClick={() => onPick("matrix")}
                className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left hover:bg-accent/50"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                  <I.Grid3 size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium"><Trans>Matrix</Trans></span>
                  <span className="block text-[10.5px] text-muted-foreground">
                    <Trans>Several questions on one shared set of columns</Trans>
                  </span>
                </span>
              </button>
            )}
            {fields.length === 0 && !showStep && !showMatrix && (
              <p className="px-2.5 py-4 text-center text-[12px] text-muted-foreground">
                <Trans>No blocks match "{q}"</Trans>
              </p>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
