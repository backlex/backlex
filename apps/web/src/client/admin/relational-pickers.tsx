// @ts-nocheck
// Searchable popovers for the "Relational" interface group rendered inside
// the item edit sheet:
//   • RelationPicker  — pick a row from c_<target> for `relation` fields.
//   • FilePicker      — pick one file/image key from /api/storage.
//   • MultiFilePicker — same, but for `files` (multi) fields; value is a
//     string[] of keys.
//
// Visual + keyboard mirrors admin/select.tsx (reuses .sn-select-* CSS) but
// renders rich rows (thumbnails for images, label heuristics for relations)
// instead of plain options.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { I } from "./icons";
import { api } from "@/lib/api";
import { itemsApi } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Shared popover positioning
// ─────────────────────────────────────────────────────────────────────────────

interface PopPos { top: number; left: number; width: number }

function usePopoverPos(open: boolean, listCount: number, triggerRef: RefObject<HTMLElement | null>): PopPos {
  const [pos, setPos] = useState<PopPos>({ top: 0, left: 0, width: 0 });
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const popHeight = Math.min(360, listCount * 56 + 60);
    const below = window.innerHeight - r.bottom;
    const flipUp = below < popHeight + 12 && r.top > popHeight + 12;
    setPos({
      top: flipUp ? r.top - popHeight - 6 : r.bottom + 6,
      left: r.left,
      width: r.width,
    });
  }, [open, listCount, triggerRef]);
  return pos;
}

function useOutsideAndKeys(opts: {
  open: boolean;
  popRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  listLen: number;
  active: number;
  setActive: (fn: (a: number) => number) => void;
  onEnter: () => void;
  close: () => void;
}) {
  const { open, popRef, triggerRef, listLen, active, setActive, onEnter, close } = opts;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); triggerRef.current?.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); if (listLen) setActive((a) => (a + 1) % listLen); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (listLen) setActive((a) => (a - 1 + listLen) % listLen); }
      else if (e.key === "Enter") { e.preventDefault(); onEnter(); }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, listLen, active, onEnter, close, popRef, triggerRef, setActive]);
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationPicker
// ─────────────────────────────────────────────────────────────────────────────

const LABEL_FIELDS = ["title", "name", "label", "slug", "subject", "email", "username"];

function pickRelationLabel(row: Record<string, unknown>): string | null {
  for (const k of LABEL_FIELDS) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export interface RelationPickerProps {
  value: string;
  onChange: (v: string) => void;
  target: string;
  error?: boolean;
  placeholder?: string;
}

export function RelationPicker({ value, onChange, target, error, placeholder }: RelationPickerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // id → display label, populated as rows stream in and on single-id lookups
  // so the trigger can show a friendly label even before the popover opens.
  const [labelCache, setLabelCache] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || rows !== null || !target) return;
    setLoading(true);
    setLoadErr(null);
    itemsApi.list(target, { limit: 50, sort: "-updated_at" })
      .then((res) => {
        const next = (res?.data ?? []) as Array<Record<string, unknown>>;
        setRows(next);
        setLabelCache((cache) => {
          const out = { ...cache };
          for (const r of next) {
            const id = String(r.id ?? "");
            if (id) out[id] = pickRelationLabel(r) ?? id;
          }
          return out;
        });
      })
      .catch((e: Error) => setLoadErr(e.message || "Failed to load rows"))
      .finally(() => setLoading(false));
  }, [open, rows, target]);

  // Fill in the trigger label when a value is set but the row isn't in the
  // first-page list (e.g. edit-mode opening on an older relation).
  useEffect(() => {
    if (!value || !target) return;
    if (labelCache[value]) return;
    let cancelled = false;
    itemsApi.get(target, value)
      .then((res) => {
        if (cancelled || !res?.data) return;
        const lbl = pickRelationLabel(res.data as Record<string, unknown>);
        if (lbl) setLabelCache((c) => ({ ...c, [value]: lbl }));
      })
      .catch(() => { /* row may be deleted — show id only */ });
    return () => { cancelled = true; };
  }, [value, target, labelCache]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const query = q.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => {
      const hay = `${pickRelationLabel(r) ?? ""} ${r.id ?? ""}`.toLowerCase();
      return hay.includes(query);
    });
  }, [rows, q]);

  const pos = usePopoverPos(open, filtered.length, triggerRef);

  useLayoutEffect(() => {
    if (!open) return;
    setTimeout(() => searchRef.current?.focus(), 0);
    setActive(0);
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const commit = (id: string) => {
    onChange(id);
    setOpen(false); setQ("");
    triggerRef.current?.focus();
  };

  useOutsideAndKeys({
    open,
    popRef,
    triggerRef,
    listLen: filtered.length,
    active,
    setActive,
    onEnter: () => {
      const sel = filtered[active];
      if (sel) {
        const id = String(sel.id ?? "");
        if (id) commit(id);
      }
    },
    close: () => { setOpen(false); setQ(""); },
  });

  const currentLabel = value ? labelCache[value] : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`sn-select-trigger ${error ? "error" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value || ""}
      >
        <span className="sn-select-value">
          {value ? (
            currentLabel ? (
              <>
                <span>{currentLabel}</span>
                <span className="muted font-mono" style={{ fontSize: 11 }}>{value.slice(0, 8)}</span>
              </>
            ) : (
              <span className="font-mono">{value}</span>
            )
          ) : (
            <span className="sn-select-placeholder">
              {placeholder ?? `Pick a row from c_${target}…`}
            </span>
          )}
        </span>
        <I.ChevronDown size={13} className="sn-select-chevron" />
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="sn-select-pop"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxWidth: 520 }}
          role="listbox"
        >
          <div className="sn-select-search">
            <I.Search size={12} />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search rows in c_${target}…`}
            />
            {value && (
              <button
                type="button"
                onClick={() => commit("")}
                style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 11, padding: "2px 6px", color: "var(--muted-foreground)" }}
                title="Clear selection"
              >
                Clear
              </button>
            )}
          </div>

          <div className="sn-select-list" style={{ maxHeight: 320, overflowY: "auto" }}>
            {loading && <div className="sn-select-empty">Loading…</div>}
            {loadErr && <div className="sn-select-empty" style={{ color: "var(--destructive)" }}>{loadErr}</div>}
            {!loading && !loadErr && rows && filtered.length === 0 && (
              <div className="sn-select-empty">
                {q ? `No rows match “${q}”` : `c_${target} is empty`}
              </div>
            )}
            {filtered.map((r, i) => {
              const id = String(r.id ?? "");
              const lbl = pickRelationLabel(r);
              const on = value === id;
              return (
                <div
                  key={id || i}
                  role="option"
                  aria-selected={on}
                  data-active={i === active}
                  className="sn-select-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(id)}
                  style={{ alignItems: "flex-start" }}
                >
                  <span className="sn-select-check" style={{ marginTop: 2 }}>
                    {on ? <I.Check size={12} /> : null}
                  </span>
                  <span className="sn-select-item-label" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
                      {lbl ?? <span className="muted">(no label)</span>}
                    </span>
                    <span className="muted font-mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
                      {id}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FilePicker / MultiFilePicker
// ─────────────────────────────────────────────────────────────────────────────

interface StorageFile {
  key: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
}

function useStorageList(open: boolean, kind: "file" | "image") {
  const [files, setFiles] = useState<StorageFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || files !== null) return;
    setLoading(true);
    setErr(null);
    api<{ data: StorageFile[] }>(`/api/storage`)
      .then((res) => {
        let list = res.data ?? [];
        if (kind === "image") list = list.filter((f) => (f.contentType ?? "").startsWith("image/"));
        setFiles(list);
      })
      .catch((e: Error) => setErr(e.message || "Failed to load files"))
      .finally(() => setLoading(false));
  }, [open, files, kind]);
  return { files, loading, err };
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return `${n} B`;
}

function FileThumb({ k, isImg, size = 28 }: { k: string; isImg: boolean; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 4, overflow: "hidden", background: "var(--muted)", flexShrink: 0, display: "grid", placeItems: "center", color: "var(--muted-foreground)" }}>
      {isImg ? (
        <img
          src={`/api/storage/${encodeURI(k)}`}
          alt=""
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : (
        <I.Folder size={Math.max(12, size - 14)} />
      )}
    </span>
  );
}

export interface FilePickerProps {
  value: string;
  onChange: (v: string) => void;
  kind: "file" | "image";
  error?: boolean;
}

export function FilePicker({ value, onChange, kind, error }: FilePickerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const { files, loading, err } = useStorageList(open, kind);

  const filtered = useMemo(() => {
    if (!files) return [];
    const query = q.trim().toLowerCase();
    if (!query) return files;
    return files.filter((f) => f.key.toLowerCase().includes(query));
  }, [files, q]);

  const pos = usePopoverPos(open, filtered.length, triggerRef);

  useLayoutEffect(() => {
    if (!open) return;
    setTimeout(() => searchRef.current?.focus(), 0);
    setActive(0);
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const commit = (k: string) => {
    onChange(k);
    setOpen(false); setQ("");
    triggerRef.current?.focus();
  };

  useOutsideAndKeys({
    open,
    popRef,
    triggerRef,
    listLen: filtered.length,
    active,
    setActive,
    onEnter: () => {
      const sel = filtered[active];
      if (sel) commit(sel.key);
    },
    close: () => { setOpen(false); setQ(""); },
  });

  const isImg = kind === "image";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`sn-select-trigger ${error ? "error" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value || ""}
      >
        <span className="sn-select-value" style={{ gap: 8 }}>
          {value ? (
            <>
              <FileThumb k={value} isImg={isImg} size={22} />
              <span className="font-mono" style={{ fontSize: 12.5 }}>{value}</span>
            </>
          ) : (
            <span className="sn-select-placeholder">
              {isImg ? "Pick an image…" : "Pick a file…"}
            </span>
          )}
        </span>
        <I.ChevronDown size={13} className="sn-select-chevron" />
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="sn-select-pop"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxWidth: 520 }}
          role="listbox"
        >
          <div className="sn-select-search">
            <I.Search size={12} />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={isImg ? "Search images…" : "Search files…"}
            />
            {value && (
              <button
                type="button"
                onClick={() => commit("")}
                style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 11, padding: "2px 6px", color: "var(--muted-foreground)" }}
                title="Clear selection"
              >
                Clear
              </button>
            )}
          </div>

          <div className="sn-select-list" style={{ maxHeight: 360, overflowY: "auto" }}>
            {loading && <div className="sn-select-empty">Loading…</div>}
            {err && <div className="sn-select-empty" style={{ color: "var(--destructive)" }}>{err}</div>}
            {!loading && !err && files && filtered.length === 0 && (
              <div className="sn-select-empty">
                {q
                  ? `No ${isImg ? "images" : "files"} match “${q}”`
                  : isImg
                    ? "No images uploaded yet — upload one in Storage."
                    : "No files uploaded yet — upload one in Storage."}
              </div>
            )}
            {filtered.map((f, i) => {
              const on = value === f.key;
              const rowIsImg = (f.contentType ?? "").startsWith("image/");
              return (
                <div
                  key={f.key}
                  role="option"
                  aria-selected={on}
                  data-active={i === active}
                  className="sn-select-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(f.key)}
                  style={{ alignItems: "center", gap: 10 }}
                >
                  <span className="sn-select-check">{on ? <I.Check size={12} /> : null}</span>
                  <FileThumb k={f.key} isImg={rowIsImg} size={28} />
                  <span className="sn-select-item-label" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, minWidth: 0 }}>
                    <span className="font-mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
                      {f.key}
                    </span>
                    <span className="muted tabular-nums" style={{ fontSize: 11 }}>
                      {fmtSize(f.size)}{f.contentType ? ` · ${f.contentType}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export interface MultiFilePickerProps {
  value: string[];
  onChange: (v: string[]) => void;
  error?: boolean;
}

export function MultiFilePicker({ value, onChange, error }: MultiFilePickerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const { files, loading, err } = useStorageList(open, "file");

  const filtered = useMemo(() => {
    if (!files) return [];
    const query = q.trim().toLowerCase();
    if (!query) return files;
    return files.filter((f) => f.key.toLowerCase().includes(query));
  }, [files, q]);

  const pos = usePopoverPos(open, filtered.length, triggerRef);

  useLayoutEffect(() => {
    if (!open) return;
    setTimeout(() => searchRef.current?.focus(), 0);
    setActive(0);
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const toggle = (k: string) => {
    onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  };
  const removeChip = (k: string) => onChange(value.filter((x) => x !== k));

  useOutsideAndKeys({
    open,
    popRef,
    triggerRef,
    listLen: filtered.length,
    active,
    setActive,
    onEnter: () => {
      const sel = filtered[active];
      if (sel) toggle(sel.key);
    },
    close: () => { setOpen(false); setQ(""); },
  });

  return (
    <>
      <div
        style={{
          display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
          border: `1px solid ${error ? "var(--destructive)" : "var(--border)"}`,
          borderRadius: "var(--radius-3xl)",
          background: "var(--card)", padding: "6px 10px", minHeight: 36,
        }}
      >
        {value.map((k) => {
          const meta = files?.find((f) => f.key === k);
          const isImg = (meta?.contentType ?? "").startsWith("image/");
          return (
            <span
              key={k}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "3px 4px 3px 6px", borderRadius: 999,
                background: "var(--muted)", fontSize: 12,
              }}
            >
              <FileThumb k={k} isImg={isImg} size={18} />
              <span className="font-mono" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
              <button
                type="button"
                onClick={() => removeChip(k)}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 18, height: 18, borderRadius: 999, border: "none",
                  background: "transparent", cursor: "pointer", color: "var(--muted-foreground)",
                }}
                aria-label={`Remove ${k}`}
              >
                <I.X size={11} />
              </button>
            </span>
          );
        })}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px",
            borderRadius: 999, border: "1px dashed var(--border)", background: "transparent",
            cursor: "pointer", color: "var(--muted-foreground)", fontSize: 12,
          }}
        >
          <I.Plus size={11} /> Add file
        </button>
      </div>

      {open && createPortal(
        <div
          ref={popRef}
          className="sn-select-pop"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxWidth: 520 }}
          role="listbox"
        >
          <div className="sn-select-search">
            <I.Search size={12} />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search files…"
            />
          </div>

          <div className="sn-select-list" style={{ maxHeight: 360, overflowY: "auto" }}>
            {loading && <div className="sn-select-empty">Loading…</div>}
            {err && <div className="sn-select-empty" style={{ color: "var(--destructive)" }}>{err}</div>}
            {!loading && !err && files && filtered.length === 0 && (
              <div className="sn-select-empty">{q ? `No files match “${q}”` : "No files uploaded yet — upload one in Storage."}</div>
            )}
            {filtered.map((f, i) => {
              const on = value.includes(f.key);
              const rowIsImg = (f.contentType ?? "").startsWith("image/");
              return (
                <div
                  key={f.key}
                  role="option"
                  aria-selected={on}
                  data-active={i === active}
                  className="sn-select-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => toggle(f.key)}
                  style={{ alignItems: "center", gap: 10 }}
                >
                  <span className="sn-select-check">{on ? <I.Check size={12} /> : null}</span>
                  <FileThumb k={f.key} isImg={rowIsImg} size={28} />
                  <span className="sn-select-item-label" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, minWidth: 0 }}>
                    <span className="font-mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>{f.key}</span>
                    <span className="muted tabular-nums" style={{ fontSize: 11 }}>
                      {fmtSize(f.size)}{f.contentType ? ` · ${f.contentType}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
