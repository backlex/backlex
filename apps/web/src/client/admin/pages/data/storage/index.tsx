// Storage page shell (browser, uploads incl. TUS, bulk actions). Leaf
// components live in ./widgets; the directory preserves the ./storage path.
// Storage page — preview, batch upload progress, ACL, file detail modal
import type { PushToast } from "../../../types";
import { useEffect, useMemo, useRef, useState, } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import { Badge, Button, EmptyState, IconButton, PageHeader, } from "../../../ui";
import { Input } from "@backlex/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@backlex/ui/components/input-group";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Button as ShadButton } from "@backlex/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { api } from "@/lib/api";
import { useUrlState } from "@/lib/use-url-state";
import { Card } from "@backlex/ui/components/card";
import { SkeletonCard } from "../../../loading";

import {
  ADMIN_TABLE_CLS,
  FileMetadata,
  PAGE_SIZE,
  RESUMABLE_THRESHOLD,
  StoredFile,
  StoredFolder,
  TUS_CHUNK,
  UploadJob,
  tusKey,
  tusMeta,
} from "./shared";
import {
  FileDetailModal,
  FileGlyph,
  FileTile,
  PaginationFooter,
} from "./widgets";

export function StoragePage({ pushToast }: { pushToast: PushToast }) {
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

  /** Resumable (TUS) upload for large files: POST init (or resume a stored
   *  session), then PATCH 8 MiB chunks from the server's committed offset.
   *  The session Location is stashed in localStorage so re-dropping the same
   *  file after a reload continues instead of restarting. */
  const startResumableUpload = (f: File, target: string, idx: number): UploadJob => {
    const id = "up_" + Date.now() + "_" + idx;
    const key = `${target}/${f.name}`;
    const controller = new AbortController();
    const setProgress = (pct: number) =>
      setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, progress: pct } : u)));
    const fail = (msg: string) => {
      localStorage.removeItem(tusKey(f));
      setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, status: "failed", error: msg, controller: undefined } : u)));
      pushToast?.(t`${f.name}: ${msg}`);
    };

    void (async () => {
      try {
        const headOffset = async (loc: string): Promise<number | null> => {
          const r = await fetch(loc, {
            method: "HEAD",
            credentials: "include",
            headers: { "Tus-Resumable": "1.0.0" },
            signal: controller.signal,
          });
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return Number(r.headers.get("Upload-Offset") ?? "0");
        };

        // Resume a stored session for this exact file, or create a new one.
        let location = localStorage.getItem(tusKey(f));
        let offset = 0;
        if (location) {
          const o = await headOffset(location);
          if (o == null) location = null; // session expired/gone → recreate
          else offset = o;
        }
        if (!location) {
          const meta = [tusMeta("key", key)];
          if (f.type) meta.push(tusMeta("contentType", f.type));
          const init = await fetch("/api/uploads", {
            method: "POST",
            credentials: "include",
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Length": String(f.size),
              "Upload-Metadata": meta.join(","),
            },
            signal: controller.signal,
          });
          if (!init.ok) throw new Error(`HTTP ${init.status}`);
          location = init.headers.get("Location");
          if (!location) throw new Error("no Location");
          localStorage.setItem(tusKey(f), location);
        }

        let retries = 0;
        while (offset < f.size) {
          const end = Math.min(offset + TUS_CHUNK, f.size);
          try {
            const r = await fetch(location, {
              method: "PATCH",
              credentials: "include",
              headers: {
                "Tus-Resumable": "1.0.0",
                "Upload-Offset": String(offset),
                "content-type": "application/offset+octet-stream",
              },
              body: f.slice(offset, end),
              signal: controller.signal,
            });
            if (r.status === 409) {
              offset = (await headOffset(location)) ?? offset;
              continue;
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            offset = Number(r.headers.get("Upload-Offset") ?? String(end));
            retries = 0;
            setProgress(Math.min(99, Math.round((offset / f.size) * 100)));
          } catch (e) {
            if (controller.signal.aborted) return;
            if (++retries > 6) throw e;
            await new Promise((res) => setTimeout(res, 250 * 2 ** (retries - 1)));
            offset = (await headOffset(location)) ?? offset;
          }
        }

        localStorage.removeItem(tusKey(f));
        setUploads((arr) => arr.map((u) => (u.id === id ? { ...u, progress: 100, status: "done", controller: undefined } : u)));
        setFiles((fs) => [
          { key, size: f.size, type: f.type || "application/octet-stream", folder: target, folderId: null, updated: "just now", acl: "private", metadata: null },
          ...fs,
        ]);
        setFilesTotal((n) => n + 1);
        void refreshCounts();
      } catch (e) {
        if (controller.signal.aborted) return;
        fail((e as Error).message || t`upload failed`);
      }
    })();

    return {
      id,
      name: f.name,
      size: f.size,
      type: f.type || "application/octet-stream",
      progress: 0,
      status: "uploading",
      controller,
      resumable: true,
    };
  };

  const queueUploads = (list: File[]) => {
    if (list.length === 0) return;
    const target = folder || "uploads";
    const jobs = list.map((f, i) =>
      f.size >= RESUMABLE_THRESHOLD
        ? startResumableUpload(f, target, i)
        : startUpload(f, target, i),
    );
    setUploads((arr) => [...jobs, ...arr.filter((u) => u.status === "uploading")]);
    pushToast(t`${jobs.length} ${jobs.length === 1 ? "file" : "files"} queued for ${target}/.`);
  };

  /** Cancel an in-flight upload — aborts the XHR (single PUT) or the fetch
   *  controller (resumable). Already-done or already-failed jobs ignore. */
  const cancelUpload = (id: string) => {
    setUploads((arr) => {
      const job = arr.find((u) => u.id === id);
      if (job?.xhr) job.xhr.abort();
      job?.controller?.abort();
      return job?.controller ? arr.filter((u) => u.id !== id) : arr;
    });
  };

  const onDrop = (e: any) => {
    e.preventDefault();
    setDragOver(false);
    const list = Array.from(e.dataTransfer?.files || []) as File[];
    if (list.length > 0) queueUploads(list);
  };

  // Cmd/Ctrl+V — upload files/images straight from the clipboard. The drop
  // zone advertises this, so a real listener has to back the hint. Pasted
  // screenshots all arrive named "image.png"; stamp them unique so a second
  // paste doesn't silently overwrite the first.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const fileItems = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === "file");
      if (fileItems.length === 0) return;
      e.preventDefault();
      const list: File[] = [];
      fileItems.forEach((it, i) => {
        const f = it.getAsFile();
        if (!f) return;
        list.push(/^image\.\w+$/i.test(f.name) ? new File([f], `pasted-${Date.now()}-${i}-${f.name}`, { type: f.type }) : f);
      });
      if (list.length > 0) queueUploads(list);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [folder]);

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
        className={`flex cursor-pointer items-center gap-3.5 rounded-surface border-[1.5px] bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] px-[18px] py-4 transition-all duration-[120ms] hover:bg-muted ${
          dragOver
            ? "scale-[1.005] border-solid border-primary bg-muted"
            : "border-dashed border-border hover:border-interactive-hover-border"
        }`}
        onClick={() => dropFileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
      >
        <div className="grid size-10 shrink-0 place-items-center rounded-control bg-muted text-primary">
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
        <span className="hidden rounded-full border border-border bg-card px-2 py-[3px] font-mono text-[11px] text-muted-foreground pointer-fine:inline-block">⌘V to paste</span>
        <input ref={dropFileInputRef} type="file" multiple className="hidden" onChange={(e) => queueUploads(Array.from(e.target.files || []))} />
      </div>

      {uploads.length > 0 && (
        <Card className="gap-0 py-0">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <I.Activity size={14} />
            <span className="text-[13px] font-medium"><Trans>Uploads</Trans></span>
            <span className="font-mono text-[11.5px] text-muted-foreground">
              <Trans>{uploads.filter((u) => u.status === "done").length} / {uploads.length} complete</Trans>
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setUploads((arr) => arr.filter((u) => u.status === "uploading"))}><Trans>Clear done</Trans></Button>
          </div>
          <ScrollArea viewportClassName="max-h-[180px]">
          <div className="flex flex-col gap-2 px-3.5 py-2">
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
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs">{u.name}</span>
                      {u.resumable && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground" title={t`Chunked, resumable upload`}>
                          <Trans>resumable</Trans>
                        </span>
                      )}
                    </div>
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
          </ScrollArea>
        </Card>
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
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control border bg-card px-[11px] text-[12.5px] text-foreground hover:bg-accent ${
              view === v ? "border-chip-border bg-accent" : "border-border"
            }`}
            onClick={() => setView(v)}
          >
            {v === "grid" ? <I.Braces size={12} /> : <I.Inbox size={12} />} {v === "grid" ? <Trans>Grid</Trans> : <Trans>List</Trans>}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <Card className="sticky top-3 max-h-[calc(100vh-160px)] gap-0 py-0 max-[900px]:static max-[900px]:max-h-none">
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
          <ScrollArea className="min-h-0 flex-1" viewportClassName="max-[900px]:max-h-[320px]">
          <div className="px-1.5 pb-2 pt-1.5">
            <button
              type="button"
              className={`flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-control border-0 py-1.5 pl-2.5 pr-2 text-left text-[12.5px] text-foreground hover:bg-accent ${
                folder == null ? "bg-accent font-medium" : "bg-transparent"
              }`}
              onClick={() => setFolder(null)}
            >
              <I.Inbox size={12} />
              <span><Trans>All files</Trans></span>
              <span className={`ml-auto text-[11px] tabular-nums ${folder == null ? "text-foreground" : "text-muted-foreground"}`}>{folderCounts.total}</span>
            </button>
            {folderTreeFiltered.length === 0 && (
              <EmptyState
                size="sm"
                title={folders.length === 0
                  ? <Trans>No folders yet. <button type="button" onClick={openNewFolder} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-primary underline">Create one</button>.</Trans>
                  : <Trans>No folders match.</Trans>}
              />
            )}
            {folderTreeFiltered.map((node: any) => {
              const hasKids = node.children.size > 0;
              const isOpen = !collapsed.has(node.path);
              const isActive = folder === node.path;
              return (
                <div
                  key={node.path}
                  className={`flex w-full min-w-0 items-center gap-1.5 rounded-control py-1.5 pr-2 text-[12.5px] text-foreground ${
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
          </ScrollArea>
        </Card>
        <Card className="gap-0 py-0">
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
                <EmptyState
                  bare
                  className="col-span-full"
                  icon={I.Upload}
                  title={<Trans>No files yet</Trans>}
                  description={<Trans>Drop files anywhere on this page or use Upload.</Trans>}
                />
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
                    className="cursor-pointer data-[selected=true]:bg-selected-surface"
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
        </Card>
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
          onPatch={(next: { folderId?: string | null; metadata?: FileMetadata | null }) =>
            patchFile(selected.key, next)
          }
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
                <div className="rounded-surface bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] px-2.5 py-2 text-xs text-destructive">
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
