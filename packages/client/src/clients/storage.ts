import { BacklexError } from "../types";
import type { ResumableUploadResult } from "../types";
import type { ClientCore } from "../core";

// ── Resumable-upload helpers (TUS) ──────────────────────────────────────────
/** Default PATCH chunk size: 8 MiB (object stores require ≥5 MiB non-final parts). */
const DEFAULT_CHUNK = 8 * 1024 * 1024;

const OFFSET_OCTET = "application/offset+octet-stream";

/** Base64-encode a UTF-8 string for a TUS `Upload-Metadata` value. */
const b64 = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)));

interface UploadSource {
  size: number;
  /** Returns a chunk `[start, end)` as a fetch body. */
  slice(start: number, end: number): BodyInit;
}

const normalizeUploadData = (data: Blob | ArrayBuffer | Uint8Array): UploadSource => {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { size: data.size, slice: (s, e) => data.slice(s, e) };
  }
  const u = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  // Cast: a Uint8Array view is a valid fetch body at runtime, but TS's DOM
  // `BodyInit` wants `Uint8Array<ArrayBuffer>` (not `ArrayBufferLike`).
  return { size: u.byteLength, slice: (s, e) => u.subarray(s, e) as unknown as BodyInit };
};

/**
 * Escape a storage key for a URL path while KEEPING its slashes.
 *
 * A key may contain `/` and the route is a catch-all, so the separators have
 * to survive; everything else must not. `encodeURI` would leave `?`, `#` and
 * `&` alone and a key containing one would silently become a query string, so
 * each segment is escaped in full and the slashes are put back.
 *
 * A `.` or `..` segment is REFUSED rather than escaped. Such a key has no URL:
 * a browser normalizes dot segments out of a path before sending it, and the
 * URL standard does that after percent-decoding, so `%2E%2E` is normalized
 * away too — there is no encoding that survives. Composing one anyway would
 * produce a link addressing something outside `/api/storage/` entirely, from
 * a key the application may not control. The server refuses these keys on the
 * way in for the same reason; this refuses to pretend one can be addressed.
 */
const encodeKeyPath = (key: string): string =>
  key
    .split("/")
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new BacklexError(400, {
          error: {
            code: "VALIDATION",
            message: `Storage key segment ${JSON.stringify(segment)} cannot be addressed by URL — a dot segment is normalized away by every URL parser.`,
          },
        });
      }
      return encodeURIComponent(segment);
    })
    .join("/");

/** Image transform parameters, as the download route accepts them. */
export interface StorageTransform {
  width?: number;
  height?: number;
  quality?: number;
  fit?: "cover" | "contain";
  format?: "webp" | "jpeg" | "png" | "avif";
  /** Focal point as `x,y`, each 0–100. */
  focal?: string;
}

/** How many files sit in each folder, for a tree that shows counts. */
export interface StorageFolderCounts {
  root: number;
  byFolderId: Record<string, number>;
  total: number;
}

/** File storage + resumable (TUS) uploads. See `createClient`. */
export interface StorageClient {
  /** List stored objects, optionally under a key prefix. */
  list(prefix?: string): Promise<{
    data: {
      key: string;
      size: number;
      contentType?: string;
      ownerId: string | null;
      uploadedAt: string;
    }[];
  }>;
  /** Upload an object in one request. */
  put(key: string, body: BodyInit, contentType?: string, folderId?: string): Promise<unknown>;
  /** Download an object; returns the raw `Response`. */
  download(key: string): Promise<Response>;
  /** Delete an object by key. */
  delete(key: string): Promise<{ ok: boolean }>;
  /**
   * Build the URL an object is served at, with optional image transforms.
   *
   * **A pure string builder — it issues no request.** That is the whole point:
   * the result goes straight into `<img src>` or a CSS `url()`, and the
   * browser fetches it the way it fetches any image, with caching and lazy
   * loading intact. Fetching bytes into a blob and calling
   * `URL.createObjectURL` — which is what an application has to do without
   * this — gives up all three and never applies a transform at all.
   *
   * For a private object, pass the `url` from {@link signUrl} instead.
   */
  url(key: string, transform?: StorageTransform): string;
  /**
   * Mint a short-lived URL that serves the object without a session.
   *
   * The token authorises exactly this key, so it can be handed to an `<img>`,
   * a download link or a third party without lending them anything else.
   * `ttlSeconds` is 60–86400 and defaults to an hour.
   */
  signUrl(key: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: string }>;
  /** Change an object's visibility, folder, or metadata. */
  update(
    key: string,
    patch: {
      acl?: "public" | "private";
      folderId?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<unknown>;
  /** File counts per folder, for a tree that shows how full each one is. */
  folderCounts(): Promise<StorageFolderCounts>;
  /**
   * Import a remote URL into storage, server-side.
   *
   * The fetch happens on the server, which is what makes it useful (no CORS,
   * no bytes through the browser) and what makes it guarded: the destination
   * goes through the SSRF check, with a 100 MB cap and a 30 second timeout.
   */
  fromUrl(input: {
    url: string;
    key?: string;
    folderId?: string | null;
    acl?: "public" | "private";
  }): Promise<unknown>;
  /** Resumable upload (TUS 1.0.0) that resumes after a transient failure. */
  uploadResumable(input: {
    key: string;
    data: Blob | ArrayBuffer | Uint8Array;
    contentType?: string;
    folderId?: string;
    chunkSize?: number;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  }): Promise<ResumableUploadResult>;
  /** Resume a previously-started resumable upload at the server's offset. */
  resumeUpload(
    location: string,
    data: Blob | ArrayBuffer | Uint8Array,
    opts2?: { chunkSize?: number; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
  ): Promise<void>;
}

export const makeStorage = (core: ClientCore): StorageClient => {
  const safeErr = async (res: Response) =>
    (await res.json().catch(() => ({}))) as
      | { error?: { code: string; message: string; details?: unknown } }
      | undefined;

  /** HEAD a TUS session to learn the server's committed offset. */
  const headOffset = async (location: string, signal?: AbortSignal): Promise<number> => {
    const res = await core.fetch(`${core.opts.url}${location}`, {
      method: "HEAD",
      credentials: "include",
      headers: {
        ...core.authHeaders(),
        "Tus-Resumable": "1.0.0",
      },
      signal,
    });
    if (!res.ok) throw new BacklexError(res.status, undefined);
    return Number(res.headers.get("Upload-Offset") ?? "0");
  };

  /**
   * PATCH chunks from the server's current offset to the end. On a network
   * error or 409 offset-conflict it re-HEADs to resync and retries with
   * backoff (up to 6 tries per chunk); other 4xx are fatal.
   */
  const patchLoop = async (
    location: string,
    src: UploadSource,
    chunkSize: number,
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    let offset = await headOffset(location, signal);
    let retries = 0;
    while (offset < src.size) {
      const end = Math.min(offset + chunkSize, src.size);
      try {
        const res = await core.fetch(`${core.opts.url}${location}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            ...core.authHeaders(),
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "content-type": OFFSET_OCTET,
          },
          body: src.slice(offset, end),
          signal,
        });
        if (res.status === 409) {
          offset = await headOffset(location, signal); // resync + retry
          continue;
        }
        if (!res.ok) throw new BacklexError(res.status, await safeErr(res));
        offset = Number(res.headers.get("Upload-Offset") ?? String(end));
        retries = 0;
        onProgress?.(offset, src.size);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (e instanceof BacklexError && e.status >= 400 && e.status < 500 && e.status !== 409) {
          throw e; // fatal client error
        }
        if (++retries > 6) throw e;
        await new Promise((r) => setTimeout(r, 250 * 2 ** (retries - 1)));
        offset = await headOffset(location, signal);
      }
    }
  };

  const storage: StorageClient = {
    list: (prefix?: string) =>
      core.request<{
        data: {
          key: string;
          size: number;
          contentType?: string;
          ownerId: string | null;
          uploadedAt: string;
        }[];
      }>(
        "GET",
        `/api/storage${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`,
      ),
    put: async (
      key: string,
      body: BodyInit,
      contentType?: string,
      folderId?: string,
    ) => {
      const headers: Record<string, string> = {
        ...core.authHeaders(),
        ...(contentType ? { "content-type": contentType } : {}),
      };
      const url = `${core.opts.url}/api/storage/${encodeURIComponent(key)}${folderId ? `?folderId=${folderId}` : ""}`;
      const res = await core.fetch(url, {
        method: "PUT",
        credentials: "include",
        headers,
        body,
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as
          | { error?: { code: string; message: string; details?: unknown } }
          | undefined;
        throw new BacklexError(res.status, errBody);
      }
      return res.json();
    },
    download: async (key: string): Promise<Response> => {
      const res = await core.fetch(`${core.opts.url}/api/storage/${encodeURIComponent(key)}`, {
        credentials: "include",
        headers: { ...core.authHeaders() },
      });
      if (!res.ok) {
        throw new BacklexError(res.status, undefined);
      }
      return res;
    },
    delete: (key: string) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `/api/storage/${encodeURIComponent(key)}`,
      ),

    url: (key: string, transform?: StorageTransform): string => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(transform ?? {})) {
        if (v !== undefined && v !== null) q.set(k, String(v));
      }
      const qs = q.toString();
      // Slashes kept, everything else escaped — see `encodeKeyPath`. Matches
      // the shape the server hands back from `signUrl`, so the two forms of a
      // URL for the same object differ only by the token.
      return `${core.opts.url}/api/storage/${encodeKeyPath(key)}${qs ? `?${qs}` : ""}`;
    },

    signUrl: (key: string, ttlSeconds?: number) =>
      core.request<{ url: string; expiresAt: string }>(
        "POST",
        // A sentinel PREFIX, because the key is a catch-all and has to be the
        // LAST thing in the path. The suffix form (`/{key}/sign`) is what the
        // docs and the generated spec used to advertise, and it 404s on any
        // key of three segments or more.
        `/api/storage/_sign/${encodeKeyPath(key)}`,
        ttlSeconds === undefined ? {} : { ttlSeconds },
      ),

    update: (
      key: string,
      patch: {
        acl?: "public" | "private";
        folderId?: string | null;
        metadata?: Record<string, unknown> | null;
      },
    ) => core.request<unknown>("PATCH", `/api/storage/${encodeURIComponent(key)}`, patch),

    folderCounts: () => core.request<StorageFolderCounts>("GET", "/api/storage/folder-counts"),

    fromUrl: (input: {
      url: string;
      key?: string;
      folderId?: string | null;
      acl?: "public" | "private";
    }) => core.request<unknown>("POST", "/api/storage/from-url", input),

    /**
     * Resumable upload (TUS 1.0.0). Splits `data` into chunks and PATCHes them
     * to `/api/uploads`, resuming from the server's committed offset after a
     * transient failure. `data` may be a `Blob`/`File`, `ArrayBuffer`, or
     * `Uint8Array`. Returns the final key + the TUS session `location` (persist
     * it to resume across page reloads via `resumeUpload`). The standard TUS
     * protocol means Uppy / tus-js-client can also target `/api/uploads`.
     */
    uploadResumable: async (input: {
      key: string;
      data: Blob | ArrayBuffer | Uint8Array;
      contentType?: string;
      folderId?: string;
      /** Bytes per PATCH. Default 8 MiB (object stores need ≥5 MiB non-final parts). */
      chunkSize?: number;
      onProgress?: (sent: number, total: number) => void;
      signal?: AbortSignal;
    }): Promise<ResumableUploadResult> => {
      const src = normalizeUploadData(input.data);
      const meta: string[] = [`key ${b64(input.key)}`];
      const ct = input.contentType ?? (input.data instanceof Blob ? input.data.type : "");
      if (ct) meta.push(`contentType ${b64(ct)}`);
      if (input.folderId) meta.push(`folderId ${b64(input.folderId)}`);

      const res = await core.fetch(`${core.opts.url}/api/uploads`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...core.authHeaders(),
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(src.size),
          "Upload-Metadata": meta.join(","),
        },
        signal: input.signal,
      });
      if (!res.ok) throw new BacklexError(res.status, await safeErr(res));
      const location = res.headers.get("Location");
      if (!location) throw new BacklexError(res.status, undefined);
      await patchLoop(location, src, input.chunkSize ?? DEFAULT_CHUNK, input.onProgress, input.signal);
      return { key: input.key, location };
    },

    /** Resume a previously-started resumable upload at the server's offset. */
    resumeUpload: async (
      location: string,
      data: Blob | ArrayBuffer | Uint8Array,
      opts2?: { chunkSize?: number; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
    ): Promise<void> => {
      await patchLoop(
        location,
        normalizeUploadData(data),
        opts2?.chunkSize ?? DEFAULT_CHUNK,
        opts2?.onProgress,
        opts2?.signal,
      );
    },
  };

  return storage;
};
