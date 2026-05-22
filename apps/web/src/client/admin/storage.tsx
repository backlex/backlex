// @ts-nocheck
// Storage page — preview, batch upload progress, ACL, file detail modal
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "./icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "./ui";
import { Input } from "@workeros/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workeros/ui/components/input-group";
import { Textarea } from "@workeros/ui/components/textarea";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workeros/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@workeros/ui/components/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { Button as ShadButton } from "@workeros/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import { CheckIcon, ChevronsUpDownIcon, LinkIcon } from "lucide-react";
import { cn } from "@workeros/ui/lib/utils";
import { api } from "@/lib/api";
import { useUrlState } from "@/lib/use-url-state";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { SkeletonCard } from "./loading";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

const SIZE_CHIP_BASE = "flex-1 cursor-pointer rounded-md border py-1 font-mono text-[10.5px]";
const SIZE_CHIP_ON = "border-primary bg-primary text-primary-foreground";
const SIZE_CHIP_OFF = "border-border bg-card text-muted-foreground hover:text-foreground";
const SEG_BTN_BASE = "flex-1 cursor-pointer px-2 py-1.5 text-[11.5px]";
const SEG_BTN_ON = "bg-primary text-primary-foreground";
const SEG_BTN_OFF = "bg-transparent text-muted-foreground hover:text-foreground";

interface StoredFolder {
  id: string;
  name: string;
  count: number;
  public: boolean;
}

interface FileMetadata {
  name?: string;
  description?: string;
  tags?: string[];
  author?: string;
  location?: string;
  [key: string]: unknown;
}

interface StoredFile {
  key: string;
  size: number;
  type: string;
  folder: string | null;
  /** Persisted folder_id from the DB — drives the "Move to folder" select. */
  folderId: string | null;
  updated: string;
  acl: "public" | "private";
  metadata: FileMetadata | null;
  hue?: number;
  w?: number;
  h?: number;
}

interface UploadJob {
  id: string;
  name: string;
  size: number;
  type: string;
  /** 0–100, derived from XHR upload.onprogress event. */
  progress: number;
  status: "uploading" | "done" | "failed";
  /** Set on failure so the row can show the server's message. */
  error?: string;
  /** Per-job XHR so the user can cancel mid-flight. */
  xhr?: XMLHttpRequest;
}

const PAGE_SIZE = 50;

export function StoragePage({ pushToast }: { pushToast: (msg: string) => void }) {
  const { t } = useLingui();
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [folderCounts, setFolderCounts] = useState<{ root: number; byFolderId: Record<string, number>; total: number }>({ root: 0, byFolderId: {}, total: 0 });
  const [folder, setFolder] = useState<string | null>(null);
  const [folderQuery, setFolderQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useUrlState("q", "");
  // Debounced search — the user can keep typing without triggering a refetch
  // on every keystroke. 300 ms matches the storage detail HEAD probe.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Folder list (small — load once, refresh on creates).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const f = await api<{ data: { id: string; name: string }[] }>("/api/folders");
        if (!cancelled && Array.isArray(f.data)) {
          setFolders(
            f.data.map((x) => ({
              id: x.id,
              name: x.name,
              count: 0,
              public: false,
            })),
          );
        }
      } catch {
        // leave folders empty
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** path → folder.id lookup. Virtual parent nodes (paths that exist only
   *  via name splitting, no real row) won't be present here, so the
   *  resolver below returns null and the page falls back to "all files". */
  const folderIdByPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const fl of folders) m.set(fl.name, fl.id);
    return m;
  }, [folders]);
  const selectedFolderId = folder == null ? null : folderIdByPath.get(folder) ?? null;

  /** Internal: build the query string for a given offset. Keeps callsites
   *  (initial load + Load more) consistent. */
  const buildListUrl = (offset: number): string => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    if (folder == null) {
      // root selection = no filter (show every file in the tenant)
    } else if (selectedFolderId) {
      params.set("folderId", selectedFolderId);
    } else {
      // Virtual parent ("marketing" with only "marketing/q1" as a real
      // folder). The server has no name-prefix filter, so we'd over-fetch;
      // signal it by passing a sentinel that returns nothing and add a
      // client-side hint instead.
      params.set("folderId", "__virtual__");
    }
    if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
    // No trailing slash — Hono treats `/api/storage/` as a distinct path
    // from the route registered on `/`, returning 404. The old non-paginated
    // call used the bare path and worked; the rewrite accidentally tacked
    // the slash on, so the request would 404, the client would catch and
    // silently set files=[], and the grid stayed empty even though
    // folder-counts (a different path) reported real numbers.
    return `/api/storage?${params}`;
  };

  // Files page — refetches on folder / debounced-search change. Replaces
  // the prior one-shot dump of the whole tenant; the new endpoint paginates
  // by createdAt DESC so users see their latest uploads first.
  useEffect(() => {
    let cancelled = false;
    setFilesLoading(true);
    void (async () => {
      try {
        const fs = await api<{ data: any[]; meta: { total: number; limit: number; offset: number } }>(
          buildListUrl(0),
        );
        if (cancelled) return;
        setFiles(
          (fs.data ?? []).map((file) => ({
            key: file.key,
            size: file.size ?? 0,
            type: file.contentType ?? "application/octet-stream",
            folder: file.folderId ?? null,
            folderId: file.folderId ?? null,
            updated: file.uploadedAt ? String(file.uploadedAt).slice(0, 10) : "—",
            acl: (file.acl as "public" | "private") ?? "private",
            metadata: file.metadata ?? null,
          })),
        );
        setFilesTotal(fs.meta?.total ?? 0);
      } catch {
        if (!cancelled) {
          setFiles([]);
          setFilesTotal(0);
        }
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, debouncedSearch, selectedFolderId]);

  /** Append the next page in place. Triggered by the "Load more" button. */
  const loadMore = async () => {
    if (filesLoading || files.length >= filesTotal) return;
    setFilesLoading(true);
    try {
      const fs = await api<{ data: any[]; meta: { total: number } }>(
        buildListUrl(files.length),
      );
      setFiles((prev) => [
        ...prev,
        ...(fs.data ?? []).map((file) => ({
          key: file.key,
          size: file.size ?? 0,
          type: file.contentType ?? "application/octet-stream",
          folder: file.folderId ?? null,
          folderId: file.folderId ?? null,
          updated: file.uploadedAt ? String(file.uploadedAt).slice(0, 10) : "—",
          acl: (file.acl as "public" | "private") ?? "private",
          metadata: file.metadata ?? null,
        })),
      ]);
      setFilesTotal(fs.meta?.total ?? 0);
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setFilesLoading(false);
    }
  };

  // Folder-count badges — one server-side GROUP BY replaces the previous
  // O(files × depth) client computation. Refresh after the user uploads,
  // deletes, or moves a file (the relevant handlers call refreshCounts).
  const refreshCounts = async () => {
    try {
      const r = await api<{ root: number; byFolderId: Record<string, number>; total: number }>(
        "/api/storage/folder-counts",
      );
      setFolderCounts(r);
    } catch {
      // leave previous snapshot in place
    }
  };
  useEffect(() => { void refreshCounts(); }, []);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [w, setW] = useState(800);
  // `null` = "match source aspect" — CF/Bun derive height from width. Setting
  // an explicit number makes the transform behave as an aspect crop (with
  // fit=cover + focal). Decoupled state so the slider can be hidden until
  // the user actually wants to constrain height.
  const [h, setH] = useState<number | null>(null);
  const [q, setQ] = useState(80);
  const [fmt, setFmt] = useState("webp");
  const [fit, setFit] = useState("cover");
  const [focal, setFocal] = useState({ x: 50, y: 50 });
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [importUrlOpen, setImportUrlOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importKey, setImportKey] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dropFileInputRef = useRef<HTMLInputElement | null>(null);

  const folderTree = useMemo(() => {
    const root: any = { name: "", children: new Map(), folder: null, depth: -1 };
    const all = [...folders].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of all) {
      const parts = f.name.split("/");
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join("/");
        if (!node.children.has(parts[i])) {
          node.children.set(parts[i], { name: parts[i], path, children: new Map(), folder: null, depth: i });
        }
        node = node.children.get(parts[i]);
        if (i === parts.length - 1) node.folder = f;
      }
    }
    const flatten = (node: any, out: any[]): any[] => {
      const kids = [...node.children.values()].sort((a: any, b: any) => a.name.localeCompare(b.name));
      for (const k of kids) {
        out.push(k);
        if (!collapsed.has(k.path) && k.children.size) flatten(k, out);
      }
      return out;
    };
    return flatten(root, []);
  }, [folders, collapsed]);

  const folderTreeFiltered = useMemo(() => {
    if (!folderQuery.trim()) return folderTree;
    const q2 = folderQuery.toLowerCase();
    return folderTree.filter((n: any) => n.path.toLowerCase().includes(q2));
  }, [folderTree, folderQuery]);

  const toggleCollapse = (path: string) => {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  };

  // Server-paginated: `files` already holds the right page for the current
  // (folder, search) selection. No client-side filtering — `visible` and
  // `files` are the same array. Kept as a local alias so the JSX below
  // doesn't have to change.
  const visible = files;

  /** Per-folder-path counts derived from the server's GROUP BY response.
   *  We still roll descendants up to ancestors in the path tree so a virtual
   *  parent like "marketing" can report the sum of "marketing/q1" + "…/q2"
   *  even though no folder row literally named "marketing" exists. */
  const folderCountByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const fl of folders) {
      const n = folderCounts.byFolderId[fl.id] ?? 0;
      if (n === 0) continue;
      const parts = fl.name.split("/");
      for (let i = 0; i < parts.length; i++) {
        const p = parts.slice(0, i + 1).join("/");
        counts.set(p, (counts.get(p) ?? 0) + n);
      }
    }
    return counts;
  }, [folders, folderCounts]);

  const selected = files.find((f) => f.key === selectedKey) || null;
  const fmtSize = (b: number) => b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + " MB" : (b / 1024).toFixed(1) + " KB";
  const isImage = (t: string) => Boolean(t && t.startsWith("image/"));

  /** Start an XHR PUT for a single File and return its job, attaching the
   *  XHR so the row can cancel mid-flight. Progress comes from
   *  `xhr.upload.onprogress` — real bytes transferred, not a fake interval. */
  const startUpload = (f: File, target: string, idx: number): UploadJob => {
    const id = "up_" + Date.now() + "_" + idx;
    const key = `${target}/${f.name}`;
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/storage/${encodeURIComponent(key)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", f.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
      setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, progress: pct } : u)));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, progress: 100, status: "done", xhr: undefined } : u)));
        setFiles((fs) => [
          { key, size: f.size, type: f.type || "application/octet-stream", folder: target, folderId: null, updated: "just now", acl: "private", metadata: null },
          ...fs,
        ]);
        setFilesTotal((n) => n + 1);
        void refreshCounts();
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j?.error?.message) msg = j.error.message;
        } catch { /* keep status line */ }
        setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, status: "failed", error: msg, xhr: undefined } : u)));
        pushToast?.(t`${f.name}: ${msg}`);
      }
    });
    xhr.addEventListener("error", () => {
      setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, status: "failed", error: t`network error`, xhr: undefined } : u)));
      pushToast?.(t`${f.name}: network error`);
    });
    xhr.addEventListener("abort", () => {
      setUploads((arr) => arr.filter((u) => u.id !== id));
    });
    xhr.send(f);
    return {
      id,
      name: f.name,
      size: f.size,
      type: f.type || "application/octet-stream",
      progress: 0,
      status: "uploading",
      xhr,
    };
  };

  const queueUploads = (list: File[]) => {
    if (list.length === 0) return;
    const target = folder || "uploads";
    const jobs = list.map((f, i) => startUpload(f, target, i));
    setUploads((arr) => [...jobs, ...arr.filter((u) => u.status === "uploading")]);
    pushToast(t`${jobs.length} ${jobs.length === 1 ? "file" : "files"} queued for ${target}/.`);
  };

  /** Cancel an in-flight upload — aborts the XHR; the abort handler clears
   *  the row. Already-done or already-failed jobs ignore. */
  const cancelUpload = (id: string) => {
    setUploads((arr) => {
      const job = arr.find((u) => u.id === id);
      if (job?.xhr) job.xhr.abort();
      return arr;
    });
  };

  const onDrop = (e: any) => {
    e.preventDefault();
    setDragOver(false);
    const list = Array.from(e.dataTransfer?.files || []) as File[];
    if (list.length > 0) queueUploads(list);
  };

  const openNewFolder = () => {
    setNewFolderName("");
    setNewFolderOpen(true);
    setTimeout(() => newFolderInputRef.current?.focus(), 30);
  };

  const submitNewFolder = async () => {
    const raw = newFolderName.trim();
    if (!raw) return;
    const clean = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (folders.some((f) => f.name === clean)) {
      pushToast(t`Folder "${clean}" already exists.`);
      return;
    }
    setNewFolderBusy(true);
    try {
      const res = await api<{ data: { id: string; name: string } }>("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: clean }),
      });
      setFolders((arr) => [...arr, { id: res.data.id, name: clean, count: 0, public: false }]);
      pushToast(t`Folder "${clean}" created.`);
      setNewFolderOpen(false);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setNewFolderBusy(false);
    }
  };

  const submitImportUrl = async () => {
    const url = importUrl.trim();
    if (!url) {
      setImportError(t`URL is required.`);
      return;
    }
    setImportBusy(true);
    setImportError(null);
    try {
      const res = await api<{ data: { key: string; size: number; contentType?: string; folderId: string | null; acl?: string } }>(
        "/api/storage/from-url",
        {
          method: "POST",
          body: JSON.stringify({
            url,
            key: importKey.trim() || undefined,
            // honor the currently-selected sidebar folder when the user
            // didn't override it via the (future) key path. null = root.
            folderId: folder == null ? null : (selectedFolderId ?? "__root__"),
          }),
        },
      );
      // Optimistic prepend so the new file shows up immediately.
      setFiles((fs) => [
        {
          key: res.data.key,
          size: res.data.size,
          type: res.data.contentType ?? "application/octet-stream",
          folder: res.data.folderId,
          folderId: res.data.folderId,
          updated: "just now",
          acl: (res.data.acl as "public" | "private") ?? "private",
          metadata: null,
        },
        ...fs,
      ]);
      setFilesTotal((n) => n + 1);
      pushToast(t`Imported ${res.data.key.split("/").pop() ?? res.data.key}.`);
      setImportUrlOpen(false);
      void refreshCounts();
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  const toggleACL = async (key: string) => {
    const next = files.find((x) => x.key === key)?.acl === "public" ? "private" : "public";
    setFiles((arr) => arr.map((f) => f.key === key ? { ...f, acl: next } : f));
    try {
      await api(`/api/storage/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify({ acl: next }),
      });
      pushToast(t`${key} → ${next}.`);
    } catch (e) {
      // revert on failure
      setFiles((arr) => arr.map((f) => f.key === key ? { ...f, acl: next === "public" ? "private" : "public" } : f));
      pushToast((e as Error).message);
    }
  };

  /**
   * Generic patch helper used by the edit modal for metadata + folder moves.
   * Optimistic — applies `next` to local state immediately and reverts on
   * server failure. Metadata is sent as a merge patch (server merges per
   * key), so callers pass only the keys they want to change.
   */
  const patchFile = async (
    key: string,
    next: { folderId?: string | null; metadata?: FileMetadata | null },
  ): Promise<boolean> => {
    const prev = files.find((x) => x.key === key);
    if (!prev) return false;
    setFiles((arr) =>
      arr.map((f) => {
        if (f.key !== key) return f;
        const updated: StoredFile = { ...f };
        if (next.folderId !== undefined) {
          updated.folderId = next.folderId;
          updated.folder = next.folderId;
        }
        if (next.metadata !== undefined) {
          if (next.metadata === null) updated.metadata = null;
          else {
            const merged: FileMetadata = { ...(f.metadata ?? {}) };
            for (const [k, v] of Object.entries(next.metadata)) {
              if (v === null) delete merged[k];
              else merged[k] = v as unknown;
            }
            updated.metadata = Object.keys(merged).length ? merged : null;
          }
        }
        return updated;
      }),
    );
    try {
      await api(`/api/storage/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify(next),
      });
      // Folder move changes the count breakdown — refresh sidebar badges.
      if (next.folderId !== undefined) void refreshCounts();
      return true;
    } catch (e) {
      // revert
      setFiles((arr) => arr.map((f) => (f.key === key ? prev : f)));
      pushToast((e as Error).message);
      return false;
    }
  };

  const deleteFile = async (key: string) => {
    setFiles((arr) => arr.filter((x) => x.key !== key));
    setFilesTotal((n) => Math.max(0, n - 1));
    if (selectedKey === key) { setSelectedKey(null); setDetailOpen(false); }
    try {
      await api(`/api/storage/${encodeURIComponent(key)}`, { method: "DELETE" });
      pushToast(t`${key} deleted.`);
      void refreshCounts();
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const openDetail = (key: string) => {
    setSelectedKey(key);
    setDetailOpen(true);
  };

  // The page header used to sum bytes across `files`, but with pagination
  // `files` only holds the current page — that number would mislead. The
  // total count comes from the folder-counts endpoint; per-tenant byte
  // total isn't computed server-side yet, so we display files-only here.

  return (
    <div className="flex flex-col gap-[18px]" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }} onDrop={onDrop}>
      <PageHeader
        title={<Trans>Storage</Trans>}
        description={<Trans>Adapter auto-selected: R2 binding → R2; S3 env vars → S3; else local filesystem (Bun dev). Public folders are served at <span className="font-mono">/storage/&lt;key&gt;</span>; private require a signed URL.</Trans>}
        badges={<span className="ml-1 inline-flex gap-1.5">
          <Badge variant="outline" mono><Trans>{folderCounts.total} files</Trans></Badge>
        </span>}
        actions={<>
          <Button variant="outline" icon={I.Folder} onClick={openNewFolder}><Trans>New folder</Trans></Button>
          <Button variant="outline" icon={I.Globe} onClick={() => { setImportUrlOpen(true); setImportUrl(""); setImportKey(""); setImportError(null); }}><Trans>Import URL</Trans></Button>
          <Button variant="primary" icon={I.Plus} onClick={() => fileInputRef.current?.click()}><Trans>Upload</Trans></Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => queueUploads(Array.from(e.target.files || []))} />
        </>}
      />

      <div
        className={`flex cursor-pointer items-center gap-3.5 rounded-2xl border-[1.5px] bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] px-[18px] py-4 transition-all duration-[120ms] hover:bg-muted ${
          dragOver
            ? "scale-[1.005] border-solid border-primary bg-muted"
            : "border-dashed border-border hover:border-[color-mix(in_oklch,var(--primary)_50%,var(--border))]"
        }`}
        onClick={() => dropFileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
      >
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-primary">
          <I.Upload size={20} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-[13.5px] font-medium">
            <Trans>Drop files to upload — or <span className="text-primary underline [text-decoration-thickness:1px] underline-offset-2">browse</span></Trans>
          </div>
          <div className="text-xs text-muted-foreground">
            <Trans>Target folder: <span className="font-mono text-foreground">{folder || "uploads"}/</span> · max 100 MB per file · jpeg, png, webp, avif transformed on the fly</Trans>
          </div>
        </div>
        <div className="flex-1" />
        <span className="rounded-full border border-border bg-card px-2 py-[3px] font-mono text-[11px] text-muted-foreground">⌘V to paste</span>
        <input ref={dropFileInputRef} type="file" multiple className="hidden" onChange={(e) => queueUploads(Array.from(e.target.files || []))} />
      </div>

      {uploads.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <I.Activity size={14} />
            <span className="text-[13px] font-medium"><Trans>Uploads</Trans></span>
            <span className="font-mono text-[11.5px] text-muted-foreground">
              <Trans>{uploads.filter((u) => u.status === "done").length} / {uploads.length} complete</Trans>
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setUploads((arr) => arr.filter((u) => u.status === "uploading"))}><Trans>Clear done</Trans></Button>
          </div>
          <div className="flex max-h-[180px] flex-col gap-2 overflow-auto px-3.5 py-2">
            {uploads.map((u) => {
              const isDone = u.status === "done";
              const isFailed = u.status === "failed";
              const isUploading = u.status === "uploading";
              const barColor = isFailed
                ? "var(--destructive)"
                : isDone
                  ? "oklch(0.7 0.18 145)"
                  : "var(--primary)";
              const pctColor = isFailed
                ? "var(--destructive)"
                : isDone
                  ? "oklch(0.55 0.16 145)"
                  : "var(--muted-foreground)";
              return (
                <div key={u.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs sm:grid sm:grid-cols-[16px_1fr_70px_60px_24px]">
                  {isDone
                    ? <I.Check size={13} className="text-[oklch(0.55_0.16_145)]" />
                    : isFailed
                      ? <I.AlertTriangle size={13} className="text-destructive" />
                      : <I.Upload size={13} className="text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{u.name}</div>
                    <div className="mt-1 h-1 overflow-hidden rounded-sm bg-muted">
                      <div className="h-full transition-[width] duration-200" style={{ width: `${isFailed ? 100 : u.progress}%`, background: barColor }} />
                    </div>
                    {isFailed && u.error && (
                      <div className="mt-[3px] truncate text-[11px] text-destructive">{u.error}</div>
                    )}
                  </div>
                  <span className="text-right text-[11.5px] tabular-nums text-muted-foreground">{fmtSize(u.size)}</span>
                  <span className="text-right text-[11.5px] tabular-nums" style={{ color: pctColor }}>
                    {isFailed ? <Trans>failed</Trans> : `${Math.round(u.progress)}%`}
                  </span>
                  {isUploading ? (
                    <ShadButton
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => cancelUpload(u.id)}
                      title={t`Cancel upload`}
                      aria-label={t`Cancel upload`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <I.X size={12} />
                    </ShadButton>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup>
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t`Search keys…`} />
        </InputGroup>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {folder ? <Trans>in <span className="text-foreground">{folder}/</span></Trans> : <Trans>all folders</Trans>} · {filesTotal} <Trans>files</Trans>{filesTotal > files.length ? <> · <Trans>showing {files.length}</Trans></> : null}
        </span>
        <div className="flex-1" />
        {(["grid", "list"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-3xl border bg-card px-[11px] text-[12.5px] text-foreground hover:bg-accent ${
              view === v ? "border-[color-mix(in_oklch,var(--foreground)_22%,var(--border))] bg-accent" : "border-border"
            }`}
            onClick={() => setView(v)}
          >
            {v === "grid" ? <I.Braces size={12} /> : <I.Inbox size={12} />} {v === "grid" ? <Trans>Grid</Trans> : <Trans>List</Trans>}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <div className="sticky top-3 flex max-h-[calc(100vh-160px)] flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground max-[900px]:static max-[900px]:max-h-none">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <I.Folder size={13} />
            <span className="text-[12.5px] font-medium"><Trans>Folders</Trans></span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{folders.length}</span>
            <div className="flex-1" />
            <IconButton icon={I.Plus} title={t`New folder`} onClick={openNewFolder} />
          </div>
          <div className="border-b border-border px-2.5 pb-1.5 pt-2">
            <InputGroup className="h-8">
              <InputGroupAddon><I.Search size={12} /></InputGroupAddon>
              <InputGroupInput value={folderQuery} onChange={(e) => setFolderQuery(e.target.value)} placeholder={t`Filter folders…`} className="text-xs" />
            </InputGroup>
          </div>
          <div className="flex-1 overflow-y-auto px-1.5 pb-2 pt-1.5 max-[900px]:max-h-[320px]">
            <button
              type="button"
              className={`flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 py-1.5 pl-2.5 pr-2 text-left text-[12.5px] text-foreground hover:bg-accent ${
                folder == null ? "bg-accent font-medium" : "bg-transparent"
              }`}
              onClick={() => setFolder(null)}
            >
              <I.Inbox size={12} />
              <span><Trans>All files</Trans></span>
              <span className={`ml-auto text-[11px] tabular-nums ${folder == null ? "text-foreground" : "text-muted-foreground"}`}>{folderCounts.total}</span>
            </button>
            {folderTreeFiltered.length === 0 && (
              <div className="px-2.5 py-3 text-[11.5px] text-muted-foreground">
                {folders.length === 0
                  ? <Trans>No folders yet. <button type="button" onClick={openNewFolder} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-primary underline">Create one</button>.</Trans>
                  : <Trans>No folders match.</Trans>}
              </div>
            )}
            {folderTreeFiltered.map((node: any) => {
              const hasKids = node.children.size > 0;
              const isOpen = !collapsed.has(node.path);
              const isActive = folder === node.path;
              return (
                <div
                  key={node.path}
                  className={`flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-[12.5px] text-foreground ${
                    isActive ? "bg-accent font-medium" : "bg-transparent"
                  }`}
                  style={{ paddingLeft: 8 + node.depth * 14 }}
                >
                  {hasKids ? (
                    <button type="button" className="inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); toggleCollapse(node.path); }} aria-label={t`Toggle`}>
                      <I.ChevronRight size={11} className={`transition-transform duration-100 ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                  ) : (
                    <span className="w-3.5" />
                  )}
                  <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[inherit] text-inherit" onClick={() => setFolder(node.path)}>
                    <I.Folder size={12} />
                    <span className="truncate">{node.name}</span>
                    {node.folder?.public && <span className="size-[5px] shrink-0 rounded-full bg-[oklch(0.7_0.18_145)]" title="public" />}
                    <span className={`ml-auto text-[11px] tabular-nums ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                      {folderCountByPath.get(node.path) ?? 0}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {view === "grid" ? (
            <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 p-3">
              {visible.length === 0 && filesLoading && (
                <>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <SkeletonCard key={`fs-${i}`} height={140} />
                  ))}
                </>
              )}
              {visible.length === 0 && !filesLoading && (
                <div className="col-span-full p-9 text-center text-[13px] text-muted-foreground">
                  <Trans>No files. Drop files anywhere on this page or use Upload.</Trans>
                </div>
              )}
              {visible.map((f) => (
                <FileTile
                  key={f.key}
                  f={f}
                  active={selectedKey === f.key}
                  onSelect={() => openDetail(f.key)}
                  onCopyUrl={(k) => {
                    const url = window.location.origin + "/api/storage/" + encodeURI(k);
                    navigator.clipboard?.writeText(url);
                    pushToast(t`URL copied: ${k.split("/").pop() ?? k}`);
                  }}
                />
              ))}
            </div>
            <PaginationFooter
              loaded={files.length}
              total={filesTotal}
              loading={filesLoading}
              onLoadMore={loadMore}
            />
            </>
          ) : (
            <>
            <Table className={ADMIN_TABLE_CLS}>
              <TableHeader>
                <TableRow>
                  <TableHead><Trans>Key</Trans></TableHead>
                  <TableHead className="w-[90px]"><Trans>Type</Trans></TableHead>
                  <TableHead className="w-[80px]"><Trans>ACL</Trans></TableHead>
                  <TableHead className="w-[90px] text-right"><Trans>Size</Trans></TableHead>
                  <TableHead className="w-[100px]"><Trans>Updated</Trans></TableHead>
                  <TableHead className="sticky right-0 w-[60px] bg-card" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && filesLoading && (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={`fl-${i}`}>
                      <TableCell><SkeletonCard height={16} /></TableCell>
                      <TableCell><SkeletonCard height={16} /></TableCell>
                      <TableCell><SkeletonCard height={16} /></TableCell>
                      <TableCell><SkeletonCard height={16} /></TableCell>
                      <TableCell><SkeletonCard height={16} /></TableCell>
                      <TableCell />
                    </TableRow>
                  ))
                )}
                {visible.map((f) => (
                  <TableRow
                    key={f.key}
                    data-selected={selectedKey === f.key}
                    onClick={() => openDetail(f.key)}
                    className="cursor-pointer data-[selected=true]:bg-[color-mix(in_oklch,var(--primary)_10%,var(--card))]"
                  >
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <FileGlyph f={f} size={20} />
                        <span className="truncate font-mono text-[12.5px]">{f.key}</span>
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline" mono>{f.type.split("/")[1]}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={f.acl === "public" ? "default" : "secondary"}>{f.acl}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtSize(f.size)}</TableCell>
                    <TableCell className="font-mono text-[11.5px] text-muted-foreground">{f.updated}</TableCell>
                    <TableCell className="sticky right-0 bg-card text-right" onClick={(e) => e.stopPropagation()}>
                      <IconButton icon={I.Trash} title={t`Delete`} onClick={() => deleteFile(f.key)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationFooter
              loaded={files.length}
              total={filesTotal}
              loading={filesLoading}
              onLoadMore={loadMore}
            />
            </>
          )}
        </div>
      </div>

      {detailOpen && selected && (
        <FileDetailModal
          f={selected}
          fmtSize={fmtSize}
          isImage={isImage(selected.type)}
          w={w} setW={setW} h={h} setH={setH} q={q} setQ={setQ} fmt={fmt} setFmt={setFmt}
          fit={fit} setFit={setFit}
          focal={focal} setFocal={setFocal}
          folders={folders}
          onPatch={(next) => patchFile(selected.key, next)}
          onToggleACL={() => toggleACL(selected.key)}
          onDelete={() => deleteFile(selected.key)}
          onCopy={(text: string) => { navigator.clipboard?.writeText(text); pushToast(t`Copied to clipboard.`); }}
          onClose={() => setDetailOpen(false)}
          pushToast={pushToast}
        />
      )}

      {newFolderOpen && (
        <Dialog open onOpenChange={(o) => { if (!o && !newFolderBusy) setNewFolderOpen(false); }}>
          <DialogContent className="w-[min(440px,92vw)] gap-4">
            <DialogHeader className="pr-12 text-left">
              <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>New folder</Trans></DialogTitle>
              <DialogDescription className="text-[13px] leading-normal">
                <Trans>Lowercase letters, digits, <span className="font-mono">_</span> and <span className="font-mono">-</span>. Use <span className="font-mono">/</span> in the name to nest under an existing folder.</Trans>
              </DialogDescription>
            </DialogHeader>
            <Input
              ref={newFolderInputRef}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void submitNewFolder(); }
                if (e.key === "Escape") { e.preventDefault(); setNewFolderOpen(false); }
              }}
              placeholder={t`drafts`}
              disabled={newFolderBusy}
              autoFocus
            />
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setNewFolderOpen(false)} disabled={newFolderBusy}><Trans>Cancel</Trans></Button>
              <Button variant="primary" size="sm" onClick={submitNewFolder} disabled={newFolderBusy || !newFolderName.trim()}>
                {newFolderBusy ? <Trans>Creating…</Trans> : <Trans>Create folder</Trans>}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {importUrlOpen && (
        <Dialog open onOpenChange={(o) => { if (!o && !importBusy) setImportUrlOpen(false); }}>
          <DialogContent className="w-[min(440px,92vw)] gap-4">
            <DialogHeader className="pr-12 text-left">
              <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Import from URL</Trans></DialogTitle>
              <DialogDescription className="text-[13px] leading-normal">
                <Trans>Server fetches the URL and stores it in this workspace. http/https only — private/internal hosts are rejected.</Trans>
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Source URL</Trans></label>
                <Input
                  value={importUrl}
                  onChange={(e) => { setImportUrl(e.target.value); setImportError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void submitImportUrl(); }
                    if (e.key === "Escape") { e.preventDefault(); setImportUrlOpen(false); }
                  }}
                  placeholder="https://example.com/photos/sunset.jpg"
                  disabled={importBusy}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                  <Trans>Save as <span className="text-[11px] text-muted-foreground">(optional)</span></Trans>
                </label>
                <Input
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value)}
                  placeholder={folder ? t`${folder}/<derived>` : t`Defaults to the URL's filename`}
                  disabled={importBusy}
                />
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>Leave blank to use the URL's last path segment. Slashes auto-create folders ({folder ? <>currently in <span className="font-mono">{folder}/</span></> : <>root by default</>}).</Trans>
                </span>
              </div>
              {importError && (
                <div className="rounded-md bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] px-2.5 py-2 text-xs text-destructive">
                  {importError}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setImportUrlOpen(false)} disabled={importBusy}><Trans>Cancel</Trans></Button>
              <Button variant="primary" size="sm" onClick={submitImportUrl} disabled={importBusy || !importUrl.trim()}>
                {importBusy ? <Trans>Importing…</Trans> : <Trans>Import</Trans>}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Build a thumbnail URL for a file. For public images on Workers (or any
 * runtime with a working transform path) we ask the API for an edge-
 * resized WebP — ~2 KB instead of the multi-megabyte original. Private
 * images fall back to the original URL because the transform path 422s
 * on Workers without R2_PUBLIC_BASE; serving the raw bytes is wasteful
 * but at least the thumbnail shows up. Non-image files don't get a URL.
 */
function thumbnailUrl(f: StoredFile, displayPx: number): string {
  const base = `/api/storage/${encodeURI(f.key)}`;
  if (f.acl !== "public") return base;
  // 2× DPR floor at 80px so even a 20px chip fetches sharp pixels on retina.
  const w = Math.max(80, Math.round(displayPx * 2));
  return `${base}?width=${w}&format=webp&quality=70&fit=cover`;
}

function FileGlyph({ f, size = 64 }: { f: StoredFile; size?: number }) {
  const isImg = Boolean(f.type && f.type.startsWith("image/"));
  const [imgFailed, setImgFailed] = useState(false);
  if (isImg && !imgFailed) {
    return (
      <img
        src={thumbnailUrl(f, typeof size === "number" ? size : 64)}
        alt=""
        loading="lazy"
        onError={() => setImgFailed(true)}
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          borderRadius: "var(--radius-md)",
          flexShrink: 0,
          display: "block",
          background: "var(--muted)",
        }}
      />
    );
  }
  if (isImg) {
    const hue = f.hue ?? 200;
    const px = typeof size === "number" ? size : 64;
    return (
      <div style={{ width: size, height: size, borderRadius: "var(--radius-md)", background: `linear-gradient(135deg, oklch(0.78 0.16 ${hue}) 0%, oklch(0.55 0.18 ${(hue + 60) % 360}) 100%)`, position: "relative", overflow: "hidden", flexShrink: 0 }}>
        <div style={{ position: "absolute", bottom: -px * 0.2, left: -px * 0.1, width: px * 0.6, height: px * 0.6, borderRadius: "50%", background: `oklch(0.92 0.12 ${(hue + 30) % 360} / 0.6)` }} />
        <div style={{ position: "absolute", top: px * 0.15, right: px * 0.15, width: px * 0.18, height: px * 0.18, borderRadius: "50%", background: "oklch(1 0 0 / 0.7)" }} />
      </div>
    );
  }
  const ext = (f.type || "").split("/")[1] || "file";
  const colorMap: Record<string, number> = { csv: 145, pdf: 22, markdown: 280, json: 50, plain: 200 };
  const hue = colorMap[ext] || 200;
  return (
    <div style={{ width: size, height: size, borderRadius: "var(--radius-md)", background: `oklch(0.96 0.02 ${hue})`, border: `1px solid oklch(0.85 0.05 ${hue})`, display: "grid", placeItems: "center", flexShrink: 0, fontFamily: "Geist Mono, monospace", fontSize: typeof size === "number" ? Math.max(8, size * 0.18) : 12, fontWeight: 600, color: `oklch(0.4 0.1 ${hue})`, textTransform: "uppercase" }}>
      {ext.slice(0, 4)}
    </div>
  );
}

function ImageMock({ hue = 200, focal, style = {} as CSSProperties }: { hue?: number; focal?: { x: number; y: number }; style?: CSSProperties }) {
  const fx = focal?.x ?? 50;
  const fy = focal?.y ?? 50;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", ...style }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, oklch(0.82 0.12 ${hue}) 0%, oklch(0.55 0.16 ${(hue + 50) % 360}) 100%)` }} />
      <div style={{ position: "absolute", left: `${fx}%`, top: `${fy}%`, width: "32%", height: "32%", transform: "translate(-50%, -50%)", borderRadius: "50%", background: `radial-gradient(circle, oklch(0.96 0.06 ${(hue + 30) % 360} / 0.85) 0%, oklch(0.96 0.06 ${(hue + 30) % 360} / 0) 70%)` }} />
    </div>
  );
}

function FileTile({ f, active, onSelect, onCopyUrl }: { f: StoredFile; active: boolean; onSelect: () => void; onCopyUrl: (key: string) => void }) {
  const { t } = useLingui();
  const isImg = Boolean(f.type && f.type.startsWith("image/"));
  const [imgFailed, setImgFailed] = useState(false);
  const sizeStr = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + " MB" : (f.size / 1024).toFixed(1) + " KB";
  const displayName = (f.metadata && typeof f.metadata.name === "string" && f.metadata.name.trim()) || (f.key.split("/").pop() ?? f.key);
  return (
    <div
      onClick={onSelect}
      className={`flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border transition-[background,border-color] duration-100 ${
        active ? "border-primary bg-[color-mix(in_oklch,var(--primary)_6%,transparent)]" : "border-border bg-card"
      }`}
    >
      <div className="relative aspect-[16/9] bg-muted">
        {isImg && !imgFailed ? (
          <img
            src={thumbnailUrl(f, 320)}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 block size-full object-cover"
          />
        ) : isImg ? (
          <ImageMock hue={f.hue ?? 200} />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <FileGlyph f={f} size={64} />
          </div>
        )}
        {f.acl === "public" && (
          <span
            className="absolute left-1.5 top-1.5 rounded-full bg-[oklch(0.25_0.04_145/0.85)] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[oklch(0.9_0.18_145)]"
            title="public"
          >
            public
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {displayName}
          </span>
          {/* Copy URL — uses the chain-link icon (the "<>" code glyph was
              misleading). Stops propagation so the detail modal stays
              closed. shadcn Button primitive, no raw <button>. */}
          <ShadButton
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={(e) => { e.stopPropagation(); onCopyUrl(f.key); }}
            title={t`Copy URL`}
            aria-label={t`Copy URL`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <LinkIcon className="size-3" />
          </ShadButton>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] tabular-nums text-muted-foreground">{sizeStr}</span>
          <span className="text-[10.5px] text-muted-foreground">·</span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {(f.type || "").split("/")[1] || "file"}
          </span>
        </div>
      </div>
    </div>
  );
}

function FileDetailModal({ f, onClose, ...rest }: any) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-[min(720px,92vw)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[14.5px] font-semibold tracking-[-0.01em]"><Trans>Edit file</Trans></DialogTitle>
            <DialogDescription className="mt-0.5 truncate font-mono text-xs">{f.key}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-0">
          <FileDetail f={f} {...rest} embedded />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileDetail({ f, fmtSize, isImage, w, setW, h, setH, q, setQ, fmt, setFmt, fit, setFit, focal, setFocal, folders, onPatch, onToggleACL, onDelete, onCopy, pushToast, embedded }: any) {
  const { t } = useLingui();
  const fileMeta: FileMetadata = (f.metadata as FileMetadata | null) ?? {};
  // Local edit buffer for the metadata section — flushed to the server via
  // onPatch when the user clicks Save. Re-syncs whenever the underlying
  // file changes (e.g. after a server-confirmed merge).
  const [metaName, setMetaName] = useState<string>(fileMeta.name ?? "");
  const [metaDescription, setMetaDescription] = useState<string>(fileMeta.description ?? "");
  const [metaTags, setMetaTags] = useState<string[]>(fileMeta.tags ?? []);
  const [metaTagDraft, setMetaTagDraft] = useState<string>("");
  const [metaAuthor, setMetaAuthor] = useState<string>(fileMeta.author ?? "");
  const [metaLocation, setMetaLocation] = useState<string>(fileMeta.location ?? "");
  const [metaSaving, setMetaSaving] = useState<boolean>(false);
  useEffect(() => {
    setMetaName(fileMeta.name ?? "");
    setMetaDescription(fileMeta.description ?? "");
    setMetaTags(fileMeta.tags ?? []);
    setMetaTagDraft("");
    setMetaAuthor(fileMeta.author ?? "");
    setMetaLocation(fileMeta.location ?? "");
    // f.key is the row identity; we only resync when the *file* changes,
    // not on every metadata update from the optimistic patch (otherwise
    // typing into the description would get wiped by our own save).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.key]);
  const metaDirty =
    (fileMeta.name ?? "") !== metaName ||
    (fileMeta.description ?? "") !== metaDescription ||
    JSON.stringify(fileMeta.tags ?? []) !== JSON.stringify(metaTags) ||
    (fileMeta.author ?? "") !== metaAuthor ||
    (fileMeta.location ?? "") !== metaLocation;

  const saveMeta = async () => {
    if (!onPatch || metaSaving) return;
    setMetaSaving(true);
    // null sentinel = remove the key on the server; empty string also clears.
    const patch: Record<string, unknown> = {
      name: metaName.trim() || null,
      description: metaDescription.trim() || null,
      tags: metaTags.length ? metaTags : null,
      author: metaAuthor.trim() || null,
      location: metaLocation.trim() || null,
    };
    const ok = await onPatch({ metadata: patch });
    setMetaSaving(false);
    if (ok) pushToast?.(t`Metadata saved.`);
  };

  const commitTagDraft = () => {
    const v = metaTagDraft.trim();
    if (!v) return;
    if (metaTags.includes(v)) { setMetaTagDraft(""); return; }
    setMetaTags([...metaTags, v]);
    setMetaTagDraft("");
  };

  const moveToFolder = async (folderId: string | null) => {
    if (!onPatch) return;
    const ok = await onPatch({ folderId });
    if (ok) pushToast?.(folderId ? t`Moved.` : t`Moved to root.`);
  };

  const url = `/api/storage/${encodeURI(f.key)}`;
  const params = isImage
    ? `?width=${w}${h != null ? `&height=${h}` : ""}&format=${fmt}&quality=${q}&fit=${fit}&focal=${focal.x},${focal.y}`
    : "";
  const transformedUrl = url + params;
  // Copying / signing produces URLs that travel outside the admin tab —
  // a chat message, an <img> on another site, a curl invocation. Relative
  // paths are fine for in-page <img>/HEAD/anchor download (browser resolves
  // them against the page origin) but useless once detached.
  const toAbsolute = (rel: string): string =>
    rel.startsWith("http") ? rel : window.location.origin + rel;

  // Probe the transform URL with a debounced HEAD. The response tells us
  // three things in one round-trip:
  //   - content-length → real transformed size for the readout
  //   - 422 → the runtime can't transform this file (private + Workers
  //     without an internal-fetch fallback). We swap <img src> back to
  //     the un-transformed URL so the preview keeps working and surface
  //     the server's hint in place of the size readout.
  //   - other non-2xx → silently drop the size; img onError handles it.
  //
  // Both fetches go through `cache: "no-store"` because the transformed
  // response carries `Cache-Control: immutable` for a year — the right
  // call for byte-addressed transforms, but wrong for this freshness
  // probe. Without it, toggling a file from public → private wouldn't
  // surface the new 422 until the year-long cache entry expired.
  const [transformedSize, setTransformedSize] = useState<number | null>(null);
  const [transformedLoading, setTransformedLoading] = useState(false);
  const [transformError, setTransformError] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) { setTransformedSize(null); setTransformError(null); return; }
    setTransformedLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(transformedUrl, { method: "HEAD", credentials: "include", cache: "no-store", signal: ctrl.signal });
        if (res.status === 422) {
          let msg = t`Transforms unavailable for this file on this runtime.`;
          try {
            const r2 = await fetch(transformedUrl, { credentials: "include", cache: "no-store", signal: ctrl.signal });
            const j = await r2.json().catch(() => null);
            if (j?.error?.message) msg = j.error.message;
          } catch {}
          setTransformError(msg);
          setTransformedSize(null);
          return;
        }
        setTransformError(null);
        if (!res.ok) { setTransformedSize(null); return; }
        const len = res.headers.get("content-length");
        setTransformedSize(len ? Number(len) : null);
      } catch {
        // AbortError on re-trigger is expected; everything else just clears.
      } finally {
        setTransformedLoading(false);
      }
    }, 300);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [transformedUrl, isImage]);
  // When the runtime can't transform, the preview falls back to the raw
  // object so the user still sees their image.
  const effectiveSrc = transformError ? url : transformedUrl;

  const aspect = (isImage && f.w && f.h) ? f.h / f.w : 0.6;
  // When the user pins height, the label shows it verbatim; otherwise we
  // derive from the source aspect so the slider readout still makes sense.
  const previewH = h != null ? h : ((isImage && f.w) ? Math.round(w * aspect) : null);

  const Wrapper: any = embedded ? Fragment : "div";
  const wrapperProps: any = embedded ? {} : { className: "flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground" };

  /** Hit POST /api/storage/<key>/sign and return the relative signed URL. */
  const signOnce = async (ttlSeconds: number): Promise<string> => {
    const res = await api<{ url: string }>(
      `/api/storage/${encodeURI(f.key)}/sign`,
      { method: "POST", body: JSON.stringify({ ttlSeconds }) },
    );
    return res.url;
  };

  /** Append transform params to a signed URL — the server validates the
   *  token first then runs the transform path, so this stays one request.
   *  Skipped when the runtime can't transform this file (Workers + private
   *  + no internal-fetch fallback), in which case we sign the raw object. */
  const withTransformParams = (signed: string): string => {
    if (!params || transformError) return signed;
    return signed + (signed.includes("?") ? "&" : "?") + params.slice(1);
  };

  const onDownload = async () => {
    try {
      const href = f.acl === "public"
        ? effectiveSrc
        : withTransformParams(await signOnce(60));
      const a = document.createElement("a");
      a.href = href;
      a.download = f.key.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const onSignUrl = async () => {
    try {
      const signed = await signOnce(3600);
      onCopy(toAbsolute(withTransformParams(signed)));
      pushToast?.(t`Signed URL copied (1h).`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <span className="text-[13px] font-medium"><Trans>File detail</Trans></span>
          <div className="flex-1" />
          <IconButton icon={I.Trash} title={t`Delete`} onClick={onDelete} />
        </div>
      )}

      <div
        className="relative grid aspect-[16/9] place-items-center overflow-hidden"
        onClick={(e) => {
          if (!isImage) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * 100;
          const y = ((e.clientY - r.top) / r.height) * 100;
          setFocal({ x: Math.round(x), y: Math.round(y) });
        }}
        style={{ background: "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%) 50% / 16px 16px", cursor: isImage ? "crosshair" : "default" }}
      >
        {isImage ? (
          <>
            <img
              key={effectiveSrc}
              src={effectiveSrc}
              alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              className="absolute inset-0 block size-full bg-muted"
              style={{ objectFit: fit === "contain" ? "contain" : "cover" }}
            />
            <div
              className="pointer-events-none absolute grid size-[18px] place-items-center rounded-full border-2 border-[oklch(0.55_0.22_22)] bg-white shadow-[0_2px_6px_oklch(0_0_0/0.4)]"
              style={{ left: `calc(${focal.x}% - 1px)`, top: `calc(${focal.y}% - 1px)` }}
            >
              <span className="size-1 rounded-full bg-[oklch(0.55_0.22_22)]" />
            </div>
            <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-[oklch(0_0_0/0.6)] px-2 py-[3px] font-mono text-[10.5px] tracking-[0.04em] text-white">{fmt} · {w}{previewH ? `×${previewH}` : ""}</div>
          </>
        ) : (
          <div className="relative flex flex-col items-center gap-1.5 text-muted-foreground">
            <FileGlyph f={f} size={64} />
            <span className="font-mono text-[11.5px]">{f.type}</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 p-3.5 text-[12.5px]">
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Key</Trans></span>
          <span className="break-all font-mono text-xs">{f.key}</span>
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Size</Trans></div>
            <div className="font-medium tabular-nums">{fmtSize(f.size)}</div>
          </div>
          {isImage && f.w && (
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Dim</Trans></div>
              <div className="font-mono text-[11.5px] tabular-nums">{f.w}×{f.h}</div>
            </div>
          )}
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Updated</Trans></div>
            <div className="font-mono text-[11.5px]">{f.updated}</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div>
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
              {f.acl === "public" ? <I.Eye size={12} /> : <I.Shield size={12} />}
              {f.acl === "public" ? <Trans>Public</Trans> : <Trans>Private</Trans>}
            </div>
            <div className="text-[11.5px] text-muted-foreground">{f.acl === "public" ? <Trans>Anyone with the URL can fetch this file.</Trans> : <Trans>Requires a signed URL or auth cookie.</Trans>}</div>
          </div>
          <Switch checked={f.acl === "public"} onChange={onToggleACL} />
        </div>

        {/* Folder — DB-only move; key on disk is unchanged. */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
            <span className="flex items-center gap-1.5">
              <I.Folder size={12} /> <Trans>Folder</Trans>
            </span>
          </label>
          <FolderPicker
            folders={folders ?? []}
            value={f.folderId ?? null}
            onChange={(id) => moveToFolder(id)}
          />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Logical grouping in the DB. The object's storage key doesn't change.</Trans></span>
        </div>

        {/* Metadata — free-form bag stored in files.metadata jsonb. */}
        <div className="flex flex-col gap-2.5 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <I.Hash size={13} />
            <span className="text-xs font-medium uppercase tracking-[0.06em]"><Trans>Metadata</Trans></span>
            <div className="flex-1" />
            {metaDirty && <Badge variant="outline" mono><Trans>unsaved</Trans></Badge>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
            <Input
              value={metaName}
              onChange={(e) => setMetaName(e.target.value)}
              placeholder={f.key.split("/").pop()}
            />
            <span className="text-[11.5px] text-muted-foreground"><Trans>Display label. The storage key stays <span className="font-mono">{f.key}</span>.</Trans></span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Description</Trans></label>
            <Textarea
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              placeholder={t`What this file is about…`}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Tags</Trans></label>
            <div className="mb-1.5 flex flex-wrap gap-1">
              {metaTags.map((tag) => (
                <span key={tag} className="inline-flex h-7 items-center gap-1 rounded-3xl border border-border bg-card px-[11px] text-[12.5px] text-foreground">
                  <span className="font-mono">{tag}</span>
                  <ShadButton
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setMetaTags(metaTags.filter((t) => t !== tag))}
                    title={t`Remove tag`}
                    aria-label={t`Remove tag ${tag}`}
                    className="size-4 text-muted-foreground hover:text-foreground"
                  >
                    <I.X size={10} />
                  </ShadButton>
                </span>
              ))}
              {metaTags.length === 0 && <span className="text-[11.5px] text-muted-foreground"><Trans>No tags yet.</Trans></span>}
            </div>
            <Input
              value={metaTagDraft}
              onChange={(e) => setMetaTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTagDraft(); }
                if (e.key === "Backspace" && metaTagDraft === "" && metaTags.length > 0) {
                  setMetaTags(metaTags.slice(0, -1));
                }
              }}
              onBlur={commitTagDraft}
              placeholder={t`Add a tag and press Enter…`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Author</Trans></label>
            <Input
              value={metaAuthor}
              onChange={(e) => setMetaAuthor(e.target.value)}
              placeholder={t`Photographer, designer, source…`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Location</Trans></label>
            <Input
              value={metaLocation}
              onChange={(e) => setMetaLocation(e.target.value)}
              placeholder={t`Istanbul, Turkey`}
            />
          </div>

          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMetaName(fileMeta.name ?? "");
                setMetaDescription(fileMeta.description ?? "");
                setMetaTags(fileMeta.tags ?? []);
                setMetaTagDraft("");
                setMetaAuthor(fileMeta.author ?? "");
                setMetaLocation(fileMeta.location ?? "");
              }}
              disabled={!metaDirty || metaSaving}
            >
              <Trans>Discard</Trans>
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={saveMeta}
              disabled={!metaDirty || metaSaving}
            >
              {metaSaving ? <Trans>Saving…</Trans> : <Trans>Save metadata</Trans>}
            </Button>
          </div>
        </div>

        {isImage && (
          <>
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <I.Sliders size={13} />
                <span className="text-xs font-medium uppercase tracking-[0.06em]"><Trans>Transform</Trans></span>
                <div className="flex-1" />
                <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline" onClick={() => { setW(f.w || 1600); setH(null); setQ(80); setFmt("webp"); setFit("cover"); setFocal({ x: 50, y: 50 }); }}><Trans>Reset</Trans></button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                  <Trans>Width</Trans>
                  <span className="tabular-nums text-muted-foreground">{w}px {f.w && <span className="opacity-60">· {Math.round((w / f.w) * 100)}%</span>}</span>
                </label>
                <div className="flex items-center gap-2">
                  <input type="range" min={120} max={Math.max(1600, f.w || 1600)} step={20} value={w} onChange={(e) => setW(Number(e.target.value))} className="flex-1" />
                </div>
                <div className="mt-1.5 flex gap-1">
                  {[256, 512, 800, 1200, 1600].map((preset) => (
                    <button key={preset} className={cn(SIZE_CHIP_BASE, (w === preset) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setW(preset)}>{preset}</button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                  <Trans>Height</Trans>
                  <span className="tabular-nums text-muted-foreground">
                    {h != null ? `${h}px` : t`auto`}
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={120}
                    max={Math.max(1600, f.h || 1600)}
                    step={20}
                    value={h ?? Math.round(w * aspect)}
                    onChange={(e) => setH(Number(e.target.value))}
                    className="flex-1"
                    disabled={h == null}
                    aria-disabled={h == null}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <button className={cn(SIZE_CHIP_BASE, (h == null) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(null)} title={t`Derive from width × source aspect`}><Trans>auto</Trans></button>
                  <button className={cn(SIZE_CHIP_BASE, (h === w) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(w)} title={t`1:1 square`}>1:1</button>
                  <button className={cn(SIZE_CHIP_BASE, (h === Math.round(w * 9 / 16)) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(Math.round(w * 9 / 16))} title={t`16:9 widescreen`}>16:9</button>
                  <button className={cn(SIZE_CHIP_BASE, (h === Math.round(w * 5 / 4)) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(Math.round(w * 5 / 4))} title={t`4:5 portrait`}>4:5</button>
                  <button className={cn(SIZE_CHIP_BASE, (h === Math.round(w * 2 / 3)) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(Math.round(w * 2 / 3))} title={t`3:2 standard`}>3:2</button>
                </div>
                <span className="text-[11.5px] text-muted-foreground">
                  {h == null
                    ? <Trans>Auto = preserve source aspect. Pin height to crop to a different aspect (uses Focal point + fit=cover).</Trans>
                    : <Trans>Aspect-cropping active. Focal point picks which area is kept.</Trans>}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Quality</Trans> <span className="tabular-nums text-muted-foreground">{q}</span></label>
                <input type="range" min={10} max={100} step={5} value={q} onChange={(e) => setQ(Number(e.target.value))} className="w-full" />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Format</Trans></label>
                <div className="inline-flex w-full divide-x divide-border overflow-hidden rounded-md border border-border bg-card">
                  {[
                    { v: "webp", save: "−45%" },
                    { v: "avif", save: "−60%" },
                    { v: "jpeg", save: "0%" },
                    { v: "png", save: "+lossless" },
                  ].map((o) => (
                    <button key={o.v} type="button" className={cn(SEG_BTN_BASE, fmt === o.v ? SEG_BTN_ON : SEG_BTN_OFF)} onClick={() => setFmt(o.v)}>
                      <span className="font-mono">{o.v}</span>
                      <span className="ml-1 text-[10px] opacity-70">{o.save}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Fit</Trans></label>
                <div className="inline-flex w-full divide-x divide-border overflow-hidden rounded-md border border-border bg-card">
                  {["cover", "contain"].map((o) => (
                    <button key={o} type="button" className={cn(SEG_BTN_BASE, fit === o ? SEG_BTN_ON : SEG_BTN_OFF)} onClick={() => setFit(o)}><span className="font-mono">{o}</span></button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Focal point</Trans> <span className="font-mono text-muted-foreground">{focal.x}, {focal.y}</span></label>
                <div className="relative aspect-[16/9] w-full cursor-crosshair overflow-hidden rounded-md border border-border" onClick={(e: any) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setFocal({ x: Math.round(((e.clientX - r.left) / r.width) * 100), y: Math.round(((e.clientY - r.top) / r.height) * 100) });
                }}>
                  <img
                    src={`/api/storage/${encodeURI(f.key)}`}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    className="absolute inset-0 block size-full bg-muted object-cover"
                  />
                  <div className="absolute inset-0 [background-image:linear-gradient(to_right,oklch(1_0_0/0.3)_1px,transparent_1px),linear-gradient(to_bottom,oklch(1_0_0/0.3)_1px,transparent_1px)] [background-size:33.33%_33.33%]">
                    {[0, 1, 2].map((row) => (
                      [0, 1, 2].map((col) => {
                        const x = col * 50; const y = row * 50;
                        return <button key={`${row}-${col}`} className={cn("absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-[1.5px] p-0", focal.x === x && focal.y === y ? "border-white bg-[oklch(0.55_0.22_22)]" : "border-[oklch(0_0_0/0.4)] bg-[oklch(1_0_0/0.6)] hover:bg-white")} style={{ left: `${x}%`, top: `${y}%` }} onClick={(e: any) => { e.stopPropagation(); setFocal({ x, y }); }} title={`${x},${y}`} />;
                      })
                    ))}
                    <div className="pointer-events-none absolute grid size-[18px] place-items-center rounded-full border-2 border-[oklch(0.55_0.22_22)] bg-white shadow-[0_2px_6px_oklch(0_0_0/0.4)]" style={{ left: `calc(${focal.x}% - 1px)`, top: `calc(${focal.y}% - 1px)` }}><span className="size-1 rounded-full bg-[oklch(0.55_0.22_22)]" /></div>
                  </div>
                </div>
                <span className="text-[11.5px] text-muted-foreground"><Trans>Click anywhere to set the crop pivot for <span className="font-mono">fit=cover</span>.</Trans></span>
              </div>
            </div>

            {transformError ? (
              <div
                className="flex items-start gap-2 rounded-md border border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3 py-2.5 text-xs"
                role="alert"
              >
                <I.Shield size={14} className="mt-0.5 shrink-0 text-[oklch(0.65_0.16_50)]" />
                <div className="min-w-0">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Transform unavailable</Trans></div>
                  <div className="text-xs leading-[1.4]">{transformError}</div>
                  <div className="mt-1 text-[11.5px] text-muted-foreground">
                    <Trans>Showing the original above. Toggle <span className="font-mono">Public</span> to enable edge resizing for this file.</Trans>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 rounded-md border border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3 py-2.5 text-xs">
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Original</Trans></div>
                  <div className="tabular-nums">{fmtSize(f.size)}</div>
                </div>
                <I.ChevronRight size={14} className="text-muted-foreground" />
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Transformed</Trans></div>
                  <div className="font-medium tabular-nums" style={{ color: transformedSize != null ? "oklch(0.55 0.16 145)" : "var(--muted-foreground)" }}>
                    {transformedLoading ? "…" : transformedSize != null ? fmtSize(transformedSize) : "—"}
                  </div>
                </div>
                <div className="flex-1" />
                {transformedSize != null && (
                  <Badge variant="outline" mono><Trans>{Math.round((1 - transformedSize / f.size) * 100)}% smaller</Trans></Badge>
                )}
              </div>
            )}
          </>
        )}

        <div className="whitespace-pre-wrap break-words rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-2.5 font-mono text-[11px] leading-normal text-[oklch(from_var(--primary)_0.95_0.02_h)]">
          <span className="text-[oklch(0.78_0.18_95)]">GET</span> <span className="text-foreground">{url}</span>{params && <span className="text-muted-foreground">{params}</span>}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" icon={I.Code} onClick={() => onCopy(toAbsolute(effectiveSrc))}><Trans>Copy URL</Trans></Button>
          {f.acl === "private" && <Button size="sm" variant="outline" icon={I.Shield} onClick={onSignUrl}><Trans>Sign URL</Trans></Button>}
          <Button size="sm" variant="outline" icon={I.Download} onClick={onDownload}><Trans>Download</Trans></Button>
        </div>
      </div>
    </Wrapper>
  );
}


/**
 * Searchable folder picker — shadcn Popover + Command pattern. Filters the
 * local list as the user types (no remote call; folders are already loaded
 * for the sidebar). Selecting an item fires `onChange` and closes the
 * popover. Sentinel "" value means "no folder" (root).
 */
function FolderPicker({ folders, value, onChange }: { folders: { id: string; name: string }[]; value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const current = folders.find((f) => f.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ShadButton
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {current ? current.name : <Trans>— None (root) —</Trans>}
          </span>
          <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
        </ShadButton>
      </PopoverTrigger>
      <PopoverContent
        // .dialog-backdrop sits at z-index: 70 (legacy admin.css). Popover's
        // default `z-50` would render the combobox content behind it — the
        // trigger looks broken because nothing visible happens on click. Pin
        // above the backdrop and any other modal scrim.
        className="z-[100] w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder={t`Search folders…`} />
          <CommandList>
            <CommandEmpty><Trans>No folders match.</Trans></CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__root__ none root"
                onSelect={() => { onChange(null); setOpen(false); }}
              >
                <CheckIcon className={cn("mr-2 size-4", value == null ? "opacity-100" : "opacity-0")} />
                <span className="text-muted-foreground"><Trans>— None (root) —</Trans></span>
              </CommandItem>
              {folders.map((fl) => (
                <CommandItem
                  key={fl.id}
                  value={fl.name}
                  onSelect={() => { onChange(fl.id); setOpen(false); }}
                >
                  <CheckIcon className={cn("mr-2 size-4", value === fl.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{fl.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}


/**
 * Pagination footer for the grid + list views. Renders nothing when there
 * is just one page worth of results; otherwise shows "Showing X of Y" plus
 * a Load more button. Single-button is intentional — we paginate forward
 * only, infinite-scroll style.
 */
function PaginationFooter({ loaded, total, loading, onLoadMore }: { loaded: number; total: number; loading: boolean; onLoadMore: () => void }) {
  const { t } = useLingui();
  const hasMore = loaded < total;
  if (total === 0) return null;
  if (!hasMore && !loading) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-t border-border px-3.5 py-3 text-xs">
      <span className="tabular-nums text-muted-foreground"><Trans>Showing {loaded} of {total}</Trans></span>
      {hasMore && (
        <Button size="sm" variant="outline" onClick={onLoadMore} disabled={loading}>
          {loading ? <Skeleton className="h-3.5 w-16" /> : <Trans>Load more</Trans>}
        </Button>
      )}
    </div>
  );
}
