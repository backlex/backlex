// Alternate item-list views — Kanban / Gallery / Calendar — plus the toggle
// that picks between them and the existing Table view. The Table option keeps
// behavior delegated to ItemsTable upstream; this module owns the three
// alternate visualisations.
//
// Visual parity targets the design's parity-v2.jsx::{KanbanBoard, GalleryGrid,
// CalendarView, ItemsViewToggle}. Calendar uses the current real month with
// arrow nav (the prototype hardcoded May 2026; that wouldn't age well).
import { useMemo, useState, type CSSProperties } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "./icons";
import { Badge, Button, IconButton } from "./ui";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { authorById } from "./items";
import { rowLabel as sharedRowLabel, shortId, type LabelSchemaField } from "./row-label";
import type { Post } from "./config";

export type ItemsViewMode = "table" | "kanban" | "gallery" | "calendar";

// Rows come from arbitrary user collections, not the design's `posts` mock —
// any field beyond `id` may be missing. These readers degrade instead of
// throwing (e.g. `r.word_count.toLocaleString()` on a column-less collection).
// Row display label — the shared chain (display template → title-ish scan →
// first two filled text fields → shortened id) so Kanban/Gallery/Calendar
// never surface a full UUID. `fields` powers the composed-text fallback for
// collections like `addresses` with no title-ish field at all.
const rowLabel = (r: Post, displayTemplate?: string | null, fields?: LabelSchemaField[]): string =>
  sharedRowLabel(r as unknown as Record<string, unknown>, { displayTemplate, fields });
const rowNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface ToggleOption {
  id: ItemsViewMode;
  label: string;
  icon: IconComponent;
}

const ALL_OPTS: ToggleOption[] = [
  { id: "table", label: "Table", icon: I.LayoutList },
  { id: "kanban", label: "Kanban", icon: I.LayoutKanban },
  { id: "gallery", label: "Gallery", icon: I.LayoutGrid },
  { id: "calendar", label: "Calendar", icon: I.CalendarDays },
];

export function ItemsViewToggle({
  mode,
  setMode,
  hasStatus,
}: {
  mode: ItemsViewMode;
  setMode: (next: ItemsViewMode) => void;
  hasStatus: boolean;
}) {
  const { t } = useLingui();
  const LABELS: Record<ItemsViewMode, string> = {
    table: t`Table`,
    kanban: t`Kanban`,
    gallery: t`Gallery`,
    calendar: t`Calendar`,
  };
  // Hide Kanban when there's no status-shaped column to group by; the design's
  // prototype always had `status` so it never had to guard for this.
  const opts = hasStatus ? ALL_OPTS : ALL_OPTS.filter((o) => o.id !== "kanban");
  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as ItemsViewMode)}>
      <TabsList className="gap-[2px] rounded-[9px] border border-white/[0.07] bg-white/[0.04] p-[2px]">
        {opts.map((o) => (
          <TabsTrigger
            key={o.id}
            value={o.id}
            title={LABELS[o.id]}
            className="rounded-[7px] px-[9px] py-[5px] text-[11.5px] font-semibold text-[#8580A2] data-active:bg-[rgba(139,108,255,0.16)] data-active:text-[#E7E4F4] dark:data-active:bg-[rgba(139,108,255,0.16)] dark:data-active:text-[#E7E4F4]"
          >
            <o.icon size={13} />
            <span>{LABELS[o.id]}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

// ─────────────────────────────────────────────────────────────────
// Kanban
// ─────────────────────────────────────────────────────────────────

const KANBAN_COLS: { id: string; label: string }[] = [
  { id: "draft", label: "Draft" },
  { id: "review", label: "In review" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived" },
];

export function KanbanBoard({
  rows,
  onEdit,
  displayTemplate,
  fields,
  statusField,
  onChangeStatus,
  onCreate,
}: {
  rows: Post[];
  onEdit: (it: Post) => void;
  displayTemplate?: string | null;
  fields?: LabelSchemaField[];
  // The collection's resolved status field. When present, columns come from its
  // choices (so any status set lights up); otherwise the default lifecycle cols.
  statusField?: { name: string; choices: { value: string; label?: string }[] } | null;
  // Drag-and-drop a card to another column → set the row's status. Optimistic
  // update happens in the parent; this just reports the move.
  onChangeStatus?: (it: Post, status: string) => void;
  // The per-column "+" button → create a new item pre-set to that status.
  onCreate?: (status: string) => void;
}) {
  const { t } = useLingui();
  const KANBAN_LABELS: Record<string, string> = {
    draft: t`Draft`,
    review: t`In review`,
    published: t`Published`,
    archived: t`Archived`,
  };
  const statusName = statusField?.name ?? "status";
  const cols = statusField?.choices?.length
    ? statusField.choices.map((c) => ({ id: c.value, label: c.label ?? KANBAN_LABELS[c.value] ?? c.value }))
    : KANBAN_COLS.map((c) => ({ id: c.id, label: KANBAN_LABELS[c.id] ?? c.label }));
  const statusOf = (r: Post) => (r as unknown as Record<string, unknown>)[statusName];
  const byStatus = (s: string) => rows.filter((r) => statusOf(r) === s);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  const drop = (colId: string) => {
    const it = rows.find((x) => x.id === dragId);
    setOverCol(null);
    setDragId(null);
    if (it && statusOf(it) !== colId) onChangeStatus?.(it, colId);
  };

  return (
    <div className="grid grid-cols-[repeat(var(--kanban-cols),minmax(220px,1fr))] gap-3.5 p-3.5 max-[900px]:grid-cols-2 max-[600px]:grid-cols-1" style={{ "--kanban-cols": cols.length } as CSSProperties}>
      {cols.map((c) => {
        const items = byStatus(c.id);
        return (
          <div
            key={c.id}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverCol(c.id); } }}
            onDragLeave={() => setOverCol((o) => (o === c.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); drop(c.id); }}
            className={`flex min-h-[240px] flex-col rounded-xl border bg-[color-mix(in_oklch,var(--muted)_40%,var(--card))] transition-colors ${overCol === c.id && dragId ? "border-primary ring-2 ring-primary/40" : "border-border"}`}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="text-[12.5px] font-medium capitalize">{c.label}</span>
              <span className="rounded-md border border-border bg-card px-1.5 py-px font-mono text-[10.5px] tabular-nums text-muted-foreground">{items.length}</span>
              <div className="flex-1" />
              <IconButton icon={I.Plus} title={t`New ${c.label} item`} onClick={() => onCreate?.(c.id)} />
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2.5">
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-[22px] text-center text-[11.5px] text-muted-foreground"><Trans>No items</Trans></div>
              ) : (
                items.map((r) => {
                  const author = r.author ? authorById(r.author) : null;
                  const words = rowNumber(r.word_count);
                  const views = rowNumber(r.view_count);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      draggable
                      onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = "move"; }}
                      onDragEnd={() => { setDragId(null); setOverCol(null); }}
                      className={`flex cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-opacity hover:border-chip-border active:cursor-grabbing ${dragId === r.id ? "opacity-40" : ""}`}
                      onClick={() => onEdit(r)}
                    >
                      <div className="text-[12.5px] font-medium leading-[1.3]">{rowLabel(r, displayTemplate, fields)}</div>
                      {r.slug && (
                        <div className="text-[11px] text-muted-foreground">
                          <span className="font-mono">{r.slug}</span>
                        </div>
                      )}
                      {(author || words != null || (views != null && views > 0)) && (
                        <div className="mt-0.5 flex items-center gap-1.5">
                          {author && (
                            <span className="grid size-[18px] place-items-center rounded-full bg-muted font-mono text-[9.5px] text-muted-foreground" title={author.name}>{author.initials}</span>
                          )}
                          {words != null && (
                            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                              {words.toLocaleString()} w
                            </span>
                          )}
                          <div className="flex-1" />
                          {views != null && views > 0 && (
                            <span className="inline-flex items-center gap-1 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                              <I.Eye size={10} /> {views.toLocaleString()}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Gallery
// ─────────────────────────────────────────────────────────────────

// Deterministic OKLCH from id — no Math.random so re-renders stay stable.
function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffff;
  const hue = h % 360;
  return `oklch(0.82 0.12 ${hue})`;
}

const statusBadgeVariant = (s: Post["status"]): "default" | "secondary" | "outline" => {
  if (s === "published") return "default";
  if (s === "archived") return "secondary";
  return "outline";
};

export function GalleryGrid({ rows, onEdit, displayTemplate, fields }: { rows: Post[]; onEdit: (it: Post) => void; displayTemplate?: string | null; fields?: LabelSchemaField[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5 p-3.5">
      {rows.map((r) => {
        const a = hashColor(r.id);
        const b = hashColor(r.id.split("").reverse().join(""));
        const words = rowNumber(r.word_count);
        return (
          <button key={r.id} type="button" className="cursor-pointer overflow-hidden rounded-xl border border-border bg-card text-left text-foreground hover:border-chip-border" onClick={() => onEdit(r)}>
            <div className="relative grid aspect-[16/10] p-2.5 [place-items:end_start]" style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
              <span className="rounded-md bg-[color-mix(in_oklch,var(--background)_65%,transparent)] px-2 py-0.5 font-mono text-[10.5px] text-foreground backdrop-blur-[4px]">{r.slug || shortId(r.id)}</span>
            </div>
            <div className="flex flex-col gap-1.5 px-3 pb-3 pt-2.5">
              <div className="text-[12.5px] font-medium leading-[1.3]">{rowLabel(r, displayTemplate, fields)}</div>
              <div className="flex items-center gap-2">
                {r.status && <Badge variant={statusBadgeVariant(r.status)}>{r.status}</Badge>}
                {words != null && (
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {words.toLocaleString()} w
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Calendar
// ─────────────────────────────────────────────────────────────────

export function CalendarView({ rows, onEdit, displayTemplate, fields }: { rows: Post[]; onEdit: (it: Post) => void; displayTemplate?: string | null; fields?: LabelSchemaField[] }) {
  const { t } = useLingui();
  const MONTH_LABELS = [
    t`January`, t`February`, t`March`, t`April`, t`May`, t`June`,
    t`July`, t`August`, t`September`, t`October`, t`November`, t`December`,
  ];
  const WEEKDAY_LABELS = [t`Mon`, t`Tue`, t`Wed`, t`Thu`, t`Fri`, t`Sat`, t`Sun`];
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState<{ year: number; month: number }>({
    year: today.getUTCFullYear(),
    month: today.getUTCMonth(),
  });

  const { cells, byDay } = useMemo(() => {
    const { year, month } = cursor;
    const first = new Date(Date.UTC(year, month, 1));
    // Monday-first weekday: getUTCDay returns 0=Sun..6=Sat. Shift so Monday=0.
    const startWeekday = (first.getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    const cells: Array<number | null> = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    const byDay: Record<number, Post[]> = {};
    for (const r of rows) {
      // The items API serializes timestamps camelCase (publishedAt/updatedAt);
      // accept snake_case too. Falling back to updatedAt means freshly-created
      // drafts (no publish date yet) still surface on the calendar.
      const rec = r as unknown as Record<string, unknown>;
      const iso = (rec.published_at ?? rec.publishedAt ?? rec.updated_at ?? rec.updatedAt) as
        | string
        | number
        | undefined;
      if (!iso) continue;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month) continue;
      const day = d.getUTCDate();
      (byDay[day] ||= []).push(r);
    }
    return { cells, byDay };
  }, [cursor, rows]);

  const prev = () =>
    setCursor((c) => {
      const next = c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 };
      return next;
    });
  const next = () =>
    setCursor((c) => {
      const nxt = c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 };
      return nxt;
    });

  return (
    <div className="p-3.5">
      <div className="flex items-center gap-2 px-1 pb-3">
        <Button variant="outline" size="xs" icon={I.ChevronLeft} onClick={prev} aria-label={t`Previous month`} />
        <span className="font-medium">
          {MONTH_LABELS[cursor.month]} {cursor.year}
        </span>
        <Button variant="outline" size="xs" icon={I.ChevronRight} onClick={next} aria-label={t`Next month`} />
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>scheduled by <span className="font-mono">published_at</span></Trans>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1.5 text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground">
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((d, i) => (
          <div
            key={i}
            className={
              d == null
                ? "flex min-h-[92px] flex-col gap-1 rounded-md border border-transparent bg-transparent p-1.5"
                : "flex min-h-[92px] flex-col gap-1 rounded-md border border-border bg-card p-1.5"
            }
          >
            {d != null && (
              <>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">{d}</div>
                <div className="flex min-h-0 flex-col gap-[3px]">
                  {(byDay[d] || []).slice(0, 3).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="flex cursor-pointer items-center gap-[5px] overflow-hidden rounded-sm border-0 bg-muted px-1.5 py-[3px] text-left text-[10.5px] text-foreground hover:bg-accent"
                      onClick={() => onEdit(r)}
                      title={rowLabel(r, displayTemplate, fields)}
                    >
                      <span
                        className={`size-[5px] shrink-0 rounded-full ${
                          r.status === "published"
                            ? "bg-primary"
                            : r.status === "review"
                              ? "bg-[oklch(0.7_0.18_70)]"
                              : "bg-muted-foreground"
                        }`}
                      />
                      <span className="truncate">{rowLabel(r, displayTemplate, fields)}</span>
                    </button>
                  ))}
                  {(byDay[d] || []).length > 3 && (
                    <div className="pl-1.5 font-mono text-[10px] text-muted-foreground">+{(byDay[d] || []).length - 3} more</div>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
