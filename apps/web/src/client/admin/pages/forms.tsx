// Public forms — Tally-style builder implementing the "Backlex Forms" design:
// a card list view, then a full builder with an Edit tab (canvas of blocks +
// insert palette + right settings panel), a Share tab (link / embed / rotate /
// delivery) and a Submissions tab (counters + rows straight from the target
// collection). Changes autosave (debounced PATCH) with a saved indicator; the
// one-time token is cached per-session so Share can show the link right after
// create/rotate and stays honest ("hidden — rotate") otherwise.
import type { PushToast } from "../types";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import { ACCENTS, accentInk, fontStack, safeAccent, useFonts } from "@/lib/public-theme";
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
import { cn } from "@backlex/ui/lib/utils";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogBody,
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
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@backlex/ui/components/sheet";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ConfirmDialog } from "../sheet";
import {
  collectionsApi,
  formsApi,
  itemsApi,
  type ApiForm,
  type ApiFormBlock,
  type ApiFormBlockMatrixRow,
  type ApiFormBlockScale,
  type ApiFormEligibleField,
  type ApiFormInvite,
  type ApiFormResultBlock,
  type ApiFormResults,
  type ApiFormSettings,
  type ApiMintedFormInvite,
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

/* The canvas is "what visitors see": it renders with the FORM's theme, accent
   and font (same palettes as the public page), not the admin theme. */
// Mirrors the public page's DARK palette (and the admin card surface) so the
// canvas shows exactly the card visitors get.
const CANVAS_DARK = {
  bg: "#0E0C18",
  text: "#ECEAF7",
  muted: "#A6A1C2",
  border: "rgba(255,255,255,0.09)",
  inputBg: "rgba(255,255,255,0.03)",
};
const CANVAS_LIGHT = {
  bg: "#FFFFFF",
  text: "#17141F",
  muted: "#5F5A73",
  border: "rgba(20,15,45,0.12)",
  inputBg: "rgba(20,15,45,0.03)",
};
type CanvasPalette = typeof CANVAS_DARK;



/** The scale a block renders as — the same `scale`-then-legacy-`rating`
 *  fallback the public page applies, so the canvas preview and the live form
 *  never disagree about what the question looks like. */
const blockScale = (
  block: ApiFormBlock,
  ef: ApiFormEligibleField | null | undefined,
): ApiFormBlockScale | null => {
  if (!ef || ef.type !== "integer") return null;
  if (block.scale) return block.scale;
  if (block.rating) return { min: 1, max: 5, style: "stars" };
  return null;
};

/** Epoch ms → the `datetime-local` spelling, in the operator's OWN zone.
 *  An opening time is set by a person looking at a clock on a wall; storing it
 *  as an instant is right, showing it in UTC is not. */
const toLocalInput = (ms: number | undefined): string => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** …and back. An empty input clears the setting rather than storing epoch 0,
 *  which would close every form ever opened. */
const fromLocalInput = (value: string): number | undefined => {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/** The points a scale offers, low to high. */
const scalePoints = (scale: ApiFormBlockScale): number[] =>
  Array.from({ length: Math.max(0, scale.max - scale.min + 1) }, (_, i) => scale.min + i);

/** The signature two fields must share to be rows of the same choice matrix —
 *  same choices, same order, because the columns are drawn once for all rows. */
const choiceSignature = (f: ApiFormEligibleField): string | null =>
  f.choices?.length ? f.choices.join("␟") : null;

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

/** The fields a matrix may still take as rows: eligible, unused, and able to
 *  share the columns the rows it already has are answered on. */
const matrixRowCandidates = (
  block: ApiFormBlock,
  eligible: ApiFormEligibleField[],
  used: Set<string | undefined>,
  efByName: Map<string, ApiFormEligibleField>,
): ApiFormEligibleField[] => {
  const first = (block.rows ?? []).map((r) => efByName.get(r.name)).find(Boolean);
  const free = eligible.filter((f) => !used.has(f.name));
  if (!first) return free.filter((f) => f.type === "integer" || f.choices);
  if (block.scale) return free.filter((f) => f.type === "integer");
  const sig = choiceSignature(first);
  return sig ? free.filter((f) => choiceSignature(f) === sig) : [];
};

const blockIcon = (ef: ApiFormEligibleField | null | undefined, block: ApiFormBlock) => {
  if (block.kind === "matrix") return I.Grid3;
  if ((block.kind ?? "field") === "step") return I.Layers;
  if (!ef) return I.Type;
  if (ef.choices && ef.type === "json") return I.CheckCircle;
  if (ef.choices) return I.LayoutList;
  if (ef.format === "email") return I.Mail;
  if (ef.format === "url") return I.Link;
  switch (ef.type) {
    case "integer": {
      const scale = blockScale(block, ef);
      if (!scale) return I.Hash;
      return scale.style === "stars" ? I.Star : I.Gauge;
    }
    case "number":
      return I.Hash;
    case "boolean":
      return I.Check;
    case "timestamp":
      return I.Calendar;
    case "longtext":
      return I.Type;
    case "file":
      return I.Upload;
    default:
      return I.Type;
  }
};

/** Accepted-type presets for file blocks — each chip toggles its MIME
 *  patterns in `block.accept`. No selection ⇒ any type. */
const FILE_ACCEPT_PRESETS: Array<{ key: string; patterns: string[] }> = [
  { key: "images", patterns: ["image/*"] },
  { key: "pdf", patterns: ["application/pdf"] },
  {
    key: "documents",
    patterns: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ],
  },
  {
    key: "spreadsheets",
    patterns: [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  { key: "video", patterns: ["video/*"] },
  { key: "audio", patterns: ["audio/*"] },
  { key: "archives", patterns: ["application/zip", "application/gzip", "application/x-7z-compressed"] },
];

/** Size choices for the file-block cap. The env ceiling
 *  (`FORM_UPLOAD_MAX_BYTES`, default 5 MB) still clamps at upload time. */
const FILE_SIZE_OPTIONS = [1, 2, 5, 10, 25, 50] as const;

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

/** Design live/paused chip: mono uppercase, dotted, tinted border. */
function LivePill({ active }: { active: boolean }) {
  return active ? (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-emerald-400">
      <span className="size-[5px] rounded-full bg-emerald-400" />
      <Trans>live</Trans>
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-border bg-white/5 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
      <Trans>paused</Trans>
    </span>
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

function CanvasFieldPreview({
  block,
  ef,
  locale,
  base,
  p,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField | null;
  locale: string;
  base: string;
  p: CanvasPalette;
}) {
  const { t } = useLingui();
  const loc = locale !== base ? block.i18n?.[locale] : undefined;
  const ph = loc?.placeholder || block.placeholder || "";
  if (!ef) return null;
  const LeadIcon = blockIcon(ef, block);
  const boxStyle: React.CSSProperties = {
    borderColor: p.border,
    background: p.inputBg,
    color: p.muted,
  };
  if (ef.choices && ef.type === "json") {
    return (
      <div className="flex flex-col gap-2">
        {ef.choices.slice(0, 4).map((c) => (
          <div key={c} className="flex items-center gap-2.5 text-[13.5px]" style={{ color: p.muted }}>
            <span className="size-[17px] shrink-0 rounded-[5px] border-[1.5px]" style={{ borderColor: p.border, background: p.inputBg }} />
            {c}
          </div>
        ))}
        {ef.choices.length > 4 && (
          <span className="self-start rounded-full border border-dashed px-2.5 py-1 text-[11.5px]" style={{ borderColor: p.border, color: p.muted }}>
            + {ef.choices.length - 4} <Trans>more</Trans>
          </span>
        )}
      </div>
    );
  }
  if (ef.choices) {
    return (
      <>
        <div className="flex h-10 items-center gap-2 rounded-[10px] border px-3 text-[13.5px]" style={boxStyle}>
          <LeadIcon size={13} />
          <span>{t`Select one…`}</span>
          <span className="ml-auto"><I.ChevronDown size={14} /></span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {ef.choices.slice(0, 4).map((c) => (
            <span
              key={c}
              className="rounded-full border px-2.5 py-1 text-[11.5px]"
              style={{ borderColor: p.border, color: p.muted }}
            >
              {c}
            </span>
          ))}
          {ef.choices.length > 4 && (
            <span
              className="rounded-full border border-dashed px-2.5 py-1 text-[11.5px]"
              style={{ borderColor: p.border, color: p.muted }}
            >
              + {ef.choices.length - 4} <Trans>more</Trans>
            </span>
          )}
        </div>
      </>
    );
  }
  const previewScale = blockScale(block, ef);
  if (previewScale) {
    const points = scalePoints(previewScale);
    return (
      <div className="flex flex-col gap-1.5">
        {previewScale.style === "stars" ? (
          <div className="flex flex-wrap items-center gap-1" style={{ color: p.muted }}>
            {points.map((n) => (
              <I.Star key={n} size={17} />
            ))}
            <span className="ml-1 text-[11px]">
              {previewScale.min}–{previewScale.max}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {points.map((n) => (
              <span
                key={n}
                // Fixed cells, matching the public page: a growing basis makes
                // the three points that wrap onto a second row three times the
                // size of the eight above them.
                className="flex h-8 w-9 shrink-0 items-center justify-center rounded-[9px] border text-[12.5px]"
                style={{ borderColor: p.border, background: p.inputBg, color: p.muted }}
              >
                {n}
              </span>
            ))}
          </div>
        )}
        {(previewScale.minLabel || previewScale.maxLabel) && (
          <div className="flex justify-between gap-3 text-[11px]" style={{ color: p.muted }}>
            <span>{previewScale.minLabel ?? ""}</span>
            <span className="text-right">{previewScale.maxLabel ?? ""}</span>
          </div>
        )}
      </div>
    );
  }
  if (ef.type === "longtext") {
    return (
      <div className="flex h-[74px] items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[13.5px]" style={boxStyle}>
        <span className="mt-0.5"><LeadIcon size={13} /></span>
        <span className="opacity-70">{ph}</span>
      </div>
    );
  }
  if (ef.type === "file") {
    return (
      <div
        className="flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-dashed px-3 py-3 text-[13px]"
        style={{ borderColor: p.border, background: p.inputBg, color: p.muted }}
      >
        <I.Upload size={16} />
        <span><Trans>Choose a file or drag it here</Trans></span>
        <span className="text-[11px] opacity-70">
          <Trans>up to {Math.floor((block.maxBytes ?? 5 * 1024 * 1024) / 1024 / 1024)} MB</Trans>
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-10 items-center gap-2 rounded-[10px] border px-3 text-[13.5px]" style={boxStyle}>
      <LeadIcon size={13} />
      <span className="opacity-70">{ph || (ef.type === "timestamp" ? "YYYY-MM-DD" : "")}</span>
    </div>
  );
}

/** The columns a matrix draws, as the builder sees them: the block's own scale,
 *  or the choices its rows agree on. Mirrors `resolveMatrixColumns` on the
 *  server so the canvas and the live form never disagree. */
function matrixColumnLabels(
  block: ApiFormBlock,
  efByName: Map<string, ApiFormEligibleField>,
): string[] {
  if (block.scale) return scalePoints(block.scale).map(String);
  const first = (block.rows ?? []).map((r) => efByName.get(r.name)).find(Boolean);
  return first?.choices ?? [];
}

/** The grid, in miniature — same columns, same rows, no answers. */
function CanvasMatrixPreview({
  block,
  efByName,
  locale,
  base,
  accent,
  p,
}: {
  block: ApiFormBlock;
  efByName: Map<string, ApiFormEligibleField>;
  locale: string;
  base: string;
  accent: string;
  p: CanvasPalette;
}) {
  const columns = matrixColumnLabels(block, efByName);
  const rows = (block.rows ?? []).filter((r) => efByName.has(r.name));
  if (columns.length === 0 || rows.length === 0) return null;
  return (
    <div
      className="grid items-center gap-1.5 text-[12px]"
      style={{
        gridTemplateColumns: `minmax(0,1.4fr) repeat(${columns.length}, minmax(0,1fr))`,
        color: p.muted,
      }}
    >
      <span />
      {columns.map((c) => (
        <span key={c} className="truncate text-center text-[10.5px] leading-tight">
          {c}
        </span>
      ))}
      {rows.map((r) => {
        const ef = efByName.get(r.name);
        const loc = locale !== base ? r.i18n?.[locale] : undefined;
        return (
          <Fragment key={r.name}>
            <span className="min-w-0 truncate pr-1.5" style={{ color: p.text }}>
              {loc?.label || r.label || ef?.label || humanize(r.name)}
              {ef?.required && <span style={{ color: accent }}> *</span>}
            </span>
            {columns.map((c) => (
              <span key={c} className="flex h-7 items-center justify-center">
                <span
                  className="size-[11px] rounded-full border-[1.5px]"
                  style={{ borderColor: p.border, background: p.inputBg }}
                />
              </span>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function InsertDot({ onClick, bg }: { onClick: () => void; bg: string }) {
  const { t } = useLingui();
  // Editor chrome — always the admin primary, never the form's accent (this
  // control isn't part of the published form).
  return (
    <button
      type="button"
      title={t`Add block`}
      onClick={onClick}
      className="-mx-6 flex h-6 w-[calc(100%+3rem)] items-center gap-2 px-3.5 text-primary opacity-60 transition-opacity hover:opacity-100 sm:-mx-8 sm:w-[calc(100%+4rem)]"
    >
      <span className="h-px flex-1 bg-primary/45" />
      <span className="grid size-[18px] place-items-center rounded-full border border-primary/55" style={{ background: bg }}>
        <I.Plus size={10} />
      </span>
      <span className="h-px flex-1 bg-primary/45" />
    </button>
  );
}

/* ── builder ───────────────────────────────────────────────────────── */

type BuilderTab = "edit" | "share" | "results" | "submissions";
type Selection = { kind: "block"; id: string } | { kind: "ending" } | null;

export function FormsPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: PushToast;
  setActiveNav?: (nav: string) => void;
}) {
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

/** Widest a hand-set scale may be — mirrors `SCALE_MAX_POINTS` on the server,
 *  which refuses anything wider. */
const SCALE_MAX_POINTS = 11;

/**
 * How an integer question is answered.
 *
 * The four styles are the whole finite set, so they are a dropdown rather than
 * a switch per style: a plain number input, a star row, a numbered row, and
 * NPS — which is a numbered row with its ends nailed to 0 and 10 because that
 * is what makes the score comparable to anyone else's.
 */
function ScaleEditor({
  block,
  ef,
  onPatch,
  allowPlain = true,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField;
  onPatch: (id: string, patch: Partial<ApiFormBlock>) => void;
  /** False on a matrix, where the shared scale IS the columns: dropping it
   *  would leave rows with nothing to be answered on. */
  allowPlain?: boolean;
}) {
  const { t } = useLingui();
  const scale = blockScale(block, ef);
  const style = scale?.style ?? "input";
  const set = (next: ApiFormBlockScale | undefined) =>
    // The legacy `rating` flag is cleared alongside: leaving it set would
    // resurrect the 1–5 star row on any reader that still prefers it.
    onPatch(block.id!, { scale: next, rating: undefined });

  const bounds = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      value: String(from + i),
      label: String(from + i),
    }));

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <span className="flex items-center gap-1.5">
          <I.Gauge size={12} />
          <Trans>Answer style</Trans>
        </span>
        <Select
          value={style}
          onChange={(v) => {
            if (v === "input") return set(undefined);
            if (v === "nps") return set({ min: 0, max: 10, style: "nps" });
            if (v === "stars") return set({ min: 1, max: 5, style: "stars" });
            return set({ min: scale?.min ?? 1, max: scale?.max ?? 5, style: "number" });
          }}
          options={[
            ...(allowPlain ? [{ value: "input", label: t`Number input` }] : []),
            { value: "stars", label: t`Star rating` },
            { value: "number", label: t`Numbered scale` },
            { value: "nps", label: t`NPS — how likely to recommend (0–10)` },
          ]}
        />
      </label>

      {scale && style !== "nps" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>From</Trans>
            <Select
              value={String(scale.min)}
              onChange={(v) => {
                const min = Number(v);
                set({ ...scale, min, max: Math.min(Math.max(scale.max, min + 1), min + SCALE_MAX_POINTS - 1) });
              }}
              options={bounds(0, 1)}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>To</Trans>
            <Select
              value={String(scale.max)}
              onChange={(v) => set({ ...scale, max: Number(v) })}
              options={bounds(scale.min + 1, scale.min + SCALE_MAX_POINTS - 1)}
            />
          </label>
        </div>
      )}

      {scale && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>Low label</Trans>
            <Input
              value={scale.minLabel ?? ""}
              placeholder={t`Not at all`}
              onChange={(e) => set({ ...scale, minLabel: e.target.value || undefined })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>High label</Trans>
            <Input
              value={scale.maxLabel ?? ""}
              placeholder={t`Extremely`}
              onChange={(e) => set({ ...scale, maxLabel: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      {style === "nps" && (
        <span className="text-[11px] text-muted-foreground">
          <Trans>
            Results score this as promoters (9–10) minus detractors (0–6).
          </Trans>
        </span>
      )}
    </div>
  );
}

/**
 * The rows of a matrix, and the columns they are all answered on.
 *
 * The columns are not chosen here — they follow from the fields the rows name,
 * which is why the row picker only offers fields that can be answered on the
 * columns the matrix already has. An operator cannot assemble a grid the server
 * would refuse, because the ingredients for one are never on the menu.
 */
function MatrixEditor({
  block,
  firstRowEf,
  efByName,
  eligible,
  usedNames,
  locale,
  base,
  collection,
  onPatch,
}: {
  block: ApiFormBlock;
  firstRowEf: ApiFormEligibleField | null;
  efByName: Map<string, ApiFormEligibleField>;
  eligible: ApiFormEligibleField[];
  usedNames: Set<string | undefined>;
  locale: string;
  base: string;
  collection: string;
  onPatch: (id: string, patch: Partial<ApiFormBlock>) => void;
}) {
  const { t } = useLingui();
  const rows = block.rows ?? [];
  const onScale = Boolean(block.scale) || (firstRowEf?.type === "integer" && !firstRowEf.choices);
  const candidates = matrixRowCandidates(block, eligible, usedNames, efByName);
  const setRows = (next: ApiFormBlockMatrixRow[]) => onPatch(block.id!, { rows: next });

  const patchRow = (index: number, patch: Partial<ApiFormBlockMatrixRow>) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const moveRow = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    setRows(next);
  };

  /** A row's caption in the locale being edited; empty falls back down the
   *  same chain the public page uses. */
  const rowLabel = (row: ApiFormBlockMatrixRow) =>
    locale === base ? row.label ?? "" : row.i18n?.[locale]?.label ?? "";
  const setRowLabel = (index: number, value: string) =>
    locale === base
      ? patchRow(index, { label: value || undefined })
      : patchRow(index, {
          i18n: {
            ...rows[index]?.i18n,
            [locale]: { ...rows[index]?.i18n?.[locale], label: value || undefined },
          },
        });

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex flex-col gap-1.5">
        <PanelLabel>
          <span className="flex items-center gap-1">
            <I.Grid3 size={11} />
            <Trans>rows · {rows.length}</Trans>
          </span>
        </PanelLabel>
        {rows.map((row, i) => {
          const rowEf = efByName.get(row.name);
          return (
            <div key={row.name} className="flex items-center gap-1.5">
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  title={t`Move up`}
                  onClick={() => moveRow(i, -1)}
                  className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground"
                >
                  <I.ChevronUp size={10} />
                </button>
                <button
                  type="button"
                  title={t`Move down`}
                  onClick={() => moveRow(i, 1)}
                  className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground"
                >
                  <I.ChevronDown size={10} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  value={rowLabel(row)}
                  placeholder={
                    locale === base
                      ? rowEf?.label ?? humanize(row.name)
                      : row.label || rowEf?.label || humanize(row.name)
                  }
                  onChange={(e) => setRowLabel(i, e.target.value)}
                />
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                  {row.name}
                  {!rowEf && <span className="text-destructive"> · <Trans>not on this collection</Trans></span>}
                </span>
              </div>
              {rows.length > 1 && !rowEf?.required && (
                <IconButton
                  icon={I.X}
                  title={t`Remove row`}
                  onClick={() => setRows(rows.filter((_, x) => x !== i))}
                />
              )}
            </div>
          );
        })}
        {candidates.length > 0 ? (
          <Select
            value=""
            onChange={(v) => v && setRows([...rows, { name: v }])}
            options={[
              { value: "", label: t`Add a row…` },
              ...candidates.map((f) => ({
                value: f.name,
                label: f.label ?? humanize(f.name),
              })),
            ]}
          />
        ) : (
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            {onScale ? (
              <Trans>Every free number field on <span className="font-mono">{collection}</span> is already on the form.</Trans>
            ) : (
              <Trans>No other field on <span className="font-mono">{collection}</span> offers these same choices.</Trans>
            )}
          </span>
        )}
      </div>

      {onScale && firstRowEf ? (
        <ScaleEditor block={block} ef={firstRowEf} onPatch={onPatch} allowPlain={false} />
      ) : (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <PanelLabel><Trans>columns · from schema enum</Trans></PanelLabel>
          <div className="flex flex-wrap gap-1">
            {(firstRowEf?.choices ?? []).map((c) => (
              <span key={c} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {c}
              </span>
            ))}
          </div>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            <Trans>Every row is answered on these — edit them on the field in <span className="font-mono">{collection}</span>.</Trans>
          </span>
        </div>
      )}
    </div>
  );
}

function DesignPanel({
  settings,
  languages,
  collection,
  eligibleCount,
  versioned,
  onOpenCollection,
  onPatch,
}: {
  settings: ApiFormSettings;
  languages: string[];
  collection: string;
  eligibleCount: number;
  versioned: boolean;
  onOpenCollection: () => void;
  onPatch: (p: Partial<ApiFormSettings>) => void;
}) {
  const { t } = useLingui();
  const accent = safeAccent(settings.accent);
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
          <ColorSwatchPicker
            options={ACCENTS.map((c) => ({ value: c, swatch: c }))}
            value={accent}
            onChange={(accent) => onPatch({ accent })}
            showValue
          />
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
              { value: "system", label: t`System` },
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
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <PanelLabel><Trans>source collection</Trans></PanelLabel>
          <div className="flex items-center gap-2 rounded-control border border-border bg-background/50 px-3 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-primary/10 text-primary">
              <I.Database size={12} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px]">{collection}</div>
              <div className="truncate text-[10.5px] text-muted-foreground">
                <Trans>{eligibleCount} eligible fields</Trans>
                {versioned && <span> · <Trans>versioned</Trans></span>}
              </div>
            </div>
            <IconButton icon={I.ExternalLink} title={t`Open collection`} onClick={onOpenCollection} />
          </div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            <Trans>Select a block on the canvas to edit its settings. Scalar and
            file fields can be exposed — never private or computed ones.</Trans>
          </p>
        </div>
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
  eligible,
  usedNames,
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
  eligible: ApiFormEligibleField[];
  usedNames: Set<string | undefined>;
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
  const isMatrix = block.kind === "matrix";
  // The first row decides what the rest can be — it is the field whose type
  // (or choices) the columns are drawn from.
  const firstRowEf = isMatrix
    ? (block.rows ?? []).map((r) => efByName.get(r.name)).find(Boolean) ?? null
    : null;
  // A matrix holding a schema-required field can't be removed for the same
  // reason a required field block can't: the form would stop validating.
  const holdsRequired = isMatrix
    ? (block.rows ?? []).some((r) => efByName.get(r.name)?.required)
    : Boolean(ef?.required);
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
      icon={blockIcon(ef, block)}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12px]">
            {isStep ? t`Step break` : isMatrix ? t`Matrix` : block.name}
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
      {!isStep && ef && !ef.choices && ef.type !== "boolean" && ef.type !== "file" && !blockScale(block, ef) && (
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
        <div className="flex items-center justify-between gap-2 text-[12px] font-medium">
          <div className="min-w-0">
            <Trans>Required</Trans>
            {block.consent && ef.type === "boolean" ? (
              <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-normal text-muted-foreground">
                <I.Shield size={10} />
                <Trans>consent must be accepted — always required</Trans>
              </div>
            ) : ef.required ? (
              <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-normal text-muted-foreground">
                <I.Lock size={10} />
                <Trans>required by the collection schema</Trans>
              </div>
            ) : (
              <div className="mt-0.5 text-[10.5px] font-normal text-muted-foreground"><Trans>optional</Trans></div>
            )}
          </div>
          {(block.consent && ef.type === "boolean") || ef.required ? (
            <span className="pointer-events-none opacity-55">
              <Switch checked onChange={() => {}} />
            </span>
          ) : null}
        </div>
      )}

      {!isStep && !isMatrix && ef?.type === "integer" && (
        <ScaleEditor block={block} ef={ef} onPatch={onPatch} />
      )}

      {isMatrix && (
        <MatrixEditor
          block={block}
          firstRowEf={firstRowEf}
          efByName={efByName}
          eligible={eligible}
          usedNames={usedNames}
          locale={locale}
          base={base}
          collection={collection}
          onPatch={onPatch}
        />
      )}

      {!isStep && ef?.type === "file" && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-[12px] font-medium">
            <span className="flex items-center gap-1.5"><I.Upload size={12} /><Trans>Max file size</Trans></span>
            <Select
              value={block.maxBytes ? String(block.maxBytes) : "default"}
              onChange={(v) =>
                onPatch(block.id!, { maxBytes: v === "default" ? undefined : Number(v) })
              }
              options={[
                { value: "default", label: t`Server default (5 MB)` },
                ...FILE_SIZE_OPTIONS.map((mb) => ({
                  value: String(mb * 1024 * 1024),
                  label: `${mb} MB`,
                })),
              ]}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>The server-wide upload ceiling still applies on top.</Trans>
            </span>
          </label>
          <div className="flex flex-col gap-1.5">
            <PanelLabel><Trans>Accepted types</Trans></PanelLabel>
            <div className="flex flex-wrap gap-1">
              {FILE_ACCEPT_PRESETS.map((preset) => {
                const cur = block.accept ?? [];
                const active = preset.patterns.every((pt) => cur.includes(pt));
                const labels: Record<string, string> = {
                  images: t`Images`,
                  pdf: t`PDF`,
                  documents: t`Documents`,
                  spreadsheets: t`Spreadsheets`,
                  video: t`Video`,
                  audio: t`Audio`,
                  archives: t`Archives`,
                };
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => {
                      const next = active
                        ? cur.filter((x) => !preset.patterns.includes(x))
                        : [...cur, ...preset.patterns.filter((x) => !cur.includes(x))];
                      onPatch(block.id!, { accept: next.length ? next : undefined });
                    }}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50",
                    )}
                  >
                    {labels[preset.key]}
                  </button>
                );
              })}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {block.accept?.length ? (
                <Trans>Only the selected types are accepted — enforced server-side.</Trans>
              ) : (
                <Trans>No selection — any file type is accepted.</Trans>
              )}
            </span>
          </div>
        </div>
      )}

      {!isStep && ef?.type === "boolean" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12px] font-medium">
            <span className="flex items-center gap-1.5"><I.Shield size={12} /><Trans>Consent checkbox</Trans></span>
            <Switch checked={Boolean(block.consent)} onChange={(v) => onPatch(block.id!, { consent: v })} />
          </div>
          {block.consent && (
            <>
              <span className="text-[11px] text-muted-foreground">
                <Trans>Visitors must tick it to submit — enforced server-side. Put the
                consent sentence in the Label.</Trans>
              </span>
              <label className="flex flex-col gap-1 text-[12px] font-medium">
                <Trans>Policy URL</Trans>
                <Input
                  value={block.policyUrl ?? ""}
                  placeholder="https://example.com/privacy"
                  onChange={(e) => onPatch(block.id!, { policyUrl: e.target.value || undefined })}
                />
                <span className="text-[11px] font-normal text-muted-foreground">
                  <Trans>Shown as a "read the full text" link next to the checkbox.</Trans>
                </span>
              </label>
            </>
          )}
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

      {!isStep && holdsRequired ? (
        <div className="flex items-center justify-center gap-1.5 rounded-control border border-dashed border-border px-3 py-2.5 text-[11.5px] text-muted-foreground">
          <I.Lock size={11} />
          <Trans>required by the schema — can't be removed from the form</Trans>
        </div>
      ) : (
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
      )}
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

/**
 * Invite-only mode, and the links that make it mean something.
 *
 * The links are shown ONCE — in the mint response — so they stay on screen
 * until the operator navigates away, with a copy button each. The list below
 * is the durable half: who was invited and who has answered. It never carries
 * a token, and the panel says so rather than letting someone hunt for one.
 */
function InvitesCard({
  form,
  formToken,
  onPatchSettings,
  pushToast,
}: {
  form: ApiForm;
  /** The form's own plaintext token, when this session still holds it — it is
   *  what turns a minted invite into a ready-made link. */
  formToken: string | null;
  onPatchSettings: (p: Partial<ApiFormSettings>) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [invites, setInvites] = useState<ApiFormInvite[] | null>(null);
  const [minted, setMinted] = useState<ApiMintedFormInvite[] | null>(null);
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    let cancelled = false;
    formsApi
      .invites(form.id)
      .then((r) => !cancelled && setInvites(r.data))
      .catch(() => !cancelled && setInvites([]));
    return () => {
      cancelled = true;
    };
  }, [form.id]);

  const parsed = emails
    .split(/[,\n;]/)
    .map((e) => e.trim())
    .filter(Boolean);

  const mint = async (send: boolean) => {
    if (parsed.length === 0) return;
    setBusy(true);
    try {
      const res = await formsApi.invite(form.id, {
        recipients: parsed.map((email) => ({ email })),
        ...(formToken ? { formToken } : {}),
        ...(send ? { send: true } : {}),
      });
      setMinted(res.data.invites);
      setEmails("");
      setInvites((prev) => [...(prev ?? []), ...res.data.invites]);
      pushToast(
        send
          ? t`${res.data.invites.length} invited, ${res.data.sent} emailed.`
          : t`${res.data.invites.length} link(s) minted — copy them now.`,
      );
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invite: ApiFormInvite) => {
    const snapshot = invites;
    setInvites((prev) => (prev ?? []).filter((i) => i.id !== invite.id));
    setMinted((prev) => prev?.filter((i) => i.id !== invite.id) ?? null);
    try {
      await formsApi.revokeInvite(form.id, invite.id);
    } catch (e) {
      setInvites(snapshot);
      pushToast((e as Error).message);
    }
  };

  const answered = (invites ?? []).filter((i) => i.usedAt).length;
  const waiting = (invites ?? []).filter((i) => !i.usedAt);

  /**
   * Nudge everyone still outstanding.
   *
   * Optimistic like every other mutation here: the rows say "reminded" before
   * the request lands and roll back if it doesn't. The fresh links join the
   * shown-once box, because they are shown once — and the earlier ones keep
   * working, so nothing the operator already handed out has to be chased.
   */
  const remind = async (send: boolean) => {
    if (waiting.length === 0) return;
    const snapshot = invites;
    const stamp = Date.now();
    setBusy(true);
    setInvites((prev) =>
      (prev ?? []).map((i) =>
        i.usedAt ? i : { ...i, remindedAt: stamp, reminderCount: (i.reminderCount ?? 0) + 1 },
      ),
    );
    try {
      const res = await formsApi.remindInvites(form.id, {
        ...(formToken ? { formToken } : {}),
        ...(send ? { send: true } : {}),
        force: true,
      });
      if (res.data.invites.length > 0) setMinted(res.data.invites);
      // Reconcile: the server decides who was actually due.
      const fresh = await formsApi.invites(form.id);
      setInvites(fresh.data);
      pushToast(
        send
          ? t`${res.data.invites.length} reminded, ${res.data.sent} emailed.`
          : t`${res.data.invites.length} fresh link(s) — copy them now.`,
      );
    } catch (e) {
      setInvites(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelCard icon={I.Mail} title={<Trans>Invites</Trans>}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium"><Trans>Invite only</Trans></div>
          <div className="text-[11px] text-muted-foreground">
            <Trans>only a visitor holding an unspent link may answer</Trans>
          </div>
        </div>
        <Switch
          checked={Boolean(form.settings?.inviteOnly)}
          onChange={(v) => onPatchSettings({ inviteOnly: v || undefined })}
        />
      </div>

      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Email addresses</Trans>
        <Textarea
          rows={2}
          placeholder="ada@example.com, grace@example.com"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
        />
        <span className="text-[11px] font-normal text-muted-foreground">
          <Trans>Comma or newline separated. Each gets its own single-use link.</Trans>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => mint(false)} disabled={busy || parsed.length === 0}>
          {busy ? <Trans>Working…</Trans> : <Trans>Create links</Trans>}
        </Button>
        <Button variant="primary" icon={I.Mail} onClick={() => mint(true)} disabled={busy || parsed.length === 0}>
          <Trans>Create and email</Trans>
        </Button>
      </div>

      {waiting.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              icon={I.Refresh}
              onClick={() => remind(false)}
              disabled={busy}
            >
              <Trans>New links for {waiting.length} waiting</Trans>
            </Button>
            <Button variant="primary" icon={I.Mail} onClick={() => remind(true)} disabled={busy}>
              <Trans>Remind by email</Trans>
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">
            <Trans>
              Each gets a fresh link. The ones already sent keep working — every link
              into an invite opens the same turn, and answering spends it.
            </Trans>
          </span>
        </div>
      )}

      {minted && minted.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-control border border-primary/30 bg-primary/10 p-2.5">
          <span className="text-[11px] text-primary">
            <Trans>Shown once — these links cannot be listed again.</Trans>
          </span>
          {minted.map((i) => (
            <div key={i.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {i.url ? `${origin}${i.url}` : i.token}
              </span>
              <IconButton
                icon={I.Copy}
                title={t`Copy link`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(i.url ? `${origin}${i.url}` : i.token);
                    pushToast(t`Copied.`);
                  } catch {
                    pushToast(t`Copy failed — select and copy manually.`);
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      {minted && minted.length > 0 && !formToken && (
        <span className="text-[11px] text-muted-foreground">
          <Trans>
            Only the invite tokens are shown: generate a new form link above and the
            next batch comes back as full URLs.
          </Trans>
        </span>
      )}

      {invites === null ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : invites.length === 0 ? (
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>Nobody invited yet.</Trans>
        </span>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <span><Trans>Invited</Trans> {invites.length}</span>
            <span><Trans>Answered</Trans> {answered}</span>
          </div>
          <ScrollArea viewportClassName="max-h-[220px]" className="w-full">
            <div className="flex flex-col">
              {invites.map((i) => (
                <div
                  key={i.id}
                  className="flex items-center gap-2 border-b border-border py-1.5 text-[12px] last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate">{i.email ?? t`no address`}</span>
                  {!i.usedAt && (i.reminderCount ?? 0) > 0 && (
                    <span
                      className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground"
                      title={t`reminded ${relTime(i.remindedAt)}`}
                    >
                      <Trans>+{i.reminderCount}</Trans>
                    </span>
                  )}
                  <span
                    className={`shrink-0 font-mono text-[10px] uppercase ${i.usedAt ? "text-emerald-400" : "text-muted-foreground"}`}
                  >
                    {i.usedAt ? <Trans>answered</Trans> : i.sentAt ? <Trans>sent</Trans> : <Trans>not sent</Trans>}
                  </span>
                  <IconButton icon={I.Trash} title={t`Revoke`} onClick={() => revoke(i)} />
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </PanelCard>
  );
}

function ShareTab({
  form,
  urls,
  languages,
  onRotate,
  onHideLink,
  onToggleActive,
  onToggleTurnstile,
  onPatchSettings,
  pushToast,
}: {
  form: ApiForm;
  urls: { url: string; embedUrl: string } | null;
  languages: string[];
  onRotate: () => void;
  onHideLink: () => void;
  onToggleActive: (v: boolean) => void;
  onToggleTurnstile: (v: boolean) => void;
  onPatchSettings: (p: Partial<ApiFormSettings>) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Share-time language pin: null = auto (visitor's browser language);
  // a code appends ?lang=xx to both the link and the embed src.
  const [shareLang, setShareLang] = useState<string | null>(null);
  const [embedMode, setEmbedMode] = useState<"script" | "iframe">("script");
  const langQs = shareLang ? `?lang=${encodeURIComponent(shareLang)}` : "";
  const absolute = urls ? `${origin}${urls.url}${langQs}` : null;
  const token = urls?.url.split("/f/")[1] ?? null;
  const iframe = urls
    ? embedMode === "script"
      ? `<div data-backlex-form="${token}"${shareLang ? ` data-lang="${shareLang}"` : ""}></div>\n<script src="${origin}/embed/form.js" async></script>`
      : `<iframe src="${origin}${urls.embedUrl}${langQs}" width="100%" height="620" frameborder="0"></iframe>`
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
    <div className="grid grid-cols-[1.25fr_1fr] gap-4 max-[900px]:grid-cols-1">
      <div className="flex flex-col gap-4">
        <PanelCard
          icon={I.Link}
          title={
            <span className="flex w-full items-center gap-2">
              <Trans>Public link</Trans>
              <span className="ml-auto"><LivePill active={form.active} /></span>
            </span>
          }
        >
          <p className="text-[11.5px] text-muted-foreground">
            <Trans>No auth on the visitor's side — the token in the URL is the
            credential. It's stored hashed, so it can only be shown{" "}
            <span className="text-amber-400">once</span>.</Trans>
          </p>
          {absolute && languages.length > 1 && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
                <Trans>language</Trans>
              </span>
              <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  type="button"
                  onClick={() => setShareLang(null)}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${
                    shareLang === null
                      ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Trans>auto</Trans>
                </button>
                {languages.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setShareLang(l)}
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${
                      shareLang === l
                        ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <span className="text-[10.5px] text-muted-foreground">
                {shareLang === null ? <Trans>visitor's browser language</Trans> : <Trans>link pins this language</Trans>}
              </span>
            </div>
          )}
          {absolute ? (
            <>
              <div className="flex items-center gap-2 rounded-control border border-amber-400/30 bg-amber-400/5 px-3 py-2 font-mono text-[10.5px] text-amber-400">
                <I.Lock size={11} />
                <Trans>shown once — copy it now, it won't appear again</Trans>
              </div>
              <div className="flex items-center gap-1.5">
                <Input readOnly value={absolute} className="border-amber-400/35 font-mono text-[12px]" />
                <IconButton icon={I.Copy} title={t`Copy link`} onClick={() => void copy(absolute)} />
                <IconButton icon={I.ExternalLink} title={t`Open form`} onClick={() => window.open(absolute, "_blank")} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={onHideLink}
                  className="text-[11.5px] font-medium text-muted-foreground underline underline-offset-2 hover:text-primary"
                >
                  <Trans>I copied it — hide the link</Trans>
                </button>
                <button
                  type="button"
                  title={t`Mints a new token; the current link stops working`}
                  onClick={onRotate}
                  className="flex items-center gap-1.5 rounded-control border border-orange-300/40 bg-orange-300/5 px-3 py-1.5 text-[12px] font-medium text-orange-300 hover:bg-orange-300/10"
                >
                  <I.Refresh size={12} />
                  <Trans>Rotate token</Trans>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-2 truncate rounded-control border border-border bg-background/40 px-3 py-2 font-mono text-[12px] text-muted-foreground">
                  <I.Lock size={12} />
                  {origin}/f/frm_{"•".repeat(12)}
                </div>
                <Button variant="primary" icon={I.Refresh} onClick={onRotate}>
                  <Trans>Generate new link</Trans>
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                <Trans>The token can't be shown again — generating a new link is the
                only way to get one. The old link stops working instantly; update any
                embeds.</Trans>
              </p>
            </>
          )}
        </PanelCard>
        <PanelCard
          icon={I.Code}
          title={
            <span className="flex w-full items-center gap-2">
              <Trans>Embed</Trans>
              {iframe && (
                <span className="ml-auto">
                  <Button variant="ghost" icon={I.Copy} onClick={() => void copy(iframe)}>
                    <Trans>Copy</Trans>
                  </Button>
                </span>
              )}
            </span>
          }
        >
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5">
              {(
                [
                  { value: "script", label: t`Script` },
                  { value: "iframe", label: "iframe" },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setEmbedMode(o.value)}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase ${
                    embedMode === o.value
                      ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="text-[10.5px] text-muted-foreground">
              {embedMode === "script" ? (
                <Trans>auto-sizes to the form's height — recommended</Trans>
              ) : (
                <Trans>fixed height, zero JavaScript</Trans>
              )}
            </span>
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            <Trans>Drop it into any site — the form keeps its own theme.</Trans>
          </p>
          {iframe ? (
            <ScrollArea className="w-full rounded-control border border-border bg-background/60">
              <pre className="whitespace-pre px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{iframe.replace(/" /g, '"\n  ')}</pre>
            </ScrollArea>
          ) : (
            <p className="rounded-control border border-dashed border-border px-3 py-2.5 text-[12px] text-muted-foreground">
              <Trans>Use "Generate new link" above — the embed snippet is minted
              together with it.</Trans>
            </p>
          )}
        </PanelCard>
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
        <PanelCard icon={I.Clock} title={<Trans>Who can answer, and until when</Trans>}>
          <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
              <Trans>Opens</Trans>
              <Input
                type="datetime-local"
                value={toLocalInput(form.settings?.opensAt)}
                onChange={(e) => onPatchSettings({ opensAt: fromLocalInput(e.target.value) })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
              <Trans>Closes</Trans>
              <Input
                type="datetime-local"
                value={toLocalInput(form.settings?.closesAt)}
                onChange={(e) => onPatchSettings({ closesAt: fromLocalInput(e.target.value) })}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[12px] font-medium">
            <Trans>Response limit</Trans>
            <Input
              type="number"
              min={1}
              placeholder={t`No limit`}
              value={form.settings?.maxResponses ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                onPatchSettings({
                  maxResponses: e.target.value === "" || !Number.isFinite(n) || n < 1 ? undefined : Math.floor(n),
                });
              }}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>
                Accepted so far: {form.submissionCount}. Checked before the row is
                written, so a simultaneous burst can land a couple over.
              </Trans>
            </span>
          </label>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium"><Trans>One answer per browser</Trans></div>
              <div className="text-[11px] text-muted-foreground">
                <Trans>a cookie, not an identity — another browser answers again</Trans>
              </div>
            </div>
            <Switch
              checked={Boolean(form.settings?.onePerBrowser)}
              onChange={(v) => onPatchSettings({ onePerBrowser: v || undefined })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium"><Trans>Save progress</Trans></div>
              <div className="text-[11px] text-muted-foreground">
                <Trans>
                  half-filled answers are kept so people can come back — invited
                  people resume on any device, everyone else in the same browser
                </Trans>
              </div>
            </div>
            <Switch
              checked={Boolean(form.settings?.saveProgress)}
              onChange={(v) => onPatchSettings({ saveProgress: v || undefined })}
            />
          </div>
          <label className="flex flex-col gap-1 text-[12px] font-medium">
            <Trans>Closed message</Trans>
            <Input
              placeholder={t`This form is closed.`}
              value={form.settings?.closedMessage ?? ""}
              onChange={(e) => onPatchSettings({ closedMessage: e.target.value || undefined })}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>Shown in place of the questions. The form keeps its title, so the
              link still says what it was.</Trans>
            </span>
          </label>
        </PanelCard>
        <InvitesCard form={form} formToken={token} onPatchSettings={onPatchSettings} pushToast={pushToast} />
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

/* ── submission detail drawer ──────────────────────────────────────── */

const MONO_TYPES = new Set(["integer", "number", "timestamp", "uuid"]);

function SubmissionDrawer({
  form,
  fieldBlocks,
  efByName,
  row,
  onClose,
  onDeleted,
  onOpenCollection,
  pushToast,
}: {
  form: ApiForm;
  fieldBlocks: ApiFormBlock[];
  efByName: Map<string, ApiFormEligibleField>;
  row: Record<string, unknown> | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onOpenCollection: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!row) return null;

  const id = String(row.id ?? "");
  // Headline: first text-ish answer; subline: first email-format answer.
  const nameField = fieldBlocks.find((b) => {
    const ef = efByName.get(b.name ?? "");
    return ef && (ef.type === "text" || ef.type === "longtext") && ef.format !== "email" && row[b.name!];
  });
  const emailField = fieldBlocks.find(
    (b) => efByName.get(b.name ?? "")?.format === "email" && row[b.name!],
  );
  const headline = String((nameField && row[nameField.name!]) ?? id);
  const initials = headline
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await itemsApi.remove(form.collection, id);
      onDeleted(id);
      onClose();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        className="flex flex-col gap-0 border-l border-primary/30 p-0"
        style={{ width: 434, maxWidth: "92vw" }}
      >
        {/* header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4.5 py-4">
          <div
            className="grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white"
            style={{ background: "linear-gradient(135deg,#8B6CFF,#ff9d83)" }}
          >
            {initials || "•"}
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[14.5px] font-bold">{headline}</SheetTitle>
            {emailField && (
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {String(row[emailField.name!])}
              </div>
            )}
          </div>
        </div>
        {/* meta grid */}
        <div className="grid shrink-0 grid-cols-2 gap-x-3.5 gap-y-2 border-b border-border px-4.5 py-3 text-[11px]">
          <div>
            <span className="text-muted-foreground/70"><Trans>Submitted</Trans></span>
            <div className="mt-0.5 font-mono text-[11.5px]">{relTime(row.createdAt ?? row.created_at)}</div>
          </div>
          <div>
            <span className="text-muted-foreground/70"><Trans>Row</Trans></span>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-primary">{id}</div>
          </div>
          <div>
            <span className="text-muted-foreground/70"><Trans>Checks</Trans></span>
            <div className="mt-0.5 font-mono text-[11.5px] text-emerald-400">
              honeypot ✓{form.settings?.turnstile ? " turnstile ✓" : ""}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground/70"><Trans>Collection</Trans></span>
            <div className="mt-0.5 truncate font-mono text-[11.5px]">{form.collection}</div>
          </div>
        </div>
        {/* answers */}
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
          <div className="flex flex-col px-4.5 pb-3.5 pt-1.5">
            {fieldBlocks
              .filter((b) => b.name)
              .map((b) => {
                const ef = efByName.get(b.name!);
                const v = row[b.name!];
                const mono = ef ? MONO_TYPES.has(ef.type) || Boolean(ef.format) : false;
                return (
                  <div key={b.name} className="border-b border-border/60 py-2.5 last:border-b-0">
                    <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground/70">
                      {b.name}
                    </div>
                    {v === null || v === undefined || v === "" ? (
                      <div className="text-[13px] text-muted-foreground/50">—</div>
                    ) : mono ? (
                      <div className="break-all font-mono text-[12.5px] text-muted-foreground">{String(v)}</div>
                    ) : (
                      <div className="text-[13px] leading-relaxed">{String(v)}</div>
                    )}
                  </div>
                );
              })}
          </div>
        </ScrollArea>
        {/* footer */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background/60 px-4.5 py-3.5">
          <Button variant="ghost" icon={I.ExternalLink} onClick={onOpenCollection}>
            <Trans>Open in {form.collection}</Trans>
          </Button>
          <div className="flex-1" />
          <button
            type="button"
            title={t`Delete submission`}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            className="grid size-8 place-items-center rounded-control border border-orange-300/40 bg-orange-300/5 text-orange-300 hover:bg-orange-300/10"
          >
            <I.Trash size={14} />
          </button>
        </div>
        <ConfirmDialog
          open={confirmDelete}
          title={t`Delete this submission?`}
          description={t`The row is removed from the collection. This can't be undone.`}
          actionLabel={t`Delete`}
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      </SheetContent>
    </Sheet>
  );
}

/* ── submissions tab ───────────────────────────────────────────────── */

/** A labelled bar. Width is the count against the biggest bucket, so the
 *  shape of the answers is readable even when every share is small; the number
 *  next to it is the share of people who answered, which is the figure being
 *  read out loud. */
function ResultBar({
  label,
  count,
  max,
  share,
}: {
  label: string;
  count: number;
  max: number;
  share: number | null;
}) {
  // A point nobody picked draws NO bar. The minimum width is there so a single
  // answer among hundreds is still visible, but applying it at zero would show
  // a sliver where the honest answer is nothing.
  const width = count > 0 && max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-[34%] max-w-[220px] shrink-0 truncate text-[12.5px]" title={label}>
        {label}
      </span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </span>
      <span className="w-[74px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
        {count}
        {share !== null && <span className="ml-1.5 opacity-70">{share}%</span>}
      </span>
    </div>
  );
}

/** Results, folded back into the questions they were asked as: a run of blocks
 *  sharing a matrix id is one grid, everything else is one card. */
const groupResultBlocks = (
  blocks: ApiFormResultBlock[],
): Array<
  | { kind: "one"; block: ApiFormResultBlock }
  | { kind: "matrix"; id: string; label: string; blocks: ApiFormResultBlock[] }
> => {
  const out: Array<
    | { kind: "one"; block: ApiFormResultBlock }
    | { kind: "matrix"; id: string; label: string; blocks: ApiFormResultBlock[] }
  > = [];
  for (const block of blocks) {
    const m = block.matrix;
    if (!m) {
      out.push({ kind: "one", block });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "matrix" && last.id === m.id) {
      last.blocks.push(block);
      continue;
    }
    out.push({ kind: "matrix", id: m.id, label: m.label, blocks: [block] });
  }
  return out;
};

/**
 * What the answers add up to.
 *
 * One card per question, drawn from `/results` — which counts and never
 * quotes. Free-text questions therefore show their answered count and send you
 * to the collection, where the words are read under the collection's own
 * permissions instead of a second time here.
 */
function ResultsTab({
  form,
  onOpenCollection,
}: {
  form: ApiForm;
  onOpenCollection: () => void;
}) {
  const { t } = useLingui();
  const [data, setData] = useState<ApiFormResults | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    formsApi
      .results(form.id)
      .then((r) => {
        if (!cancelled) setData(r.data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [form.id]);

  if (failed) {
    return (
      <EmptyState
        icon={I.Gauge}
        title={<Trans>Results can't be read</Trans>}
        description={
          <Trans>
            The collection this form writes into may have been deleted or renamed.
          </Trans>
        }
      />
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3 max-[860px]:grid-cols-1">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="gap-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-16" />
            </Card>
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <Card key={i} className="gap-3 p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-2/3" />
          </Card>
        ))}
      </div>
    );
  }

  if (data.rows === 0) {
    return (
      <EmptyState
        icon={I.Gauge}
        title={<Trans>No answers yet</Trans>}
        description={
          <Trans>Share the public link — every question gets a breakdown here as answers arrive.</Trans>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "grid gap-3 max-[860px]:grid-cols-1",
          data.inProgress > 0 ? "grid-cols-4" : "grid-cols-3",
        )}
      >
        {[
          { label: t`Rows`, value: String(data.rows), sub: data.collection },
          {
            label: t`Submissions`,
            value: String(data.submissionCount),
            sub: t`accepted through this form`,
          },
          // Only when there are any: a zero here on a form that saves progress
          // reads as a problem, and on one that doesn't it is noise.
          ...(data.inProgress > 0
            ? [
                {
                  label: t`In progress`,
                  value: String(data.inProgress),
                  sub: t`started, not submitted`,
                },
              ]
            : []),
          { label: t`Questions`, value: String(data.blocks.length), sub: t`summarised` },
        ].map((s, i) => (
          <Card key={i} className="gap-1 p-4">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              {s.label}
            </span>
            <span className="text-[22px] font-semibold tabular-nums">{s.value}</span>
            <span className="truncate text-[11px] text-muted-foreground">{s.sub}</span>
          </Card>
        ))}
      </div>

      {/* The counts are the collection's, not the form's — nothing stamps a row
          with the form that wrote it, so say so rather than implying otherwise. */}
      <p className="text-[11.5px] text-muted-foreground">
        <Trans>
          Counts cover every row in {data.collection}, including any written outside this form.
        </Trans>
      </p>

      {groupResultBlocks(data.blocks).map((g) =>
        g.kind === "matrix" ? (
          // A matrix was asked as one question, so its rows are read back
          // under it — the same grouping the form drew, not a scattering of
          // near-identical cards the operator has to reassemble by eye.
          <div key={g.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 px-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              <I.Grid3 size={11} />
              <span className="min-w-0 truncate">{g.label}</span>
            </div>
            <div className="flex flex-col gap-2 border-l border-border pl-3">
              {g.blocks.map((b) => resultCard(b))}
            </div>
          </div>
        ) : (
          resultCard(g.block)
        ),
      )}

      {data.truncated > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          <Trans>{data.truncated} more questions are not summarised — this form has more than the panel computes.</Trans>
        </p>
      )}
    </div>
  );

  function resultCard(b: ApiFormResultBlock) {
    const max = b.buckets?.reduce((m, k) => Math.max(m, k.count), 0) ?? 0;
    return (
          <Card key={b.name} className="gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[13.5px] font-semibold">{b.label}</span>
              <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                {b.nps && (
                  <Badge mono variant={b.nps.score >= 0 ? "default" : "destructive"}>
                    <Trans>NPS {b.nps.score}</Trans>
                  </Badge>
                )}
                {b.nps === null && b.average !== null && (
                  <Badge mono variant="secondary">
                    <Trans>avg {b.average}</Trans>
                  </Badge>
                )}
                <span>
                  {b.answered} <Trans>answered</Trans>
                </span>
              </span>
            </div>

            {b.buckets ? (
              <div className="flex flex-col gap-2">
                {b.buckets.map((k) => (
                  <ResultBar
                    key={k.value}
                    // `true`/`false` is how the column stores it, not how a
                    // person reads it — and the API stays language-neutral, so
                    // the wording belongs here.
                    label={
                      b.kind === "boolean" ? (k.value === "true" ? t`Yes` : t`No`) : k.label
                    }
                    count={k.count}
                    max={max}
                    share={b.answered > 0 ? Math.round((k.count / b.answered) * 100) : null}
                  />
                ))}
                {b.kind === "multi_choice" && (
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Several answers allowed, so the shares can add up to more than 100%.</Trans>
                  </span>
                )}
                {b.nps && (
                  // Label first, count second — "1 passives" would need a
                  // plural rule in every locale to say nothing extra.
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>
                      promoters {b.nps.promoters} · passives {b.nps.passives} · detractors{" "}
                      {b.nps.detractors}
                    </Trans>
                  </span>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onOpenCollection}
                className="flex items-center gap-2 self-start text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <I.ExternalLink size={13} />
                <Trans>Written answers are not shown here — read them in the collection</Trans>
              </button>
            )}
          </Card>
    );
  }
}

function SubmissionsTab({
  form,
  fieldBlocks,
  efByName,
  pushToast,
  onOpenCollection,
}: {
  form: ApiForm;
  fieldBlocks: ApiFormBlock[];
  efByName: Map<string, ApiFormEligibleField>;
  pushToast: PushToast;
  onOpenCollection: () => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selRow, setSelRow] = useState<Record<string, unknown> | null>(null);

  // Row lifecycle (draft/published) is the COLLECTION's concern, not the
  // form's — moderate it in the collection view. This tab only shows what
  // arrived. The form's own status (live/paused) lives on the list cards.
  const cols = fieldBlocks.slice(0, 4).map((b) => b.name!).filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const query: Record<string, string | number> = { limit: 50, sort: "-created_at", meta: "filter_count" };
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
  }, [form.collection]);

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
        <button
          type="button"
          onClick={() => window.open(`/api/items/${form.collection}/export?format=csv`, "_blank")}
          className="ml-auto flex items-center gap-2 rounded-[12px] border border-white/10 bg-white/[0.03] px-4 py-2 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/15 hover:text-foreground"
        >
          <I.Download size={14} />
          <Trans>Export CSV</Trans>
        </button>
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
            bare
            size="md"
            icon={I.Form}
            title={<Trans>No submissions yet</Trans>}
            description={<Trans>Share the public link — rows land here (and in the collection) as they arrive.</Trans>}
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[calc(100vh-24rem)]" className="w-full">
            <div className="min-w-[720px]">
              <div
                className="grid items-center gap-3 border-b border-border px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                style={{ gridTemplateColumns: `110px repeat(${cols.length}, 1fr)` }}
              >
                <span><Trans>When</Trans></span>
                {cols.map((c) => (
                  <span key={c} className="truncate">{c}</span>
                ))}
              </div>
              {rows.map((r, i) => (
                <div
                  key={String(r.id ?? i)}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelRow(r)}
                  onKeyDown={(e) => e.key === "Enter" && setSelRow(r)}
                  className="grid cursor-pointer items-center gap-3 border-b border-border px-3.5 py-[10px] text-[12.5px] transition-colors last:border-b-0 hover:bg-accent/40"
                  style={{ gridTemplateColumns: `110px repeat(${cols.length}, 1fr)` }}
                >
                  {/* serialized rows expose camelCase system keys (createdAt) */}
                  <span className="font-mono text-[11px] text-muted-foreground">{relTime(r.createdAt ?? r.created_at)}</span>
                  {cols.map((c) => (
                    <span key={c} className="truncate">{r[c] === null || r[c] === undefined ? "—" : String(r[c])}</span>
                  ))}
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

      <SubmissionDrawer
        form={form}
        fieldBlocks={fieldBlocks}
        efByName={efByName}
        row={selRow}
        onClose={() => setSelRow(null)}
        onDeleted={(id) => {
          setRows((prev) => (prev ? prev.filter((r) => String(r.id) !== id) : prev));
          setTotal((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
        }}
        onOpenCollection={onOpenCollection}
        pushToast={pushToast}
      />
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
