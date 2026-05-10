// @ts-nocheck
// Cmd+K palette + Realtime event tail + Schema view + Empty states
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import { MOCK, type CollectionListItem, type CollectionSchema, type Post, type SchemaField } from "./mock";
import { Badge, Button, IconButton } from "./ui";

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
    const nav: PaletteSelection[] = MOCK.navItems.concat(MOCK.navSettings).map((n) => ({ kind: "page", id: n.id, label: n.label, icon: String(n.icon), meta: "goto" })).filter((x) => !ql || x.label.toLowerCase().includes(ql));
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
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true">
        <div className="palette-input">
          <I.Search size={15} />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Type a command, collection, or item title…" />
          <span className="kbd" style={{ fontFamily: "Geist Mono, monospace", fontSize: 10.5, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--muted)", color: "var(--muted-foreground)" }}>esc</span>
        </div>
        <div className="palette-results">
          {flat.length === 0 ? (
            <div className="palette-empty">
              No matches. Try <span className="font-mono">posts</span> or <span className="font-mono">edge</span>.
            </div>
          ) : (
            groups.map((g) => (
              <Fragment key={g.name}>
                <div className="palette-group-label">{g.name}</div>
                {g.list.map((it) => {
                  const idx = runningIdx++;
                  const IconComp = (I as Record<string, IconComponent>)[it.icon as IconKey];
                  return (
                    <div key={`${g.name}-${it.id}`} className="palette-item" data-active={idx === active} onMouseEnter={() => setActive(idx)} onClick={() => onNavigate(it)}>
                      {IconComp && <IconComp size={14} />}
                      <span style={{ display: "flex", flexDirection: "column" }}>
                        <span>{it.label}</span>
                        {"sub" in it && it.sub && <span className="font-mono" style={{ fontSize: 11, color: "var(--muted-foreground)" }}>/{it.sub}</span>}
                      </span>
                      <span className="meta">{it.meta}</span>
                    </div>
                  );
                })}
              </Fragment>
            ))
          )}
        </div>
        <div className="palette-footer">
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">esc</span> close</span>
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
}

export function RealtimeTail({ events, channel, connected }: { events: RealtimeEvent[]; channel: string; connected?: boolean }) {
  return (
    <div className="tail">
      <div className="tail-header">
        <I.Zap size={14} />
        <h3>Live tail</h3>
        <span className="channel">
          <span className={`dot ${connected ? "" : "red"}`} style={{ marginRight: 6 }} />
          {channel}
        </span>
      </div>
      {events.length === 0 ? (
        <div style={{ padding: 28, color: "var(--muted-foreground)", fontSize: 12.5, textAlign: "center" }}>
          Subscribed. Waiting for events…
        </div>
      ) : (
        <div className="tail-list">
          {events.slice(0, 30).map((ev) => (
            <div key={ev.id} className="tail-event" data-event={ev.event}>
              <div className="row1">
                <span className="ev">{ev.event}</span>
                <span className="when">{ev.t}</span>
              </div>
              <div className="what">
                <span className="id">{ev.title || ev.itemId}</span>
                {ev.event === "updated" && ev.field && <> · changed <span style={{ color: "var(--foreground)" }}>{ev.field}</span></>}
                {ev.who && <> · by <span style={{ color: "var(--foreground)" }}>{ev.who}</span></>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SchemaView({ schema, onAddField, onDropField }: { schema: CollectionSchema; onAddField: () => void; onDropField: (name: string) => void }) {
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
  return (
    <div className="card">
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <I.Braces size={14} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>fields</span>
        <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{allFields.length} total · {userFields.length} editable</span>
        <div className="spacer" />
        <Button variant="primary" size="sm" icon={I.Plus} onClick={onAddField}>Add field</Button>
      </div>
      <div>
        {allFields.map((f) => (
          <div key={f.name} className="schema-row">
            <span className="grip"><I.Grip size={14} /></span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className="name">{f.name}</span>
              {f.system && <Badge variant="secondary">system</Badge>}
              {f.unique && <Badge variant="outline">unique</Badge>}
              {!f.nullable && !f.system && <Badge variant="outline">required</Badge>}
            </div>
            <Badge variant="outline" mono>{f.type}</Badge>
            <span className="font-mono" style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>
              {f.default ?? <span style={{ opacity: 0.5 }}>—</span>}
            </span>
            <span style={{ display: "flex", justifyContent: "flex-end" }}>
              {!f.system && (
                <IconButton icon={I.Trash} onClick={() => onDropField(f.name)} title="Drop column" />
              )}
            </span>
          </div>
        ))}
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
  return (
    <div className="alter-preview">
      <span className="comment">-- runtime DDL preview · sqlite dialect</span>{"\n"}
      <span className="kw">ALTER TABLE</span> <span className="ident">"c_posts"</span>{"\n"}
      {"  "}<span className="kw">ADD COLUMN</span> <span className="ident">"{pendingField.name || "new_field"}"</span> {sqlType}
      {!pendingField.nullable ? <> <span className="kw">NOT NULL</span></> : null}
      {pendingField.default ? <> <span className="kw">DEFAULT</span> <span className="str">{pendingField.default}</span></> : null};{"\n"}
      <span className="comment">-- additive only — no data is rewritten.</span>
    </div>
  );
}

export function EmptyItems({ onCreate, slug }: { onCreate: () => void; slug?: string }) {
  const tableName = slug ? `c_${slug}` : "this collection";
  return (
    <div className="empty">
      <div className="ico"><I.Inbox size={20} /></div>
      <h4>No items yet</h4>
      <p>Create the first row in <span className="font-mono">{tableName}</span> via the API or use the New row button.</p>
      <Button variant="primary" size="sm" icon={I.Plus} onClick={onCreate}>New row</Button>
    </div>
  );
}
