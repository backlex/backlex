// Shared types + style constants for the Storage page modules.
// Split out of the former 1960-line admin/storage.tsx god-file.


export const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

export const SIZE_CHIP_BASE = "flex-1 cursor-pointer rounded-md border py-1 font-mono text-[10.5px]";
export const SIZE_CHIP_ON = "border-primary bg-primary text-primary-foreground";
export const SIZE_CHIP_OFF = "border-border bg-card text-muted-foreground hover:text-foreground";
export const SEG_BTN_BASE = "flex-1 cursor-pointer px-2 py-1.5 text-[11.5px]";
export const SEG_BTN_ON = "bg-primary text-primary-foreground";
export const SEG_BTN_OFF = "bg-transparent text-muted-foreground hover:text-foreground";

export interface StoredFolder {
  id: string;
  name: string;
  count: number;
  public: boolean;
}

export interface FileMetadata {
  name?: string;
  description?: string;
  tags?: string[];
  author?: string;
  location?: string;
  [key: string]: unknown;
}

export interface StoredFile {
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

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  type: string;
  /** 0–100, derived from XHR upload.onprogress event (or TUS chunk offset). */
  progress: number;
  status: "uploading" | "done" | "failed";
  /** Set on failure so the row can show the server's message. */
  error?: string;
  /** Per-job XHR so the user can cancel mid-flight (single-PUT path). */
  xhr?: XMLHttpRequest;
  /** Per-job aborter for the resumable (TUS) path. */
  controller?: AbortController;
  /** True when the file went through the resumable/chunked path. */
  resumable?: boolean;
}

/** Files at or above this size use resumable/chunked uploads (TUS) so a dropped
 *  connection resumes from the last committed offset instead of restarting. */
export const RESUMABLE_THRESHOLD = 50 * 1024 * 1024; // 50 MiB
export const TUS_CHUNK = 8 * 1024 * 1024; // 8 MiB (object stores need ≥5 MiB non-final parts)
/** localStorage namespace for in-progress resumable sessions (resume-on-reload). */
export const TUS_STORE = "backlex.tus.";
export const tusKey = (f: File) => `${TUS_STORE}${f.name}:${f.size}:${f.lastModified}`;
export const tusMeta = (name: string, value: string) =>
  `${name} ${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}`;

export const PAGE_SIZE = 50;
