// @ts-nocheck
// Cmd+K palette + Realtime event tail + Schema view + Empty states
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import { NAV_ITEMS, NAV_SETTINGS, type CollectionListItem, type CollectionSchema, type Post, type SchemaField } from "./config";
import { Badge, Button, IconButton, JsonBlock } from "./ui";

export type PaletteSelection =
  | { kind: "page"; id: string; label: string; icon: string; meta: string }
  | { kind: "collection"; id: string; label: string; icon: string; meta: string }
  | { kind: "item"; id: string; label: string; sub?: string; icon: string; meta: string }
  | { kind: "action"; id: string; label: string; icon: string; meta: string };

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (sel: PaletteSelection) => void;
  items: Post[];
  collections: CollectionListItem[];
}

export function Palette({ open, onClose, onNavigate, items, collections }: PaletteProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const groups = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const nav: PaletteSelection[] = NAV_ITEMS.concat(NAV_SETTINGS).map((n) => ({ kind: "page", id: n.id, label: n.label, icon: String(n.icon), meta: "goto" })).filter((x) => !ql || x.label.toLowerCase().includes(ql));
    const cols: PaletteSelection[] = collections.map((c) => ({ kind: "collection", id: c.slug, label: c.slug, icon: "Database", meta: `${c.count} items` })).filter((x) => !ql || x.label.toLowerCase().includes(ql));
    const its: PaletteSelection[] = ql
      ? items.filter((i) => i.title.toLowerCase().includes(ql) || i.slug.toLowerCase().includes(ql)).slice(0, 8).map((i) => ({ kind: "item", id: i.id, label: i.title, sub: i.slug, icon: "Inbox", meta: i.status }))
      : [];
    const actions: PaletteSelection[] = [
      { kind: "action", id: "new-post", label: "New post", icon: "Plus", meta: "C" },
      { kind: "action", id: "refresh", label: "Refresh", icon: "Refresh", meta: "R" },
      { kind: "action", id: "toggle-theme", label: "Toggle theme", icon: "Moon", meta: "D" },
    ].filter((x) => !ql || x.label.toLowerCase().includes(ql));
    return [
      { name: "Items", list: its },
      { name: "Collections", list: cols },
      { name: "Pages", list: nav },
      { name: "Actions", list: actions },
    ].filter((g) => g.list.length);
  }, [q, items, collections]);

  const flat = useMemo(() => groups.flatMap((g) => g.list), [groups]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const sel = flat[active]; if (sel) onNavigate(sel); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flat, active, onNavigate, onClose]);

  if (!open) return null;
  let runningIdx = 0;
  const kbd = "rounded-sm border border-border bg-muted px-[5px] py-px";
  return (
    <>
      <div className="fixed inset-0 z-[60] animate-in bg-[oklch(0_0_0/0.32)] fade-in-0 duration-150 dark:bg-[oklch(0_0_0/0.6)]" onClick={onClose} />
      <div className="fixed left-1/2 top-[18%] z-[70] flex max-h-[60vh] w-[min(640px,92vw)] -translate-x-1/2 animate-in flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-[0_20px_70px_-10px_oklch(0_0_0/0.4),0_4px_14px_oklch(0_0_0/0.1)] fade-in-0 zoom-in-95 duration-150" role="dialog" aria-modal="true">
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-3.5">
          <I.Search size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            placeholder="Type a command, collection, or item title…"
            className="flex-1 border-0 bg-transparent text-[14.5px] text-foreground outline-none"
          />
          <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">esc</span>
        </div>
        <div className="flex-1 overflow-auto p-1.5">
          {flat.length === 0 ? (
            <div className="p-7 text-center text-[13px] text-muted-foreground">
              No matches. Try <span className="font-mono">posts</span> or <span className="font-mono">edge</span>.
            </div>
          ) : (
            groups.map((g) => (
              <Fragment key={g.name}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{g.name}</div>
                {g.list.map((it) => {
                  const idx = runningIdx++;
                  const IconComp = (I as Record<string, IconComponent>)[it.icon as IconKey];
                  return (
                    <div
                      key={`${g.name}-${it.id}`}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[13.5px] ${idx === active ? "bg-accent" : ""}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => onNavigate(it)}
                    >
                      {IconComp && <IconComp size={14} />}
                      <span className="flex flex-col">
                        <span>{it.label}</span>
                        {"sub" in it && it.sub && <span className="font-mono text-[11px] text-muted-foreground">/{it.sub}</span>}
                      </span>
                      <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">{it.meta}</span>
                    </div>
                  );
                })}
              </Fragment>
            ))
          )}
        </div>
        <div className="flex items-center gap-3.5 border-t border-border px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
          <span><span className={kbd}>↵</span> open</span>
          <span><span className={kbd}>↑↓</span> navigate</span>
          <span><span className={kbd}>esc</span> close</span>
        </div>
      </div>
    </>
  );
}

export interface RealtimeEvent {
  id: string;
  event: "created" | "updated" | "deleted";
  title?: string;
  itemId?: string;
  field?: string;
  who?: string;
  t: string;
  /** Full payload data so the detail modal can render every field. */
  raw?: Record<string, unknown>;
  /** Receive timestamp (ms since epoch) — formatted in the detail modal. */
  receivedAt?: number;
}

const formatFullTs = (ms: number | undefined): string => {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// Per-event color for the `.ev` label — mirrors the legacy
// .tail-event[data-event="…"] .ev rules.
const EV_BASE = "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em]";
const EV_COLOR: Record<string, string> = {
  created: "text-[oklch(from_var(--primary)_0.5_0.16_h)]",
  updated: "text-[oklch(0.55_0.13_240)]",
  deleted: "text-destructive",
};

function RealtimeEventDialog({ ev, channel, onClose }: { ev: RealtimeEvent; channel: string; onClose: () => void }) {
  // Close on ESC for keyboard parity with the other admin dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[70] grid animate-in place-items-center bg-[oklch(0_0_0/0.45)] backdrop-blur-[2px] fade-in-0 duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[min(86vh,720px)] w-[min(720px,92vw)] animate-in flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-[0_24px_60px_oklch(0_0_0/0.22),0_2px_8px_oklch(0_0_0/0.08)] fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${ev.event} event detail`}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pt-[18px]">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className={`${EV_BASE} ${EV_COLOR[ev.event]}`}>{ev.event}</span>
              <span className="font-mono text-xs text-muted-foreground">{channel}</span>
            </div>
            <h3 className="m-0 text-sm font-medium">
              {ev.title || ev.itemId || "(item)"}
            </h3>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          <div className="grid grid-cols-[120px_1fr] gap-x-3.5 gap-y-2 text-[12.5px]">
            <span className="text-muted-foreground">Channel</span>
            <span className="font-mono">{channel}</span>
            <span className="text-muted-foreground">Event</span>
            <span className="font-mono">{ev.event}</span>
            <span className="text-muted-foreground">Received</span>
            <span className="font-mono">{formatFullTs(ev.receivedAt)}</span>
            {ev.itemId && (
              <>
                <span className="text-muted-foreground">Item ID</span>
                <span className="font-mono [word-break:break-all]">{ev.itemId}</span>
              </>
            )}
            {ev.who && ev.who !== "system" && (
              <>
                <span className="text-muted-foreground">By</span>
                <span className="font-mono [word-break:break-all]">{ev.who}</span>
              </>
            )}
            {ev.field && (
              <>
                <span className="text-muted-foreground">Changed field</span>
                <span className="font-mono">{ev.field}</span>
              </>
            )}
          </div>
          <JsonBlock label="Payload" value={ev.raw ?? {}} />
        </div>
        <div className="flex items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

export function RealtimeTail({ events, channel, connected }: { events: RealtimeEvent[]; channel: string; connected?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const openEvent = useMemo(
    () => events.find((e) => e.id === openId) ?? null,
    [events, openId],
  );
  return (
    <div className="sticky top-4 flex max-h-[calc(100vh-140px)] flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
        <I.Zap size={14} />
        <h3 className="m-0 text-[13px] font-semibold">Live tail</h3>
        <span className="ml-auto flex items-center font-mono text-[11px] text-muted-foreground">
          <span className={`mr-1.5 size-[7px] shrink-0 rounded-full ${connected ? "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" : "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_25%,transparent)]"}`} />
          {channel}
        </span>
      </div>
      {events.length === 0 ? (
        <div className="p-7 text-center text-[12.5px] text-muted-foreground">
          Subscribed. Waiting for events…
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-auto">
          {events.slice(0, 30).map((ev) => (
            <div
              key={ev.id}
              className="flex animate-in cursor-pointer flex-col gap-1 border-b border-border px-3.5 py-2.5 text-xs fade-in-0 slide-in-from-top-1 duration-200 last:border-b-0"
              onClick={() => setOpenId(ev.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenId(ev.id);
                }
              }}
              title="Click for full payload"
            >
              <div className="flex items-center gap-1.5">
                <span className={`${EV_BASE} ${EV_COLOR[ev.event]}`}>{ev.event}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{ev.t}</span>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[11.5px] leading-[1.35] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{ev.title || ev.itemId}</span>
                  {ev.event === "updated" && ev.field && <> · changed <span className="text-foreground">{ev.field}</span></>}
                  {ev.who && <> · by <span className="text-foreground">{ev.who}</span></>}
                </span>
                <I.ChevronRight size={12} />
              </div>
            </div>
          ))}
        </div>
      )}
      {openEvent && (
        <RealtimeEventDialog ev={openEvent} channel={channel} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

export function SchemaView({
  schema,
  onAddField,
  onDropField,
  onEditField,
  onReorderFields,
}: {
  schema: CollectionSchema;
  onAddField: () => void;
  onDropField: (name: string) => void;
  onEditField?: (name: string) => void;
  onReorderFields?: (fromIndex: number, toIndex: number) => void;
}) {
  // schema.fields contains ONLY user-defined columns (the API's source of
  // truth). The schema page also wants to surface the implicit system
  // columns (id / created_at / updated_at / owner_id) so users can see
  // they exist — synthesize them here for display only. They're never
  // sent back to the server (PATCH would 422 on reserved names).
  const userFields = schema.fields;
  const has = (n: string) => userFields.some((f) => f.name === n);
  const systemRows = [
    !has("id") && { name: "id", type: "uuid", system: true, nullable: false, default: "gen_uuid()" },
    !has("created_at") && { name: "created_at", type: "timestamp", system: true, nullable: false, default: "now()" },
    !has("updated_at") && { name: "updated_at", type: "timestamp", system: true, nullable: false, default: "now()" },
    schema.ownerScoped && !has("owner_id") && { name: "owner_id", type: "uuid", system: true, nullable: false, default: "$user.id" },
  ].filter(Boolean) as typeof userFields;
  const allFields = [...userFields, ...systemRows];

  // Drag state — tracks the source index in the user-fields array (system
  // rows can't be dragged or be drop targets, so indices stay aligned).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.Braces size={14} />
        <span className="text-[13px] font-medium">fields</span>
        <span className="font-mono text-xs text-muted-foreground">{allFields.length} total · {userFields.length} editable · drag the grip to reorder</span>
        <div className="flex-1" />
        <Button variant="primary" size="sm" icon={I.Plus} onClick={onAddField}>Add field</Button>
      </div>
      <div className="w-full max-w-full overflow-x-auto">
        {allFields.map((f, idx) => {
          // System rows always render after user-defined fields and are
          // never reorderable; dnd handlers only fire for user rows.
          const userIdx = idx < userFields.length ? idx : -1;
          const isUser = !f.system && userIdx >= 0;
          const isDragging = dragIndex === userIdx;
          const isOver = overIndex === userIdx && dragIndex !== null && dragIndex !== userIdx;
          return (
            <div
              key={f.name}
              className="grid grid-cols-[24px_1fr_130px_130px_32px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0"
              draggable={isUser}
              style={{
                opacity: isDragging ? 0.4 : 1,
                borderTop: isOver && (dragIndex ?? 0) > userIdx ? "2px solid var(--primary)" : undefined,
                borderBottom: isOver && (dragIndex ?? 0) < userIdx ? "2px solid var(--primary)" : undefined,
                transition: "opacity 80ms",
              }}
              onDragStart={isUser ? (e) => {
                setDragIndex(userIdx);
                e.dataTransfer.effectAllowed = "move";
                // Required for Firefox to actually start the drag.
                e.dataTransfer.setData("text/plain", f.name);
              } : undefined}
              onDragOver={isUser ? (e) => {
                if (dragIndex === null || dragIndex === userIdx) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overIndex !== userIdx) setOverIndex(userIdx);
              } : undefined}
              onDragLeave={isUser ? () => {
                if (overIndex === userIdx) setOverIndex(null);
              } : undefined}
              onDrop={isUser ? (e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== userIdx) {
                  onReorderFields?.(dragIndex, userIdx);
                }
                setDragIndex(null);
                setOverIndex(null);
              } : undefined}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
            >
              <span className="text-muted-foreground" style={{ cursor: isUser ? "grab" : "default", opacity: isUser ? 1 : 0.3 }}>
                <I.Grip size={14} />
              </span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-[12.5px]">{f.name}</span>
                {f.system && <Badge variant="secondary">system</Badge>}
                {f.unique && <Badge variant="outline">unique</Badge>}
                {!f.nullable && !f.system && <Badge variant="outline">required</Badge>}
              </div>
              <Badge variant="outline" mono>{f.type}</Badge>
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {f.default ?? <span className="opacity-50">—</span>}
              </span>
              <span className="flex justify-end gap-1">
                {!f.system && onEditField && (
                  <IconButton icon={I.Pencil} onClick={() => onEditField(f.name)} title="Edit field" />
                )}
                {!f.system && (
                  <IconButton icon={I.Trash} onClick={() => onDropField(f.name)} title="Drop column" />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AlterPreview({ pendingField }: { pendingField?: Partial<SchemaField> | null }) {
  if (!pendingField) return null;
  const sqlType =
    pendingField.type === "integer" ? "INTEGER" :
    pendingField.type === "longtext" ? "TEXT" :
    pendingField.type === "boolean" ? "INTEGER" :
    pendingField.type === "json" ? "TEXT" :
    pendingField.type === "timestamp" ? "INTEGER" : "TEXT";
  const kw = "text-[oklch(0.78_0.18_95)]";
  const ident = "text-[oklch(0.85_0.13_200)]";
  const comment = "italic text-[oklch(from_var(--primary)_0.6_0.02_h)]";
  return (
    <div className="whitespace-pre-wrap rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-xs leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)] [word-break:break-word]">
      <span className={comment}>-- runtime DDL preview · sqlite dialect</span>{"\n"}
      <span className={kw}>ALTER TABLE</span> <span className={ident}>"c_posts"</span>{"\n"}
      {"  "}<span className={kw}>ADD COLUMN</span> <span className={ident}>"{pendingField.name || "new_field"}"</span> {sqlType}
      {!pendingField.nullable ? <> <span className={kw}>NOT NULL</span></> : null}
      {pendingField.default ? <> <span className={kw}>DEFAULT</span> <span className="text-[oklch(from_var(--primary)_0.85_0.13_h)]">{pendingField.default}</span></> : null};{"\n"}
      <span className={comment}>-- additive only — no data is rewritten.</span>
    </div>
  );
}

export function EmptyItems({ onCreate, slug }: { onCreate: () => void; slug?: string }) {
  const tableName = slug ? `c_${slug}` : "this collection";
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.Inbox size={20} /></div>
      <h4 className="m-0 text-[15px] font-semibold">No items yet</h4>
      <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">Create the first row in <span className="font-mono">{tableName}</span> via the API or use the New row button.</p>
      <Button variant="primary" size="sm" icon={I.Plus} onClick={onCreate}>New row</Button>
    </div>
  );
}
