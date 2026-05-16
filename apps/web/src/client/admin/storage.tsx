// @ts-nocheck
// Storage page — preview, batch upload progress, ACL, file detail modal
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { I } from "./icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "./ui";
import { Input } from "@workeros/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workeros/ui/components/input-group";
import { api } from "@/lib/api";

interface StoredFolder {
  id: string;
  name: string;
  count: number;
  public: boolean;
}

interface StoredFile {
  key: string;
  size: number;
  type: string;
  folder: string | null;
  updated: string;
  acl: "public" | "private";
  hue?: number;
  w?: number;
  h?: number;
}

interface UploadJob {
  id: string;
  name: string;
  size: number;
  type: string;
  progress: number;
  status: "uploading" | "done";
}

export function StoragePage({ pushToast }: { pushToast: (msg: string) => void }) {
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const [files, setFiles] = useState<StoredFile[]>([]);
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
      try {
        const fs = await api<{ data: any[] }>("/api/storage");
        if (!cancelled && Array.isArray(fs.data)) {
          setFiles(
            fs.data.map((file) => ({
              key: file.key,
              size: file.size ?? 0,
              type: file.contentType ?? "application/octet-stream",
              folder: file.folderId ?? null,
              updated: file.createdAt ? String(file.createdAt).slice(0, 10) : "—",
              acl: (file.acl as "public" | "private") ?? "private",
            })),
          );
        }
      } catch {
        // leave files empty
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [folder, setFolder] = useState<string | null>(null);
  const [folderQuery, setFolderQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [w, setW] = useState(800);
  const [q, setQ] = useState(80);
  const [fmt, setFmt] = useState("webp");
  const [fit, setFit] = useState("cover");
  const [focal, setFocal] = useState({ x: 50, y: 50 });
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
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

  const visible = useMemo(() => files.filter((f) => {
    const folderMatch = folder == null
      ? true
      : (f.folder === folder || (f.folder && f.folder.startsWith(folder + "/")));
    return folderMatch && (!search || f.key.toLowerCase().includes(search.toLowerCase()));
  }), [files, folder, search]);

  const selected = files.find((f) => f.key === selectedKey) || null;
  const fmtSize = (b: number) => b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + " MB" : (b / 1024).toFixed(1) + " KB";
  const isImage = (t: string) => Boolean(t && t.startsWith("image/"));

  useEffect(() => {
    if (uploads.every((u) => u.progress >= 100)) return;
    const t = setInterval(() => {
      setUploads((arr) => arr.map((u) => {
        if (u.progress >= 100) return u;
        const next = Math.min(100, u.progress + 8 + Math.random() * 18);
        if (next >= 100) {
          setFiles((fs) => [{ key: `${folder || "uploads"}/${u.name}`, size: u.size, type: u.type, folder: folder || "uploads", updated: "just now", acl: "private", hue: Math.floor(Math.random() * 360), w: 1600, h: 900 }, ...fs]);
          return { ...u, progress: 100, status: "done" };
        }
        return { ...u, progress: next };
      }));
    }, 240);
    return () => clearInterval(t);
  }, [uploads, folder]);

  const queueUploads = (list: ({ name?: string; size?: number; type?: string } | File)[]) => {
    const target = folder || "uploads";
    const next: UploadJob[] = list.map((f, i) => ({
      id: "up_" + Date.now() + "_" + i,
      name: f.name || `upload-${i}.png`,
      size: f.size || 80000 + Math.floor(Math.random() * 400000),
      type: f.type || "image/png",
      progress: 0,
      status: "uploading",
    }));
    setUploads((arr) => [...next, ...arr.filter((u) => u.status === "uploading")]);
    pushToast(`${next.length} file${next.length === 1 ? "" : "s"} queued for ${target}/.`);
    // Real upload for File-like inputs that the browser handed us. Synthetic
    // entries (drag-drop placeholders without a File) just animate locally.
    list.forEach((f, i) => {
      if (!(f instanceof File)) return;
      const job = next[i]!;
      const key = `${target}/${f.name}`;
      void fetch(`/api/storage/${encodeURIComponent(key)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": f.type || "application/octet-stream" },
        body: f,
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          setUploads((arr) =>
            arr.map((u) => (u.id === job.id ? { ...u, progress: 100, status: "done" } : u)),
          );
          setFiles((fs) => [
            { key, size: f.size, type: f.type || "application/octet-stream", folder: target, updated: "just now", acl: "private" },
            ...fs,
          ]);
        })
        .catch((e: Error) => {
          pushToast?.(e.message);
          setUploads((arr) => arr.filter((u) => u.id !== job.id));
        });
    });
  };

  const onDrop = (e: any) => {
    e.preventDefault();
    setDragOver(false);
    const list = Array.from(e.dataTransfer?.files || []) as File[];
    if (list.length === 0) {
      queueUploads([{ name: `dropped-${Date.now() % 9999}.png`, size: 142000, type: "image/png" }]);
    } else {
      queueUploads(list);
    }
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
      pushToast(`Folder "${clean}" already exists.`);
      return;
    }
    setNewFolderBusy(true);
    try {
      const res = await api<{ data: { id: string; name: string } }>("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: clean }),
      });
      setFolders((arr) => [...arr, { id: res.data.id, name: clean, count: 0, public: false }]);
      pushToast(`Folder "${clean}" created.`);
      setNewFolderOpen(false);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setNewFolderBusy(false);
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
      pushToast(`${key} → ${next}.`);
    } catch (e) {
      // revert on failure
      setFiles((arr) => arr.map((f) => f.key === key ? { ...f, acl: next === "public" ? "private" : "public" } : f));
      pushToast((e as Error).message);
    }
  };

  const deleteFile = async (key: string) => {
    setFiles((arr) => arr.filter((x) => x.key !== key));
    if (selectedKey === key) { setSelectedKey(null); setDetailOpen(false); }
    try {
      await api(`/api/storage/${encodeURIComponent(key)}`, { method: "DELETE" });
      pushToast(`${key} deleted.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const openDetail = (key: string) => {
    setSelectedKey(key);
    setDetailOpen(true);
  };

  useEffect(() => {
    if (!detailOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDetailOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen]);

  const totalBytes = files.reduce((a, f) => a + f.size, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }} onDrop={onDrop}>
      <PageHeader
        title="Storage"
        description={<>Adapter auto-selected: R2 binding → R2; S3 env vars → S3; else local filesystem (Bun dev). Public folders are served at <span className="font-mono">/storage/&lt;key&gt;</span>; private require a signed URL.</>}
        badges={<span style={{ display: "inline-flex", gap: 6, marginLeft: 4 }}>
          <Badge variant="outline" mono>{files.length} files</Badge>
          <Badge variant="outline" mono>{fmtSize(totalBytes)}</Badge>
        </span>}
        actions={<>
          <Button variant="outline" icon={I.Folder} onClick={openNewFolder}>New folder</Button>
          <Button variant="primary" icon={I.Plus} onClick={() => fileInputRef.current?.click()}>Upload</Button>
          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => queueUploads(Array.from(e.target.files || []))} />
        </>}
      />

      <div
        className={`dropzone ${dragOver ? "is-over" : ""}`}
        onClick={() => dropFileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
      >
        <div className="dropzone-icon">
          <I.Upload size={20} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>
            Drop files to upload — or <span style={{ color: "var(--primary)", textDecoration: "underline", textDecorationThickness: 1, textUnderlineOffset: 2 }}>browse</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Target folder: <span className="font-mono" style={{ color: "var(--foreground)" }}>{folder || "uploads"}/</span> · max 100 MB per file · jpeg, png, webp, avif transformed on the fly
          </div>
        </div>
        <div className="spacer" />
        <span className="dropzone-hint font-mono">⌘V to paste</span>
        <input ref={dropFileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => queueUploads(Array.from(e.target.files || []))} />
      </div>

      {uploads.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <I.Activity size={14} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Uploads</span>
            <span className="muted font-mono" style={{ fontSize: 11.5 }}>
              {uploads.filter((u) => u.status === "done").length} / {uploads.length} complete
            </span>
            <div className="spacer" />
            <Button variant="ghost" size="sm" onClick={() => setUploads((arr) => arr.filter((u) => u.status === "uploading"))}>Clear done</Button>
          </div>
          <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 8, maxHeight: 180, overflow: "auto" }}>
            {uploads.map((u) => (
              <div key={u.id} style={{ display: "grid", gridTemplateColumns: "16px 1fr 70px 60px", alignItems: "center", gap: 10, fontSize: 12 }}>
                {u.status === "done" ? <I.Check size={13} style={{ color: "oklch(0.55 0.16 145)" }} /> : <I.Upload size={13} className="muted" />}
                <div style={{ minWidth: 0 }}>
                  <div className="font-mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</div>
                  <div style={{ height: 4, borderRadius: 2, background: "var(--muted)", overflow: "hidden", marginTop: 4 }}>
                    <div style={{ height: "100%", width: `${u.progress}%`, background: u.status === "done" ? "oklch(0.7 0.18 145)" : "var(--primary)", transition: "width 200ms" }} />
                  </div>
                </div>
                <span className="tabular-nums muted" style={{ fontSize: 11.5, textAlign: "right" }}>{fmtSize(u.size)}</span>
                <span className="tabular-nums" style={{ fontSize: 11.5, textAlign: "right", color: u.status === "done" ? "oklch(0.55 0.16 145)" : "var(--muted-foreground)" }}>{Math.round(u.progress)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="filter-bar">
        <InputGroup>
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search keys…" />
        </InputGroup>
        <span className="muted font-mono" style={{ fontSize: 11.5 }}>
          {folder ? <>in <span style={{ color: "var(--foreground)" }}>{folder}/</span></> : "all folders"} · {visible.length} files
        </span>
        <div className="spacer" />
        <button className={`chip ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")}><I.Braces size={12} /> Grid</button>
        <button className={`chip ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}><I.Inbox size={12} /> List</button>
      </div>

      <div className="master-detail" style={{ "--md-aside": "240px" }}>
        <div className="card" style={{ padding: 0, overflow: "hidden", position: "sticky", top: 12, maxHeight: "calc(100vh - 160px)", display: "flex", flexDirection: "column" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
            <I.Folder size={13} />
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>Folders</span>
            <span className="muted tabular-nums" style={{ fontSize: 11 }}>{folders.length}</span>
            <div className="spacer" />
            <IconButton icon={I.Plus} title="New folder" onClick={openNewFolder} />
          </div>
          <div style={{ padding: "8px 10px 6px", borderBottom: "1px solid var(--border)" }}>
            <InputGroup className="h-8">
              <InputGroupAddon><I.Search size={12} /></InputGroupAddon>
              <InputGroupInput value={folderQuery} onChange={(e) => setFolderQuery(e.target.value)} placeholder="Filter folders…" className="text-xs" />
            </InputGroup>
          </div>
          <div style={{ overflowY: "auto", flex: 1, padding: "6px 6px 8px" }}>
            <button
              className={`folder-row ${folder == null ? "active" : ""}`}
              onClick={() => setFolder(null)}
              style={{ paddingLeft: 10 }}
            >
              <I.Inbox size={12} />
              <span>All files</span>
              <span className="muted tabular-nums" style={{ marginLeft: "auto", fontSize: 11 }}>{files.length}</span>
            </button>
            {folderTreeFiltered.length === 0 && (
              <div className="muted" style={{ padding: "12px 10px", fontSize: 11.5 }}>
                {folders.length === 0
                  ? <>No folders yet. <button onClick={openNewFolder} style={{ background: "none", border: 0, padding: 0, color: "var(--primary)", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>Create one</button>.</>
                  : "No folders match."}
              </div>
            )}
            {folderTreeFiltered.map((node: any) => {
              const hasKids = node.children.size > 0;
              const isOpen = !collapsed.has(node.path);
              const isActive = folder === node.path;
              return (
                <div key={node.path} className={`folder-row ${isActive ? "active" : ""}`} style={{ paddingLeft: 8 + node.depth * 14 }}>
                  {hasKids ? (
                    <button className="folder-caret" onClick={(e) => { e.stopPropagation(); toggleCollapse(node.path); }} aria-label="Toggle">
                      <I.ChevronRight size={11} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 100ms" }} />
                    </button>
                  ) : (
                    <span style={{ width: 14 }} />
                  )}
                  <button className="folder-row-main" onClick={() => setFolder(node.path)}>
                    <I.Folder size={12} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
                    {node.folder?.public && <span style={{ width: 5, height: 5, borderRadius: 999, background: "oklch(0.7 0.18 145)", flexShrink: 0 }} title="public" />}
                    <span className="muted tabular-nums" style={{ marginLeft: "auto", fontSize: 11 }}>{node.folder?.count ?? 0}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {view === "grid" ? (
            <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {visible.length === 0 && (
                <div style={{ gridColumn: "1 / -1", padding: 36, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
                  No files. Drop files anywhere on this page or use Upload.
                </div>
              )}
              {visible.map((f) => (
                <FileTile key={f.key} f={f} active={selectedKey === f.key} onSelect={() => openDetail(f.key)} />
              ))}
            </div>
          ) : (
            <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th style={{ width: 90 }}>Type</th>
                  <th style={{ width: 80 }}>ACL</th>
                  <th style={{ width: 90, textAlign: "right" }}>Size</th>
                  <th style={{ width: 100 }}>Updated</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((f) => (
                  <tr key={f.key} data-selected={selectedKey === f.key} onClick={() => openDetail(f.key)} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <FileGlyph f={f} size={20} />
                        <span className="font-mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.key}</span>
                      </div>
                    </td>
                    <td><Badge variant="outline" mono>{f.type.split("/")[1]}</Badge></td>
                    <td>
                      <Badge variant={f.acl === "public" ? "default" : "secondary"}>{f.acl}</Badge>
                    </td>
                    <td className="tabular-nums" style={{ textAlign: "right" }}>{fmtSize(f.size)}</td>
                    <td className="muted font-mono" style={{ fontSize: 11.5 }}>{f.updated}</td>
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                      <IconButton icon={I.Trash} title="Delete" onClick={() => deleteFile(f.key)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      {detailOpen && selected && (
        <FileDetailModal
          f={selected}
          fmtSize={fmtSize}
          isImage={isImage(selected.type)}
          w={w} setW={setW} q={q} setQ={setQ} fmt={fmt} setFmt={setFmt}
          fit={fit} setFit={setFit}
          focal={focal} setFocal={setFocal}
          onToggleACL={() => toggleACL(selected.key)}
          onDelete={() => deleteFile(selected.key)}
          onCopy={(text: string) => { navigator.clipboard?.writeText(text); pushToast("Copied to clipboard."); }}
          onClose={() => setDetailOpen(false)}
          pushToast={pushToast}
        />
      )}

      {newFolderOpen && (
        <>
          <div className="scrim" onClick={() => !newFolderBusy && setNewFolderOpen(false)} />
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-folder-title">
            <div>
              <h3 id="new-folder-title">New folder</h3>
              <p style={{ marginTop: 6 }}>
                Lowercase letters, digits, <span className="font-mono">_</span> and <span className="font-mono">-</span>. Use <span className="font-mono">/</span> in the name to nest under an existing folder.
              </p>
            </div>
            <Input
              ref={newFolderInputRef}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void submitNewFolder(); }
                if (e.key === "Escape") { e.preventDefault(); setNewFolderOpen(false); }
              }}
              placeholder="drafts"
              disabled={newFolderBusy}
              autoFocus
            />
            <div className="actions">
              <Button variant="ghost" size="sm" onClick={() => setNewFolderOpen(false)} disabled={newFolderBusy}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={submitNewFolder} disabled={newFolderBusy || !newFolderName.trim()}>
                {newFolderBusy ? "Creating…" : "Create folder"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FileGlyph({ f, size = 64 }: { f: StoredFile; size?: number }) {
  const isImg = Boolean(f.type && f.type.startsWith("image/"));
  const [imgFailed, setImgFailed] = useState(false);
  if (isImg && !imgFailed) {
    return (
      <img
        src={`/api/storage/${encodeURI(f.key)}`}
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

function FileTile({ f, active, onSelect }: { f: StoredFile; active: boolean; onSelect: () => void }) {
  const isImg = Boolean(f.type && f.type.startsWith("image/"));
  const [imgFailed, setImgFailed] = useState(false);
  const sizeStr = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + " MB" : (f.size / 1024).toFixed(1) + " KB";
  return (
    <div onClick={onSelect} style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: "var(--radius-md)", border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`, background: active ? "color-mix(in oklch, var(--primary) 6%, transparent)" : "var(--card)", cursor: "pointer", transition: "background 100ms", minWidth: 0 }}>
      <div style={{ width: 36, height: 36, position: "relative", borderRadius: "var(--radius-sm)", overflow: "hidden", background: "var(--muted)", flexShrink: 0 }}>
        {isImg && !imgFailed ? (
          <img
            src={`/api/storage/${encodeURI(f.key)}`}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : isImg ? (
          <ImageMock hue={f.hue ?? 200} />
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <FileGlyph f={f} size={36} />
          </div>
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="font-mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.key.split("/").pop()}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <span className="muted tabular-nums" style={{ fontSize: 10.5 }}>{sizeStr}</span>
          {f.acl === "public" && <span style={{ width: 4, height: 4, borderRadius: 999, background: "oklch(0.7 0.18 145)" }} title="public" />}
        </div>
      </div>
    </div>
  );
}

function FileDetailModal({ f, onClose, ...rest }: any) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg storage-detail-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600, letterSpacing: "-0.01em" }}>Edit file</h3>
            <p style={{ margin: "2px 0 0", color: "var(--muted-foreground)", fontSize: 12, fontFamily: "Geist Mono, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.key}</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="dialog-body" style={{ padding: 0 }}>
          <FileDetail f={f} {...rest} embedded />
        </div>
      </div>
    </div>
  );
}

function FileDetail({ f, fmtSize, isImage, w, setW, q, setQ, fmt, setFmt, fit, setFit, focal, setFocal, onToggleACL, onDelete, onCopy, pushToast, embedded }: any) {
  const url = `/api/storage/${encodeURI(f.key)}`;
  const params = isImage ? `?width=${w}&format=${fmt}&quality=${q}&fit=${fit}&focal=${focal.x},${focal.y}` : "";
  const transformedUrl = url + params;
  // Copying / signing produces URLs that travel outside the admin tab —
  // a chat message, an <img> on another site, a curl invocation. Relative
  // paths are fine for in-page <img>/HEAD/anchor download (browser resolves
  // them against the page origin) but useless once detached.
  const toAbsolute = (rel: string): string =>
    rel.startsWith("http") ? rel : window.location.origin + rel;

  // Real transformed-output size, read from the server via HEAD. Debounced
  // so dragging a slider doesn't fire one request per pixel. Resets to
  // "loading" whenever the transform URL changes.
  const [transformedSize, setTransformedSize] = useState<number | null>(null);
  const [transformedLoading, setTransformedLoading] = useState(false);
  useEffect(() => {
    if (!isImage) { setTransformedSize(null); return; }
    setTransformedLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(transformedUrl, { method: "HEAD", credentials: "include", signal: ctrl.signal });
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

  const aspect = (isImage && f.w && f.h) ? f.h / f.w : 0.6;
  const previewH = (isImage && f.w) ? Math.round(w * aspect) : null;

  const Wrapper: any = embedded ? Fragment : "div";
  const wrapperProps: any = embedded ? {} : { className: "card", style: { padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" } };

  /** Hit POST /api/storage/<key>/sign and return the relative signed URL. */
  const signOnce = async (ttlSeconds: number): Promise<string> => {
    const res = await api<{ url: string }>(
      `/api/storage/${encodeURI(f.key)}/sign`,
      { method: "POST", body: JSON.stringify({ ttlSeconds }) },
    );
    return res.url;
  };

  /** Append transform params to a signed URL — the server validates the
   *  token first then runs the transform path, so this stays one request. */
  const withTransformParams = (signed: string): string => {
    if (!params) return signed;
    return signed + (signed.includes("?") ? "&" : "?") + params.slice(1);
  };

  const onDownload = async () => {
    try {
      const href = f.acl === "public"
        ? transformedUrl
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
      pushToast?.("Signed URL copied (1h).");
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>File detail</span>
          <div className="spacer" />
          <IconButton icon={I.Trash} title="Delete" onClick={onDelete} />
        </div>
      )}

      <div
        className="img-preview"
        onClick={(e) => {
          if (!isImage) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * 100;
          const y = ((e.clientY - r.top) / r.height) * 100;
          setFocal({ x: Math.round(x), y: Math.round(y) });
        }}
        style={{ aspectRatio: "16 / 9", cursor: isImage ? "crosshair" : "default", borderRadius: 0 }}
      >
        {isImage ? (
          <>
            <img
              key={transformedUrl}
              src={transformedUrl}
              alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: fit === "contain" ? "contain" : "cover", display: "block", background: "var(--muted)" }}
            />
            <div className="focal-pin" style={{ left: `calc(${focal.x}% - 1px)`, top: `calc(${focal.y}% - 1px)` }}>
              <span />
            </div>
            <div className="img-label" style={{ right: 8, top: 8 }}>{fmt} · {w}{previewH ? `×${previewH}` : ""}</div>
          </>
        ) : (
          <>
            <div style={{ position: "absolute", inset: 0, background: "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%) 50% / 16px 16px" }} />
            <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, color: "var(--muted-foreground)" }}>
              <FileGlyph f={f} size={64} />
              <span className="font-mono" style={{ fontSize: 11.5 }}>{f.type}</span>
            </div>
          </>
        )}
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Key</span>
          <span className="font-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{f.key}</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div>
            <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Size</div>
            <div className="tabular-nums" style={{ fontWeight: 500 }}>{fmtSize(f.size)}</div>
          </div>
          {isImage && f.w && (
            <div>
              <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Dim</div>
              <div className="font-mono tabular-nums" style={{ fontSize: 11.5 }}>{f.w}×{f.h}</div>
            </div>
          )}
          <div>
            <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Updated</div>
            <div className="font-mono" style={{ fontSize: 11.5 }}>{f.updated}</div>
          </div>
        </div>

        <div className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div>
            <div className="field-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {f.acl === "public" ? <I.Eye size={12} /> : <I.Shield size={12} />}
              {f.acl === "public" ? "Public" : "Private"}
            </div>
            <div className="field-hint">{f.acl === "public" ? "Anyone with the URL can fetch this file." : "Requires a signed URL or auth cookie."}</div>
          </div>
          <Switch checked={f.acl === "public"} onChange={onToggleACL} />
        </div>

        {isImage && (
          <>
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <I.Sliders size={13} />
                <span style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>Transform</span>
                <div className="spacer" />
                <button className="link-btn" onClick={() => { setW(f.w || 1600); setQ(80); setFmt("webp"); setFit("cover"); setFocal({ x: 50, y: 50 }); }}>Reset</button>
              </div>

              <div className="field" style={{ marginTop: 0 }}>
                <label className="field-label">
                  Width
                  <span className="muted tabular-nums">{w}px {f.w && <span style={{ opacity: 0.6 }}>· {Math.round((w / f.w) * 100)}%</span>}</span>
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="range" min={120} max={Math.max(1600, f.w || 1600)} step={20} value={w} onChange={(e) => setW(Number(e.target.value))} style={{ flex: 1 }} />
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                  {[256, 512, 800, 1200, 1600].map((preset) => (
                    <button key={preset} className={`size-chip ${w === preset ? "on" : ""}`} onClick={() => setW(preset)}>{preset}</button>
                  ))}
                </div>
              </div>

              <div className="field" style={{ marginTop: 0 }}>
                <label className="field-label">Quality <span className="muted tabular-nums">{q}</span></label>
                <input type="range" min={10} max={100} step={5} value={q} onChange={(e) => setQ(Number(e.target.value))} style={{ width: "100%" }} />
              </div>

              <div className="field" style={{ marginTop: 0 }}>
                <label className="field-label">Format</label>
                <div className="seg">
                  {[
                    { v: "webp", save: "−45%" },
                    { v: "avif", save: "−60%" },
                    { v: "jpeg", save: "0%" },
                    { v: "png", save: "+lossless" },
                  ].map((o) => (
                    <button key={o.v} className={fmt === o.v ? "on" : ""} onClick={() => setFmt(o.v)}>
                      <span className="font-mono">{o.v}</span>
                      <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>{o.save}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field" style={{ marginTop: 0 }}>
                <label className="field-label">Fit</label>
                <div className="seg">
                  {["cover", "contain", "fill", "inside"].map((o) => (
                    <button key={o} className={fit === o ? "on" : ""} onClick={() => setFit(o)}><span className="font-mono">{o}</span></button>
                  ))}
                </div>
              </div>

              <div className="field" style={{ marginTop: 0 }}>
                <label className="field-label">Focal point <span className="muted font-mono">{focal.x}, {focal.y}</span></label>
                <div className="focal-grid" onClick={(e: any) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setFocal({ x: Math.round(((e.clientX - r.left) / r.width) * 100), y: Math.round(((e.clientY - r.top) / r.height) * 100) });
                }}>
                  <img
                    src={`/api/storage/${encodeURI(f.key)}`}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block", background: "var(--muted)" }}
                  />
                  <div className="focal-grid-overlay">
                    {[0, 1, 2].map((row) => (
                      [0, 1, 2].map((col) => {
                        const x = col * 50; const y = row * 50;
                        return <button key={`${row}-${col}`} className={`focal-anchor ${focal.x === x && focal.y === y ? "on" : ""}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={(e: any) => { e.stopPropagation(); setFocal({ x, y }); }} title={`${x},${y}`} />;
                      })
                    ))}
                    <div className="focal-pin" style={{ left: `calc(${focal.x}% - 1px)`, top: `calc(${focal.y}% - 1px)` }}><span /></div>
                  </div>
                </div>
                <span className="field-hint">Click anywhere to set the crop pivot for <span className="font-mono">fit=cover</span>.</span>
              </div>
            </div>

            <div className="size-readout">
              <div>
                <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Original</div>
                <div className="tabular-nums">{fmtSize(f.size)}</div>
              </div>
              <I.ChevronRight size={14} className="muted" />
              <div>
                <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Transformed</div>
                <div className="tabular-nums" style={{ color: transformedSize != null ? "oklch(0.55 0.16 145)" : "var(--muted-foreground)", fontWeight: 500 }}>
                  {transformedLoading ? "…" : transformedSize != null ? fmtSize(transformedSize) : "—"}
                </div>
              </div>
              <div className="spacer" />
              {transformedSize != null && (
                <Badge variant="outline" mono>{Math.round((1 - transformedSize / f.size) * 100)}% smaller</Badge>
              )}
            </div>
          </>
        )}

        <div className="alter-preview" style={{ fontSize: 11, padding: 10, lineHeight: 1.5 }}>
          <span className="kw">GET</span> <span style={{ color: "var(--foreground)" }}>{url}</span>{params && <span className="muted">{params}</span>}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button size="sm" variant="outline" icon={I.Code} onClick={() => onCopy(toAbsolute(transformedUrl))}>Copy URL</Button>
          {f.acl === "private" && <Button size="sm" variant="outline" icon={I.Shield} onClick={onSignUrl}>Sign URL</Button>}
          <Button size="sm" variant="outline" icon={I.Download} onClick={onDownload}>Download</Button>
        </div>
      </div>
    </Wrapper>
  );
}
