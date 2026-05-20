// Alternate item-list views — Kanban / Gallery / Calendar — plus the toggle
// that picks between them and the existing Table view. The Table option keeps
// behavior delegated to ItemsTable upstream; this module owns the three
// alternate visualisations.
//
// Visual parity targets the design's parity-v2.jsx::{KanbanBoard, GalleryGrid,
// CalendarView, ItemsViewToggle}. Calendar uses the current real month with
// arrow nav (the prototype hardcoded May 2026; that wouldn't age well).
import { useMemo, useState } from "react";
import { I, type IconComponent } from "./icons";
import { Badge, IconButton } from "./ui";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { authorById } from "./items";
import type { Post } from "./config";

export type ItemsViewMode = "table" | "kanban" | "gallery" | "calendar";

// Rows come from arbitrary user collections, not the design's `posts` mock —
// any field beyond `id` may be missing. These readers degrade instead of
// throwing (e.g. `r.word_count.toLocaleString()` on a column-less collection).
const rowLabel = (r: Post): string => r.title || r.slug || r.id;
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
  // Hide Kanban when there's no status-shaped column to group by; the design's
  // prototype always had `status` so it never had to guard for this.
  const opts = hasStatus ? ALL_OPTS : ALL_OPTS.filter((o) => o.id !== "kanban");
  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as ItemsViewMode)}>
      <TabsList>
        {opts.map((o) => (
          <TabsTrigger key={o.id} value={o.id} title={o.label}>
            <o.icon size={13} />
            <span>{o.label}</span>
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

export function KanbanBoard({ rows, onEdit }: { rows: Post[]; onEdit: (it: Post) => void }) {
  const byStatus = (s: string) => rows.filter((r) => r.status === s);
  return (
    <div className="kanban">
      {KANBAN_COLS.map((c) => {
        const items = byStatus(c.id);
        return (
          <div key={c.id} className="kb-col">
            <div className="kb-col-head">
              <span className="kb-col-title">{c.label}</span>
              <span className="font-mono tabular-nums kb-col-count">{items.length}</span>
              <div className="spacer" />
              <IconButton icon={I.Plus} title={`New ${c.label} post`} />
            </div>
            <div className="kb-list">
              {items.length === 0 ? (
                <div className="kb-empty">No items</div>
              ) : (
                items.map((r) => {
                  const author = authorById(r.author);
                  const words = rowNumber(r.word_count);
                  const views = rowNumber(r.view_count);
                  return (
                    <button key={r.id} type="button" className="kb-card" onClick={() => onEdit(r)}>
                      <div className="kb-card-title">{rowLabel(r)}</div>
                      {r.slug && (
                        <div className="kb-card-meta">
                          <span className="font-mono">{r.slug}</span>
                        </div>
                      )}
                      <div className="kb-card-foot">
                        <span className="avatar-xs">{author.initials}</span>
                        {words != null && (
                          <span
                            className="font-mono tabular-nums"
                            style={{ color: "var(--muted-foreground)", fontSize: 10.5 }}
                          >
                            {words.toLocaleString()} w
                          </span>
                        )}
                        <div className="spacer" />
                        {views != null && views > 0 && (
                          <span
                            className="font-mono tabular-nums"
                            style={{
                              color: "var(--muted-foreground)",
                              fontSize: 10.5,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <I.Eye size={10} /> {views.toLocaleString()}
                          </span>
                        )}
                      </div>
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

export function GalleryGrid({ rows, onEdit }: { rows: Post[]; onEdit: (it: Post) => void }) {
  return (
    <div className="gallery">
      {rows.map((r) => {
        const a = hashColor(r.id);
        const b = hashColor(r.id.split("").reverse().join(""));
        const words = rowNumber(r.word_count);
        return (
          <button key={r.id} type="button" className="gal-card" onClick={() => onEdit(r)}>
            <div className="gal-thumb" style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
              <span className="gal-thumb-label font-mono">{r.slug || r.id}</span>
            </div>
            <div className="gal-meta">
              <div className="gal-title">{rowLabel(r)}</div>
              <div className="gal-sub">
                {r.status && <Badge variant={statusBadgeVariant(r.status)}>{r.status}</Badge>}
                {words != null && (
                  <span
                    className="font-mono tabular-nums"
                    style={{ color: "var(--muted-foreground)", fontSize: 11 }}
                  >
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

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function CalendarView({ rows, onEdit }: { rows: Post[]; onEdit: (it: Post) => void }) {
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
      const iso = r.published_at || r.updated_at;
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
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav-btn" onClick={prev} aria-label="Previous month">
          <I.ChevronLeft size={14} />
        </button>
        <span style={{ fontWeight: 500 }}>
          {MONTH_NAMES[cursor.month]} {cursor.year}
        </span>
        <button type="button" className="cal-nav-btn" onClick={next} aria-label="Next month">
          <I.ChevronRight size={14} />
        </button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11.5 }}>
          scheduled by <span className="font-mono">published_at</span>
        </span>
      </div>
      <div className="cal-weekdays">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => (
          <div key={i} className={`cal-cell ${d == null ? "empty" : ""}`}>
            {d != null && (
              <>
                <div className="cal-day font-mono tabular-nums">{d}</div>
                <div className="cal-events">
                  {(byDay[d] || []).slice(0, 3).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`cal-evt cal-evt-${r.status || "draft"}`}
                      onClick={() => onEdit(r)}
                      title={rowLabel(r)}
                    >
                      <span className="cal-evt-dot" />
                      <span className="cal-evt-title">{rowLabel(r)}</span>
                    </button>
                  ))}
                  {(byDay[d] || []).length > 3 && (
                    <div className="cal-more font-mono">+{(byDay[d] || []).length - 3} more</div>
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
