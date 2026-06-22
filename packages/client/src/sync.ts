/**
 * Offline-first sync for a single collection.
 *
 * Pulls the server changefeed (`GET /api/items/:slug/changes`) into a local
 * store, keeps it live over SSE, and lets the app read/write while offline:
 * writes apply optimistically to the local store and queue, then flush through
 * the batch endpoint on reconnect. Conflicts resolve last-write-wins by
 * `updated_at`, with locally-queued (not-yet-flushed) writes held until they
 * land.
 *
 * The store is pluggable — `memoryStore()` works anywhere; `indexedDbStore()`
 * persists across reloads in the browser.
 */

/** A locally-queued offline write awaiting flush to the server. */
export type QueuedOp =
  | { kind: "create"; tempId: string; data: Record<string, unknown> }
  | { kind: "update"; id: string; data: Record<string, unknown> }
  | { kind: "delete"; id: string };

/** Pluggable persistence for the local sync store (rows + meta + write queue). */
export interface SyncStore {
  get(id: string): Promise<Record<string, unknown> | undefined>;
  set(id: string, row: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<Record<string, unknown>[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  queueGet(): Promise<QueuedOp[]>;
  queueSet(ops: QueuedOp[]): Promise<void>;
}

/** In-memory store — non-persistent; the default and the testing baseline. */
export const memoryStore = (): SyncStore => {
  const rows = new Map<string, Record<string, unknown>>();
  const meta = new Map<string, string>();
  let queue: QueuedOp[] = [];
  return {
    async get(id) { return rows.get(id); },
    async set(id, row) { rows.set(id, row); },
    async remove(id) { rows.delete(id); },
    async all() { return [...rows.values()]; },
    async getMeta(k) { return meta.get(k) ?? null; },
    async setMeta(k, v) { meta.set(k, v); },
    async queueGet() { return [...queue]; },
    async queueSet(ops) { queue = [...ops]; },
  };
};

/** IndexedDB-backed store (browser). One object store for rows + one for meta;
 *  the write queue lives under a meta key. Falls back to throwing if IndexedDB
 *  is unavailable — use `memoryStore()` outside the browser. */
export const indexedDbStore = (opts: { collection: string; dbName?: string }): SyncStore => {
  const dbName = opts.dbName ?? "backlex-sync";
  const rowsStore = `rows:${opts.collection}`;
  const metaStore = `meta:${opts.collection}`;
  const idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) throw new Error("indexedDbStore requires a browser with IndexedDB; use memoryStore()");

  let dbp: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(rowsStore)) db.createObjectStore(rowsStore);
        if (!db.objectStoreNames.contains(metaStore)) db.createObjectStore(metaStore);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  };
  const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    get: (id) => tx(rowsStore, "readonly", (s) => s.get(id)),
    set: (id, row) => tx(rowsStore, "readwrite", (s) => s.put(row, id)).then(() => {}),
    remove: (id) => tx(rowsStore, "readwrite", (s) => s.delete(id)).then(() => {}),
    all: () => tx(rowsStore, "readonly", (s) => s.getAll()),
    getMeta: (k) => tx<string | undefined>(metaStore, "readonly", (s) => s.get(k)).then((v) => v ?? null),
    setMeta: (k, v) => tx(metaStore, "readwrite", (s) => s.put(v, k)).then(() => {}),
    queueGet: () => tx<string | undefined>(metaStore, "readonly", (s) => s.get("__queue")).then((v) => (v ? JSON.parse(v) : [])),
    queueSet: (ops) => tx(metaStore, "readwrite", (s) => s.put(JSON.stringify(ops), "__queue")).then(() => {}),
  };
};

/** The subset of the backlex client `createSync` needs. The full client satisfies it. */
export interface SyncClientLike {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  subscribe: (
    channel: string,
    onEvent: (e: { event: "created" | "updated" | "deleted"; data: Record<string, unknown> }) => void,
    onError?: (err: unknown) => void,
  ) => () => void;
}

/** Options for `client.sync(...)` / `createSync(...)`. */
export interface SyncOptions {
  collection: string;
  store?: SyncStore;
  /** Primary-key field. Default `id`. */
  pk?: string;
  /** Rows per changefeed page. Default 200. */
  pageSize?: number;
  /** Called after the local store changes (pull / live / local write). */
  onChange?: () => void;
}

interface ChangesResponse {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
}

const isOnline = (): boolean => {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine ?? true;
};

/** Live, offline-first controller for one collection, returned by `createSync`. */
export interface SyncController {
  /** Drain the changefeed from the saved cursor to head; returns rows applied. */
  pull(): Promise<number>;
  /** Flush queued offline writes through the batch endpoint. */
  flush(): Promise<void>;
  /** Subscribe to live SSE updates; returns an unsubscribe function. */
  live(): () => void;
  /** Pull, go live, and re-sync whenever connectivity returns. */
  start(): Promise<void>;
  /** Stop live updates and remove the online listener. */
  stop(): void;
  /** Every row currently in the local store. */
  getAll(): Promise<Record<string, unknown>[]>;
  /** One row by id from the local store. */
  get(id: string): Promise<Record<string, unknown> | undefined>;
  /** Optimistically create a row locally + queue the write; returns the temp id. */
  create(data: Record<string, unknown>): Promise<string>;
  /** Optimistically update a row locally + queue the write. */
  update(id: string, data: Record<string, unknown>): Promise<void>;
  /** Optimistically remove a row locally + queue the delete. */
  remove(id: string): Promise<void>;
  /** The underlying pluggable local store. */
  store: SyncStore;
}

export const createSync = (client: SyncClientLike, options: SyncOptions): SyncController => {
  const store = options.store ?? memoryStore();
  const pk = options.pk ?? "id";
  const pageSize = options.pageSize ?? 200;
  const slug = encodeURIComponent(options.collection);
  const notify = () => options.onChange?.();

  const pendingIds = async (): Promise<Set<string>> => {
    const q = await store.queueGet();
    const s = new Set<string>();
    for (const op of q) s.add(op.kind === "create" ? op.tempId : op.id);
    return s;
  };

  const applyRow = async (row: Record<string, unknown>, skip: Set<string>) => {
    const id = String(row[pk]);
    if (skip.has(id)) return; // local pending write wins until flushed
    // Changefeed marks tombstones with `_deleted`; realtime delete events carry
    // the row too — treat either as a removal.
    if (row._deleted === true || row.deleted_at != null) await store.remove(id);
    else await store.set(id, row);
  };

  /** Drain the changefeed from the saved cursor to the head. */
  const pull = async (): Promise<number> => {
    let cursor = await store.getMeta("cursor");
    let total = 0;
    const skip = await pendingIds();
    for (;;) {
      const qs = `?limit=${pageSize}${cursor ? `&since=${encodeURIComponent(cursor)}` : ""}`;
      const res = await client.request<ChangesResponse>("GET", `/api/items/${slug}/changes${qs}`);
      for (const row of res.data) await applyRow(row, skip);
      total += res.data.length;
      if (res.cursor) { cursor = res.cursor; await store.setMeta("cursor", cursor); }
      if (!res.hasMore) break;
    }
    if (total) notify();
    return total;
  };

  /** Flush queued offline writes via the batch endpoint. Reconciles temp ids. */
  const flush = async (): Promise<void> => {
    const queue = await store.queueGet();
    if (queue.length === 0 || !isOnline()) return;
    const operations = queue.map((op) =>
      op.kind === "create"
        ? { op: "create" as const, data: op.data }
        : op.kind === "update"
          ? { op: "update" as const, id: op.id, data: op.data }
          : { op: "delete" as const, id: op.id },
    );
    const res = await client.request<{ data: { results: { index: number; ok: boolean; id?: string; data?: Record<string, unknown> }[] } }>(
      "POST",
      `/api/items/${slug}/batch`,
      { operations },
    );
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i];
      const r = res.data.results[i];
      if (!op || !r || !r.ok) continue;
      // A create's optimistic temp row is replaced by the server-assigned row.
      if (op.kind === "create") {
        await store.remove(op.tempId);
        if (r.data) await store.set(String(r.data[pk]), r.data);
      } else if (op.kind === "update" && r.data) {
        await store.set(String(r.data[pk]), r.data);
      }
    }
    // Keep only ops the server didn't confirm (so a partial failure retries).
    const remaining = queue.filter((_, i) => !res.data.results[i]?.ok);
    await store.queueSet(remaining);
    notify();
  };

  const enqueue = async (op: QueuedOp) => {
    const q = await store.queueGet();
    q.push(op);
    await store.queueSet(q);
    if (isOnline()) await flush().catch(() => {});
  };

  // ── Local-first reads/writes ───────────────────────────────────────────────
  const getAll = () => store.all();
  const get = (id: string) => store.get(id);

  const create = async (data: Record<string, unknown>): Promise<string> => {
    const tempId = `tmp_${Math.abs(hash(JSON.stringify(data) + (await store.getMeta("seq")) )).toString(36)}_${(await bump())}`;
    await store.set(tempId, { ...data, [pk]: tempId, _pending: true });
    await enqueue({ kind: "create", tempId, data });
    notify();
    return tempId;
  };
  const update = async (id: string, data: Record<string, unknown>): Promise<void> => {
    const cur = (await store.get(id)) ?? {};
    await store.set(id, { ...cur, ...data });
    await enqueue({ kind: "update", id, data });
    notify();
  };
  const remove = async (id: string): Promise<void> => {
    await store.remove(id);
    await enqueue({ kind: "delete", id });
    notify();
  };

  // monotonic counter for temp ids (stable across calls within a session)
  const bump = async (): Promise<number> => {
    const n = Number((await store.getMeta("seq")) ?? "0") + 1;
    await store.setMeta("seq", String(n));
    return n;
  };

  // ── Live updates ───────────────────────────────────────────────────────────
  let unsub: (() => void) | null = null;
  let onlineHandler: (() => void) | null = null;
  const live = (): (() => void) => {
    unsub?.();
    unsub = client.subscribe(`items:${options.collection}`, (e) => {
      // SSE reflects committed server state; a `deleted` event removes by id.
      const row = e.event === "deleted" ? { ...e.data, _deleted: true } : e.data;
      void applyRow(row, new Set<string>()).then(notify);
    });
    return () => { unsub?.(); unsub = null; };
  };

  /** Pull, go live, and flush whenever connectivity returns. */
  const start = async (): Promise<void> => {
    await pull();
    await flush().catch(() => {});
    live();
    const target = globalThis as { addEventListener?: (t: string, h: () => void) => void };
    if (target.addEventListener) {
      onlineHandler = () => { void flush().then(() => pull()).catch(() => {}); };
      target.addEventListener("online", onlineHandler);
    }
  };
  const stop = (): void => {
    unsub?.(); unsub = null;
    const target = globalThis as { removeEventListener?: (t: string, h: () => void) => void };
    if (onlineHandler && target.removeEventListener) target.removeEventListener("online", onlineHandler);
    onlineHandler = null;
  };

  return { pull, flush, live, start, stop, getAll, get, create, update, remove, store };
};

// Small deterministic string hash for temp-id entropy (FNV-1a).
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
};
