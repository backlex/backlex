// @ts-nocheck
// Cmd+K palette + Realtime event tail + Schema view + Empty states
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent, type IconKey } from "./icons";
import { NAV_ITEMS, NAV_SETTINGS, type CollectionListItem, type CollectionSchema, type Post, type SchemaField } from "./config";
import { Badge, Button, EmptyState, IconButton, JsonBlock, navLabel } from "./ui";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";

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
  const { t, i18n } = useLingui();
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
    const nav: PaletteSelection[] = NAV_ITEMS.concat(NAV_SETTINGS).map((n) => ({ kind: "page", id: n.id, label: i18n._(navLabel(n.id)), icon: String(n.icon), meta: t`goto` })).filter((x) => !ql || x.label.toLowerCase().includes(ql));
    const cols: PaletteSelection[] = collections.map((c) => ({ kind: "collection", id: c.slug, label: c.slug, icon: "Database", meta: t`${c.count} items` })).filter((x) => !ql || x.label.toLowerCase().includes(ql));
    const its: PaletteSelection[] = ql
      ? items.filter((i) => i.title.toLowerCase().includes(ql) || i.slug.toLowerCase().includes(ql)).slice(0, 8).map((i) => ({ kind: "item", id: i.id, label: i.title, sub: i.slug, icon: "Inbox", meta: i.status }))
      : [];
    const actions: PaletteSelection[] = [
      { kind: "action", id: "new-post", label: t`New post`, icon: "Plus", meta: "C" },
      { kind: "action", id: "refresh", label: t`Refresh`, icon: "Refresh", meta: "R" },
      { kind: "action", id: "toggle-theme", label: t`Toggle theme`, icon: "Moon", meta: "D" },
    ].filter((x) => !ql || x.label.toLowerCase().includes(ql));
    return [
      { name: t`Items`, list: its },
      { name: t`Collections`, list: cols },
      { name: t`Pages`, list: nav },
      { name: t`Actions`, list: actions },
    ].filter((g) => g.list.length);
  }, [q, items, collections, i18n, t]);

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] flex max-h-[60vh] w-[min(640px,92vw)] translate-y-0 flex-col gap-0 overflow-hidden bg-popover p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only"><Trans>Command palette</Trans></DialogTitle>
        <DialogDescription className="sr-only"><Trans>Type a command, collection, or item title to navigate.</Trans></DialogDescription>
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[18px] py-3.5">
          <I.Search size={15} />
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            placeholder={t`Type a command, collection, or item title…`}
            className="h-auto flex-1 border-0 bg-transparent p-0 text-[14.5px] text-foreground shadow-none focus-visible:ring-0"
          />
          <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">esc</span>
        </div>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-[calc(60vh-100px)]">
          <div className="p-1.5">
          {flat.length === 0 ? (
            <div className="p-7 text-center text-[13px] text-muted-foreground">
              <Trans>No matches. Try <span className="font-mono">posts</span> or <span className="font-mono">edge</span>.</Trans>
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
        </ScrollArea>
        <div className="flex shrink-0 items-center gap-3.5 border-t border-border px-5 py-3.5 font-mono text-[11px] text-muted-foreground">
          <span><span className={kbd}>↵</span> <Trans>open</Trans></span>
          <span><span className={kbd}>↑↓</span> <Trans>navigate</Trans></span>
          <span><span className={kbd}>esc</span> <Trans>close</Trans></span>
        </div>
      </DialogContent>
    </Dialog>
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
  const { t } = useLingui();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-[min(720px,92vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="mb-1 flex items-center gap-2">
            <span className={`${EV_BASE} ${EV_COLOR[ev.event]}`}>{ev.event}</span>
            <span className="font-mono text-xs text-muted-foreground">{channel}</span>
          </div>
          <DialogTitle className="text-sm font-medium">
            {ev.title || ev.itemId || t`(item)`}
          </DialogTitle>
          <DialogDescription className="sr-only">{t`${ev.event} event detail`}</DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)]">
          <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="grid grid-cols-[120px_1fr] gap-x-3.5 gap-y-2 text-[12.5px]">
            <span className="text-muted-foreground"><Trans>Channel</Trans></span>
            <span className="font-mono">{channel}</span>
            <span className="text-muted-foreground"><Trans>Event</Trans></span>
            <span className="font-mono">{ev.event}</span>
            <span className="text-muted-foreground"><Trans>Received</Trans></span>
            <span className="font-mono">{formatFullTs(ev.receivedAt)}</span>
            {ev.itemId && (
              <>
                <span className="text-muted-foreground"><Trans>Item ID</Trans></span>
                <span className="font-mono [word-break:break-all]">{ev.itemId}</span>
              </>
            )}
            {ev.who && ev.who !== "system" && (
              <>
                <span className="text-muted-foreground"><Trans>By</Trans></span>
                <span className="font-mono [word-break:break-all]">{ev.who}</span>
              </>
            )}
            {ev.field && (
              <>
                <span className="text-muted-foreground"><Trans>Changed field</Trans></span>
                <span className="font-mono">{ev.field}</span>
              </>
            )}
          </div>
          <JsonBlock label={t`Payload`} value={ev.raw ?? {}} />
          </div>
        </ScrollArea>
        <DialogFooter className="flex items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Close</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RealtimeTail({ events, channel, connected }: { events: RealtimeEvent[]; channel: string; connected?: boolean }) {
  const { t } = useLingui();
  const [openId, setOpenId] = useState<string | null>(null);
  const openEvent = useMemo(
    () => events.find((e) => e.id === openId) ?? null,
    [events, openId],
  );
  return (
    <Card className="sticky top-4 max-h-[calc(100vh-140px)] py-0 gap-0">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
        <I.Zap size={14} />
        <h3 className="m-0 text-[13px] font-semibold"><Trans>Live tail</Trans></h3>
        <span className="ml-auto flex items-center font-mono text-[11px] text-muted-foreground">
          <span className={`mr-1.5 size-[7px] shrink-0 rounded-full ${connected ? "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" : "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_25%,transparent)]"}`} />
          {channel}
        </span>
      </div>
      {events.length === 0 ? (
        <div className="p-7 text-center text-[12.5px] text-muted-foreground">
          <Trans>Subscribed. Waiting for events…</Trans>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
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
              title={t`Click for full payload`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`${EV_BASE} ${EV_COLOR[ev.event]}`}>{ev.event}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{ev.t}</span>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[11.5px] leading-[1.35] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{ev.title || ev.itemId}</span>
                  {ev.event === "updated" && ev.field && <> · <Trans>changed</Trans> <span className="text-foreground">{ev.field}</span></>}
                  {ev.who && <> · <Trans>by</Trans> <span className="text-foreground">{ev.who}</span></>}
                </span>
                <I.ChevronRight size={12} />
              </div>
            </div>
          ))}
          </div>
        </ScrollArea>
      )}
      {openEvent && (
        <RealtimeEventDialog ev={openEvent} channel={channel} onClose={() => setOpenId(null)} />
      )}
    </Card>
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
  const { t } = useLingui();
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
    <Card className="py-0 gap-0">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.Braces size={14} />
        <span className="text-[13px] font-medium"><Trans>fields</Trans></span>
        <span className="font-mono text-xs text-muted-foreground"><Trans>{allFields.length} total · {userFields.length} editable · drag the grip to reorder</Trans></span>
        <div className="flex-1" />
        <Button variant="primary" size="sm" icon={I.Plus} onClick={onAddField}><Trans>Add field</Trans></Button>
      </div>
      <ScrollArea className="w-full max-w-full">
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
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_1fr_130px_130px_32px] md:gap-3 md:py-[11px]"
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
              <span className="shrink-0 text-muted-foreground" style={{ cursor: isUser ? "grab" : "default", opacity: isUser ? 1 : 0.3 }}>
                <I.Grip size={14} />
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="break-all font-mono text-[12.5px] md:break-normal">{f.name}</span>
                {f.system && <Badge variant="secondary"><Trans>system</Trans></Badge>}
                {f.unique && <Badge variant="outline"><Trans>unique</Trans></Badge>}
                {!f.nullable && !f.system && <Badge variant="outline"><Trans>required</Trans></Badge>}
              </div>
              <Badge variant="outline" mono>{f.type}</Badge>
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {f.default ?? <span className="opacity-50">—</span>}
              </span>
              <span className="ml-auto flex justify-end gap-1 md:ml-0">
                {!f.system && onEditField && (
                  <IconButton icon={I.Pencil} onClick={() => onEditField(f.name)} title={t`Edit field`} />
                )}
                {!f.system && (
                  <IconButton icon={I.Trash} onClick={() => onDropField(f.name)} title={t`Drop column`} />
                )}
              </span>
            </div>
          );
        })}
      </ScrollArea>
    </Card>
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
  const { t } = useLingui();
  const tableName = slug ? `c_${slug}` : t`this collection`;
  return (
    <EmptyState
      bare
      icon={I.Inbox}
      title={<Trans>No items yet</Trans>}
      description={<Trans>Create the first row in <span className="font-mono">{tableName}</span> via the API or use the New row button.</Trans>}
      action={<Button variant="primary" size="sm" icon={I.Plus} onClick={onCreate}><Trans>New row</Trans></Button>}
    />
  );
}
