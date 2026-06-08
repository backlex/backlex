// @ts-nocheck
// Modal pickers for the "Relational" interface group in the item edit sheet.
//
//   • RelationPicker  — pick a row from c_<target> for `relation` fields.
//   • FilePicker      — pick one file/image key from /api/storage; lets the
//     user upload new files via drag-drop or click-to-pick.
//   • MultiFilePicker — multi-select variant; staged selection commits on Done.
//
// Each component renders an inline trigger button (showing the current value
// with a thumbnail/label when available) plus a portaled `.dialog-backdrop` +
// `.dialog-lg` modal when the user clicks the trigger.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "./icons";
import { Button, IconButton, Checkbox } from "./ui";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@backlex/ui/components/input-group";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { renderTemplate } from "@backlex/core";
import { api } from "@/lib/api";
import { itemsApi } from "./api";
import { useCollections } from "./queries";
import { expandParam } from "./display-template";

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

interface StorageFile {
  key: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
}

const LABEL_FIELDS = ["title", "name", "label", "slug", "subject", "email", "username"];
function pickRelationLabel(row: Record<string, unknown>): string | null {
  for (const k of LABEL_FIELDS) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** Resolve a target collection's display config (mustache template + fields)
 *  from the cached collections list so pickers can render rich row labels. */
function useTargetMeta(target: string) {
  const { data } = useCollections();
  return useMemo(() => {
    const col = data?.data?.find((c) => c.slug === target);
    return {
      displayTemplate: col?.displayTemplate ?? null,
      fields: col?.fields ?? [],
    };
  }, [data, target]);
}

type LabelFn = (row: Record<string, unknown>) => string | null;

/** Build a row-labeller: prefer the collection's display template (rendered
 *  against the — optionally expanded — row), falling back to the heuristic
 *  field scan when there's no template or it renders empty. */
function makeLabelFor(displayTemplate: string | null): LabelFn {
  if (!displayTemplate) return pickRelationLabel;
  return (row) => {
    const rendered = renderTemplate(displayTemplate, row).trim();
    return rendered || pickRelationLabel(row);
  };
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return `${n} B`;
}

function sanitizeFileName(raw: string): string {
  const trimmed = raw.replace(/^\/+/, "").replace(/[?#]/g, "").trim();
  return trimmed || `upload-${Date.now()}`;
}

// Renders an inline preview for a storage key. Optimistically tries to load
// the file as an image — if the request 404s or the browser can't decode it,
// we swap to a folder icon. This way non-image keys without a file extension
// (e.g. `branding/logo`) still get a chance to preview instead of always
// falling back to the icon.
function FileThumb({ k, contentType, size = 28 }: { k: string; contentType?: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  const knownNonImage = (contentType ?? "").length > 0 && !contentType!.startsWith("image/");
  const showImage = !errored && !knownNonImage;
  return (
    <span
      style={{
        width: size, height: size, borderRadius: "var(--radius-xl)", overflow: "hidden",
        background: "var(--muted)", flexShrink: 0,
        display: "grid", placeItems: "center", color: "var(--muted-foreground)",
      }}
    >
      {showImage ? (
        <img
          src={`/api/storage/${encodeURI(k)}`}
          alt=""
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={() => setErrored(true)}
        />
      ) : (
        <I.Folder size={Math.max(12, size - 14)} />
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FilePicker (single)
// ─────────────────────────────────────────────────────────────────────────────

export interface FilePickerProps {
  value: string;
  onChange: (v: string) => void;
  kind: "file" | "image";
  error?: boolean;
}

export function FilePicker({ value, onChange, kind, error }: FilePickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FileTrigger value={value} kind={kind} error={!!error} onOpen={() => setOpen(true)} onClear={() => onChange("")} />
      {open && (
        <FileBrowserModal
          kind={kind}
          mode="single"
          initialSelection={value ? [value] : []}
          onCommit={(keys) => { onChange(keys[0] ?? ""); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MultiFilePicker
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiFilePickerProps {
  value: string[];
  onChange: (v: string[]) => void;
  error?: boolean;
}

export function MultiFilePicker({ value, onChange, error }: MultiFilePickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MultiFileTrigger
        value={value}
        error={!!error}
        onOpen={() => setOpen(true)}
        onRemove={(k) => onChange(value.filter((x) => x !== k))}
      />
      {open && (
        <FileBrowserModal
          kind="file"
          mode="multi"
          initialSelection={value}
          onCommit={(keys) => { onChange(keys); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Triggers
// ─────────────────────────────────────────────────────────────────────────────

function FileTrigger({ value, kind, error, onOpen, onClear }: { value: string; kind: "file" | "image"; error: boolean; onOpen: () => void; onClear: () => void }) {
  const { t } = useLingui();
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10,
        border: `1px solid ${error ? "var(--destructive)" : "var(--border)"}`,
        borderRadius: "var(--radius-2xl)",
        background: "var(--card)",
        padding: 6,
        minHeight: 56,
      }}
    >
      {value ? (
        <>
          <FileThumb k={value} size={44} />
          <span className="font-mono" style={{ fontSize: 12.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 2 }} title={value}>
            {value}
          </span>
          <IconButton icon={I.X} title={t`Clear`} onClick={onClear} />
        </>
      ) : (
        <>
          <span
            style={{
              width: 44, height: 44, borderRadius: "var(--radius-xl)", flexShrink: 0,
              background: "var(--muted)", display: "grid", placeItems: "center",
              color: "var(--muted-foreground)",
            }}
          >
            {kind === "image" ? <I.Upload size={16} /> : <I.Folder size={16} />}
          </span>
          <span className="flex-1 text-[13px] text-muted-foreground">
            {kind === "image" ? <Trans>No image selected</Trans> : <Trans>No file selected</Trans>}
          </span>
        </>
      )}
      <Button size="sm" variant="outline" onClick={onOpen}>
        {value ? <Trans>Change</Trans> : kind === "image" ? <Trans>Pick image</Trans> : <Trans>Pick file</Trans>}
      </Button>
    </div>
  );
}

function MultiFileTrigger({ value, error, onOpen, onRemove }: { value: string[]; error: boolean; onOpen: () => void; onRemove: (k: string) => void }) {
  const { t } = useLingui();
  return (
    <div
      style={{
        display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
        border: `1px solid ${error ? "var(--destructive)" : "var(--border)"}`,
        borderRadius: "var(--radius-3xl)",
        background: "var(--card)", padding: "6px 6px 6px 10px", minHeight: 36,
      }}
    >
      {value.map((k) => (
        <span
          key={k}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "3px 4px 3px 6px", borderRadius: 999,
            background: "var(--muted)", fontSize: 12,
          }}
        >
          <FileThumb k={k} size={18} />
          <span className="font-mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
          <Button
            variant="ghost"
            size="xs"
            icon={I.X}
            onClick={() => onRemove(k)}
            aria-label={t`Remove ${k}`}
            className="size-[18px] rounded-full p-0 text-muted-foreground"
          />
        </span>
      ))}
      <div style={{ flex: 1 }} />
      <Button size="sm" variant="outline" icon={I.Plus} onClick={onOpen}>
        {value.length ? <Trans>Manage</Trans> : <Trans>Pick files</Trans>}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// File browser modal (single + multi)
// ─────────────────────────────────────────────────────────────────────────────

interface FileBrowserModalProps {
  kind: "file" | "image";
  mode: "single" | "multi";
  initialSelection: string[];
  onCommit: (keys: string[]) => void;
  onClose: () => void;
}

function FileBrowserModal({ kind, mode, initialSelection, onCommit, onClose }: FileBrowserModalProps) {
  const { t } = useLingui();
  const [files, setFiles] = useState<StorageFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; status: "uploading" | "done" | "error"; error?: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // null = "All files"; "(root)" = files with no `/` prefix; else the
  // top-level folder name (first path segment).
  const [activeFolder, setActiveFolder] = useState<string | null>(() => {
    // If the user already had a file selected, open the modal scoped to its
    // folder so the previous pick is in view.
    const seed = initialSelection[0];
    if (!seed) return null;
    const i = seed.indexOf("/");
    return i > 0 ? seed.slice(0, i) : "(root)";
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    api<{ data: StorageFile[] }>(`/api/storage`)
      .then((res) => {
        if (cancelled) return;
        let list = res.data ?? [];
        if (kind === "image") list = list.filter((f) => (f.contentType ?? "").startsWith("image/"));
        list.sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));
        setFiles(list);
      })
      .catch((e: Error) => { if (!cancelled) setLoadErr(e.message || "Failed to load files"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind]);

  // Folder list with counts, derived from the loaded file keys. Top-level
  // only — nested prefixes are flattened into their root so the panel stays a
  // single shallow list. Files with no slash go under the "(root)" bucket.
  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of files ?? []) {
      const i = f.key.indexOf("/");
      const name = i > 0 ? f.key.slice(0, i) : "(root)";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (a.name === "(root)") return 1;
        if (b.name === "(root)") return -1;
        return a.name.localeCompare(b.name);
      });
  }, [files]);

  const filtered = useMemo(() => {
    if (!files) return [];
    const query = q.trim().toLowerCase();
    return files.filter((f) => {
      if (activeFolder === "(root)") {
        if (f.key.includes("/")) return false;
      } else if (activeFolder) {
        if (!f.key.startsWith(`${activeFolder}/`)) return false;
      }
      if (query && !f.key.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [files, q, activeFolder]);

  const toggle = useCallback((k: string) => {
    if (mode === "single") setSelected([k]);
    else setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  }, [mode]);

  const uploadFolder = activeFolder && activeFolder !== "(root)" ? activeFolder : "uploads";
  const uploadFiles = useCallback((list: File[]) => {
    if (!list.length) return;
    const accept = kind === "image"
      ? (t: string) => t.startsWith("image/")
      : () => true;
    for (const f of list) {
      if (!accept(f.type || "")) continue;
      const safeName = sanitizeFileName(f.name);
      const key = `${uploadFolder}/${safeName}`;
      const jobId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setUploads((arr) => [{ id: jobId, name: key, status: "uploading" }, ...arr]);
      fetch(`/api/storage/${encodeURIComponent(key)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": f.type || "application/octet-stream" },
        body: f,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.json().catch(() => null);
          const finalKey = body?.data?.key ?? key;
          setFiles((fs) => [
            {
              key: finalKey,
              size: f.size,
              contentType: f.type || "application/octet-stream",
              uploadedAt: new Date().toISOString(),
            },
            ...(fs ?? []).filter((x) => x.key !== finalKey),
          ]);
          setUploads((arr) => arr.map((u) => (u.id === jobId ? { ...u, status: "done" } : u)));
          if (mode === "single") setSelected([finalKey]);
          else setSelected((s) => (s.includes(finalKey) ? s : [...s, finalKey]));
        })
        .catch((e: Error) => {
          setUploads((arr) => arr.map((u) => (u.id === jobId ? { ...u, status: "error", error: e.message } : u)));
        });
    }
  }, [kind, mode, uploadFolder]);

  const onDropFiles = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    const list = Array.from(e.dataTransfer?.files ?? []);
    uploadFiles(list);
  }, [uploadFiles]);

  const onPickFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    uploadFiles(list);
    e.target.value = "";
  }, [uploadFiles]);

  const title = kind === "image" ? t`Pick an image` : mode === "multi" ? t`Pick files` : t`Pick a file`;
  const accept = kind === "image" ? "image/*" : undefined;
  const canCommit = mode === "multi" ? true : selected.length > 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="flex max-h-[min(88vh,760px)] w-[min(880px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={onDropFiles}
      >
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">{title}</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {mode === "multi"
              ? <Trans>Pick one or more files. Drag-drop or use Upload to add new ones.</Trans>
              : kind === "image"
                ? <Trans>Pick an existing image, or drop a new one to upload.</Trans>
                : <Trans>Pick an existing file, or drop a new one to upload.</Trans>}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-row">
          <FolderSidebar
            folders={folders}
            active={activeFolder}
            onSelect={setActiveFolder}
            totalCount={files?.length ?? 0}
          />

          <div style={{ flex: 1, minWidth: 0, padding: 14, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <InputGroup style={{ flex: 1 }}>
                <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
                <InputGroupInput
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={kind === "image" ? t`Search images by key…` : t`Search files by key…`}
                />
              </InputGroup>
              <Button variant="outline" size="sm" icon={I.Upload} onClick={() => fileInputRef.current?.click()}>
                <Trans>Upload</Trans>
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={accept}
                multiple={mode === "multi"}
                style={{ display: "none" }}
                onChange={onPickFiles}
              />
            </div>

            <div
              className={`flex cursor-pointer items-center gap-3.5 rounded-2xl border-[1.5px] border-dashed px-3.5 py-2.5 transition-all ${dragOver ? "scale-[1.005] border-solid border-primary bg-muted" : "border-border bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] hover:border-interactive-hover-border hover:bg-muted"}`}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-muted text-primary">
                <I.Upload size={16} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-medium">
                  {kind === "image" ? <Trans>Drop images here, or click to upload</Trans> : <Trans>Drop files here, or click to upload</Trans>}
                </div>
                <div className="text-xs text-muted-foreground">
                  <Trans>Uploading to <span className="font-mono">{uploadFolder}/</span>.</Trans>
                </div>
              </div>
              <span className="rounded-full border border-border bg-card px-2 py-[3px] font-mono text-[11px] text-muted-foreground">{mode === "multi" ? <Trans>multiple ok</Trans> : <Trans>1 file</Trans>}</span>
            </div>

            {uploads.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {uploads.slice(0, 4).map((u) => (
                  <UploadRow key={u.id} u={u} />
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 200 }}>
              {loading && (
              <div className="flex flex-col gap-2 p-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            )}
              {loadErr && <div style={{ color: "var(--destructive)", fontSize: 12.5, padding: 12 }}>{loadErr}</div>}
              {!loading && !loadErr && filtered.length === 0 && (
                <div className="p-3 text-[12.5px] text-muted-foreground">
                  {q
                    ? (kind === "image" ? t`No images match "${q}".` : t`No files match "${q}".`)
                    : activeFolder
                      ? (activeFolder === "(root)" ? t`Folder (no folder) is empty.` : t`Folder ${activeFolder + "/"} is empty.`)
                      : (kind === "image" ? t`No images uploaded yet — drop one above to get started.` : t`No files uploaded yet — drop one above to get started.`)}
                </div>
              )}
              {!loading && !loadErr && filtered.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                    gap: 10,
                  }}
                >
                  {filtered.map((f) => (
                    <FileTile
                      key={f.key}
                      f={f}
                      selected={selected.includes(f.key)}
                      mode={mode}
                      onToggle={() => toggle(f.key)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          </div>
        </ScrollArea>

        <DialogFooter className="flex items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {mode === "multi"
              ? selected.length
                ? <Trans>{selected.length} selected</Trans>
                : <Trans>Nothing selected yet</Trans>
              : selected[0]
                ? <Trans>Selected <span className="font-mono">{selected[0]}</span></Trans>
                : <Trans>Pick a tile to select it</Trans>}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" disabled={!canCommit} onClick={() => onCommit(selected)}>
            {mode === "multi" ? t`Use ${selected.length || "0"} file${selected.length === 1 ? "" : "s"}` : <Trans>Confirm</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderSidebar({ folders, active, onSelect, totalCount }: {
  folders: Array<{ name: string; count: number }>;
  active: string | null;
  onSelect: (folder: string | null) => void;
  totalCount: number;
}) {
  const { t } = useLingui();
  const row = (label: ReactNode, count: number, isActive: boolean, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 10px",
        borderRadius: "var(--radius-md)",
        border: "none",
        background: isActive ? "color-mix(in oklch, var(--primary) 10%, transparent)" : "transparent",
        color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
        fontSize: 12.5,
      }}
    >
      <I.Folder size={13} />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span className="tabular-nums text-[11px] text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <aside
      style={{
        width: 192,
        flexShrink: 0,
        padding: "14px 10px",
        borderRight: "1px solid var(--border)",
        background: "color-mix(in oklch, var(--muted) 18%, var(--card))",
        overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 2,
      }}
    >
      <div className="px-2.5 pb-2 pt-1 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <Trans>Folders</Trans>
      </div>
      {row(t`All files`, totalCount, active === null, () => onSelect(null), "__all")}
      {folders.map((f) =>
        row(
          f.name === "(root)" ? <span className="text-muted-foreground"><Trans>(no folder)</Trans></span> : <span className="font-mono">{f.name}</span>,
          f.count,
          active === f.name,
          () => onSelect(f.name),
          f.name,
        ),
      )}
      {folders.length === 0 && (
        <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">
          <Trans>No folders yet — uploads land under <span className="font-mono">uploads/</span>.</Trans>
        </div>
      )}
    </aside>
  );
}

function FileTile({ f, selected, mode, onToggle }: { f: StorageFile; selected: boolean; mode: "single" | "multi"; onToggle: () => void }) {
  const isImg = (f.contentType ?? "").startsWith("image/");
  const name = f.key.split("/").pop() || f.key;
  return (
    <div
      onClick={onToggle}
      onDoubleClick={onToggle}
      role="button"
      tabIndex={0}
      style={{
        display: "flex", flexDirection: "column", gap: 6,
        padding: 8,
        borderRadius: "var(--radius-xl)",
        border: `1px solid ${selected ? "var(--primary)" : "var(--border)"}`,
        background: selected ? "color-mix(in oklch, var(--primary) 8%, var(--card))" : "var(--card)",
        cursor: "pointer",
        position: "relative",
        transition: "border-color 120ms, background 120ms",
      }}
    >
      {mode === "multi" && (
        <div
          style={{
            position: "absolute", top: 6, right: 6, zIndex: 1,
            background: "color-mix(in oklch, var(--card) 90%, transparent)",
            borderRadius: 4, padding: 2,
          }}
        >
          <Checkbox checked={selected} onChange={() => onToggle()} />
        </div>
      )}
      <div
        style={{
          aspectRatio: "1 / 1",
          width: "100%",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          background: "var(--muted)",
          display: "grid", placeItems: "center",
        }}
      >
        {isImg ? (
          <img
            src={`/api/storage/${encodeURI(f.key)}`}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <I.Folder size={32} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="font-mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.key}>
          {name}
        </div>
        <div className="tabular-nums text-[11px] text-muted-foreground">
          {fmtSize(f.size)}
        </div>
      </div>
    </div>
  );
}

function UploadRow({ u }: { u: { id: string; name: string; status: "uploading" | "done" | "error"; error?: string } }) {
  const { t } = useLingui();
  const Icon = u.status === "uploading" ? I.Upload : u.status === "done" ? I.Check : I.AlertTriangle;
  const color = u.status === "error" ? "var(--destructive)" : u.status === "done" ? "oklch(0.7 0.18 145)" : "var(--muted-foreground)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--card)", fontSize: 12 }}>
      <Icon size={13} />
      <span className="font-mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</span>
      <span style={{ color, fontSize: 11 }}>
        {u.status === "uploading" ? t`uploading…` : u.status === "done" ? t`uploaded` : (u.error || t`failed`)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RelationPicker (modal)
// ─────────────────────────────────────────────────────────────────────────────

export interface RelationPickerProps {
  value: string;
  onChange: (v: string) => void;
  target: string;
  error?: boolean;
  placeholder?: string;
}

export function RelationPicker({ value, onChange, target, error, placeholder }: RelationPickerProps) {
  const [open, setOpen] = useState(false);
  const [labelCache, setLabelCache] = useState<Record<string, string>>({});

  const meta = useTargetMeta(target);
  const labelFor = useMemo(() => makeLabelFor(meta.displayTemplate), [meta.displayTemplate]);
  // One-hop expand so `{{ rel.field }}` resolves to the related row's value.
  const expand = expandParam(meta.displayTemplate, meta.fields);

  useEffect(() => {
    if (!value || !target || labelCache[value]) return;
    let cancelled = false;
    itemsApi.get(target, value, expand ? { expand } : undefined)
      .then((res) => {
        if (cancelled || !res?.data) return;
        const lbl = labelFor(res.data as Record<string, unknown>);
        if (lbl) setLabelCache((c) => ({ ...c, [value]: lbl }));
      })
      .catch(() => { /* row may be deleted — keep id-only */ });
    return () => { cancelled = true; };
  }, [value, target, labelCache, labelFor, expand]);

  const seedLabels = useCallback((rows: Array<Record<string, unknown>>) => {
    setLabelCache((c) => {
      const next = { ...c };
      for (const r of rows) {
        const id = String(r.id ?? "");
        if (id) next[id] = labelFor(r) ?? id;
      }
      return next;
    });
  }, [labelFor]);

  return (
    <>
      <RelationTrigger
        value={value}
        label={value ? labelCache[value] : undefined}
        error={!!error}
        target={target}
        placeholder={placeholder}
        onOpen={() => setOpen(true)}
        onClear={() => onChange("")}
      />
      {open && (
        <RelationBrowserModal
          target={target}
          initial={value}
          onCommit={(id) => { onChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
          seedLabels={seedLabels}
          labelFor={labelFor}
          expand={expand}
        />
      )}
    </>
  );
}

function RelationTrigger({ value, label, error, target, placeholder, onOpen, onClear }: {
  value: string;
  label?: string;
  error: boolean;
  target: string;
  placeholder?: string;
  onOpen: () => void;
  onClear: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        border: `1px solid ${error ? "var(--destructive)" : "var(--border)"}`,
        borderRadius: "var(--radius-3xl)",
        background: "var(--card)",
        padding: "4px 6px 4px 12px",
        minHeight: 36,
      }}
    >
      {value ? (
        <>
          <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>
            {label ?? <span className="font-mono">{value}</span>}
          </span>
          {label && (
            <span className="font-mono text-[11px] text-muted-foreground">{value.slice(0, 8)}</span>
          )}
          <IconButton icon={I.X} title={t`Clear`} onClick={onClear} />
        </>
      ) : (
        <span className="flex-1 text-[13px] text-muted-foreground">
          {placeholder ?? t`No row from c_${target} selected`}
        </span>
      )}
      <Button size="sm" variant="outline" onClick={onOpen}>
        {value ? <Trans>Change</Trans> : <Trans>Pick row</Trans>}
      </Button>
    </div>
  );
}

function RelationBrowserModal({ target, initial, onCommit, onClose, seedLabels, labelFor, expand }: {
  target: string;
  initial: string;
  onCommit: (id: string) => void;
  onClose: () => void;
  seedLabels: (rows: Array<Record<string, unknown>>) => void;
  labelFor: LabelFn;
  expand?: string;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string>(initial);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    itemsApi.list(target, { limit: 100, sort: "-updated_at", ...(expand ? { expand } : {}) })
      .then((res) => {
        if (cancelled) return;
        const next = (res?.data ?? []) as Array<Record<string, unknown>>;
        setRows(next);
        seedLabels(next);
      })
      .catch((e: Error) => { if (!cancelled) setErr(e.message || "Failed to load rows"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, seedLabels, expand]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const query = q.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => {
      const hay = `${labelFor(r) ?? ""} ${r.id ?? ""}`.toLowerCase();
      return hay.includes(query);
    });
  }, [rows, q, labelFor]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(88vh,720px)] w-[min(720px,92vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <Trans>Pick a row from <span className="font-mono">c_{target}</span></Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            <Trans>Showing the 100 most recently updated rows. Use search to narrow down.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-4">
          <InputGroup>
            <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t`Search by label or id…`}
            />
          </InputGroup>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 200 }}>
            {loading && (
              <div className="flex flex-col gap-2 p-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            )}
            {err && <div style={{ color: "var(--destructive)", fontSize: 12.5, padding: 12 }}>{err}</div>}
            {!loading && !err && filtered.length === 0 && (
              <div className="p-3 text-[12.5px] text-muted-foreground">
                {q ? t`No rows match "${q}".` : t`c_${target} is empty.`}
              </div>
            )}
            {filtered.map((r) => {
              const id = String(r.id ?? "");
              const lbl = labelFor(r);
              const on = selected === id;
              return (
                <div
                  key={id}
                  onClick={() => setSelected(id)}
                  onDoubleClick={() => { setSelected(id); onCommit(id); }}
                  role="button"
                  tabIndex={0}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px",
                    borderRadius: "var(--radius-xl)",
                    border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
                    background: on ? "color-mix(in oklch, var(--primary) 8%, var(--card))" : "var(--card)",
                    cursor: "pointer",
                  }}
                >
                  <span style={{
                    width: 14, height: 14, borderRadius: 999,
                    border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
                    background: on ? "var(--primary)" : "transparent",
                    boxShadow: on ? "inset 0 0 0 3px var(--card)" : "none",
                    flex: "none",
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {lbl ?? <span className="text-muted-foreground"><Trans>(no label)</Trans></span>}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {id}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </ScrollArea>

        <DialogFooter className="flex items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {selected
              ? <Trans>Selected <span className="font-mono">{selected}</span></Trans>
              : <Trans>Pick a row to select it</Trans>}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" disabled={!selected} onClick={() => onCommit(selected)}><Trans>Confirm</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
