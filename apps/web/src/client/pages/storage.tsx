import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { FileIcon, FolderPlusIcon, ImageIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface StoredObject {
  key: string;
  folderId: string | null;
  size: number;
  contentType?: string;
  ownerId: string | null;
  uploadedAt: string;
}

interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string | null;
}

const ROOT = "(root)";

const fmtSize = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const isImage = (ct: string | undefined): boolean =>
  !!ct && ct.startsWith("image/");

interface ImageTransformProps {
  file: StoredObject;
}

const ImageTransform = ({ file }: ImageTransformProps) => {
  const [width, setWidth] = useState(800);
  const [quality, setQuality] = useState(80);
  const [format, setFormat] = useState<"webp" | "avif" | "jpeg" | "png">("webp");

  const url = useMemo(() => {
    const params = new URLSearchParams();
    params.set("width", String(width));
    params.set("format", format);
    params.set("quality", String(quality));
    return `/api/storage/${encodeURIComponent(file.key)}?${params}`;
  }, [file.key, width, format, quality]);

  return (
    <Card className="sticky top-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ImageIcon className="size-4" /> Image transform
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-hidden rounded-2xl border border-border bg-muted/30">
          <img
            src={url}
            alt={file.key}
            className="h-auto max-h-64 w-full object-contain"
            loading="lazy"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="flex items-center justify-between text-xs">
            width
            <span className="font-mono text-muted-foreground tabular-nums">
              {width}px
            </span>
          </Label>
          <input
            type="range"
            min={120}
            max={1600}
            step={20}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="flex items-center justify-between text-xs">
            quality
            <span className="font-mono text-muted-foreground tabular-nums">
              {quality}
            </span>
          </Label>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">format</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="webp">webp</SelectItem>
              <SelectItem value="avif">avif</SelectItem>
              <SelectItem value="jpeg">jpeg</SelectItem>
              <SelectItem value="png">png</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-2xl bg-[oklch(0.18_0.01_130)] p-3 font-mono text-[11px] leading-relaxed text-[oklch(0.92_0.02_130)] break-all">
          <span className="text-[oklch(0.78_0.18_95)]">GET</span>{" "}
          <span className="text-[oklch(0.85_0.13_200)]">{url.split("?")[0]}</span>
          <br />
          <span className="text-[oklch(0.6_0.02_130)]">?</span>
          <span className="text-[oklch(0.85_0.13_130)]">{url.split("?")[1]}</span>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => {
              navigator.clipboard?.writeText(window.location.origin + url);
            }}
          >
            Copy URL
          </Button>
          <Button asChild size="sm" variant="outline" className="flex-1">
            <a href={url} target="_blank" rel="noreferrer">
              Open
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export const Storage = () => {
  const [files, setFiles] = useState<StoredObject[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<StoredObject | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [keyName, setKeyName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [f, fld] = await Promise.all([
        api<{ data: StoredObject[] }>("/api/storage"),
        api<{ data: Folder[] }>("/api/folders"),
      ]);
      setFiles(f.data);
      setFolders(fld.data);
    } catch (e) {
      notifyError(e, "Loading storage");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const visibleFiles = files.filter((f) =>
    currentFolder === null ? true : f.folderId === currentFolder,
  );

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const f = fileInputRef.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const key = keyName || f.name;
      const url = `/api/storage/${encodeURIComponent(key)}${currentFolder ? `?folderId=${currentFolder}` : ""}`;
      const res = await fetch(url, {
        method: "PUT",
        credentials: "include",
        headers: f.type ? { "content-type": f.type } : {},
        body: f,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as
          | { error?: { message?: string } }
          | undefined;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setShowUpload(false);
      setKeyName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const [folderOpen, setFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const submitNewFolder = async (e: FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await api("/api/folders", {
        method: "POST",
        body: JSON.stringify({ name, parentId: currentFolder }),
      });
      setFolderOpen(false);
      setNewFolderName("");
      refresh();
    } catch (e) {
      notifyError(e, "Creating folder");
    }
  };

  const removeFile = async (key: string) => {
    try {
      await api(`/api/storage/${encodeURIComponent(key)}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Deleting file");
    }
  };

  const removeFolder = async (id: string) => {
    try {
      await api(`/api/folders/${id}`, { method: "DELETE" });
      if (currentFolder === id) setCurrentFolder(null);
      refresh();
    } catch (e) {
      notifyError(e, "Deleting folder");
    }
  };

  return (
    <div>
      <PageHeader
        title="Storage"
        description="Adapter auto-selected: R2 binding → R2; S3 env vars → S3; else local filesystem (Bun dev)."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => setFolderOpen(true)}>
              <FolderPlusIcon /> Folder
            </Button>
            <Button size="sm" onClick={() => setShowUpload((s) => !s)}>
              <UploadIcon /> {showUpload ? "Cancel" : "Upload"}
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Folder:</span>
            <button
              className={`rounded-md px-2 py-1 text-xs ${currentFolder === null ? "bg-primary/15 text-primary" : "hover:bg-muted"}`}
              onClick={() => setCurrentFolder(null)}
            >
              {ROOT}
            </button>
            {folders.map((f) => (
              <span key={f.id} className="flex items-center gap-1">
                <button
                  className={`rounded-md px-2 py-1 text-xs ${currentFolder === f.id ? "bg-primary/15 text-primary" : "hover:bg-muted"}`}
                  onClick={() => setCurrentFolder(f.id)}
                >
                  {f.name}
                </button>
                <ConfirmAction
                  title={`Delete folder "${f.name}"?`}
                  description="Files inside will be unlinked from the folder, not deleted."
                  actionLabel="Delete folder"
                  destructive
                  onConfirm={() => removeFolder(f.id)}
                >
                  <Button variant="ghost" size="icon-xs">
                    <Trash2Icon />
                  </Button>
                </ConfirmAction>
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {showUpload && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Upload</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={upload}>
              <div className="space-y-1.5">
                <Label htmlFor="file">File</Label>
                <input
                  id="file"
                  ref={fileInputRef}
                  type="file"
                  className="text-sm"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="keyname">Key (optional, defaults to filename)</Label>
                <Input
                  id="keyname"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. avatars/me.png"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Uploads to{" "}
                {currentFolder
                  ? folders.find((f) => f.id === currentFolder)?.name
                  : ROOT}
                .
              </p>
              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>
                  {busy ? "Uploading…" : "Upload"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>{visibleFiles.length} file(s)</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <ul className="divide-y">
                {Array.from({ length: 4 }).map((_, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 py-2">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-20" />
                  </li>
                ))}
              </ul>
            ) : visibleFiles.length === 0 ? (
              <EmptyState
                icon={FileIcon}
                title="No files here"
                description="Upload to add files to this folder. Storage backend is auto-selected (R2 / S3 / local fs)."
                action={
                  <Button size="sm" onClick={() => setShowUpload(true)}>
                    <UploadIcon /> Upload
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y">
                {visibleFiles.map((o) => (
                  <li
                    key={o.key}
                    onClick={() => setSelectedFile(o)}
                    className={`flex cursor-pointer items-center justify-between gap-4 py-2 text-sm transition-colors ${
                      selectedFile?.key === o.key
                        ? "bg-primary/10"
                        : "hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isImage(o.contentType) && (
                        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <a
                        className="font-mono truncate hover:underline"
                        href={`/api/storage/${encodeURIComponent(o.key)}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {o.key}
                      </a>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {fmtSize(o.size)}
                        {o.contentType ? ` · ${o.contentType}` : ""}
                      </span>
                      <ConfirmAction
                        title="Delete file?"
                        description={o.key}
                        actionLabel="Delete"
                        destructive
                        onConfirm={() => removeFile(o.key)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Trash2Icon />
                        </Button>
                      </ConfirmAction>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selectedFile && isImage(selectedFile.contentType) && (
          <ImageTransform key={selectedFile.key} file={selectedFile} />
        )}
      </div>

      <Dialog open={folderOpen} onOpenChange={setFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Folders organize files at the metadata level — they don't change
              the underlying object key.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitNewFolder} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="newFolderName">Name</Label>
              <Input
                id="newFolderName"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="avatars"
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setFolderOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
