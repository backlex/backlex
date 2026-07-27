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
 * The store is pluggable — `memoryStore()` works anywhere, `indexedDbStore()`
 * persists across reloads in the browser, and `sqliteStore()` adapts any SQLite
 * driver (bun:sqlite, expo-sqlite, op-sqlite, wa-sqlite…).
 *
 * A sync can replicate a **shape** — a filtered subset of the collection —
 * instead of the whole thing, and resolve conflicting writes by a configurable
 * policy instead of always last-write-wins. See `docs/offline-sync.md`.
 */

import { matchesCondition, shapeKey, type Condition } from "./condition";

/** A locally-queued offline write awaiting flush to the server.
 *
 *  An `update` also carries the row as it looked when the write was made
 *  (`base`) plus that row's `updatedAt` (`baseUpdatedAt`). Those two are what
 *  turn a blind overwrite into a real conflict decision: `baseUpdatedAt` is
 *  sent as the server-side precondition, and `base` is the common ancestor a
 *  three-way merge needs. */
export type QueuedOp =
  | { kind: "create"; tempId: string; data: Record<string, unknown> }
  | {
      kind: "update";
      id: string;
      data: Record<string, unknown>;
      base?: Record<string, unknown>;
      baseUpdatedAt?: string | null;
      /** Set after a conflict was resolved in the client's favour — the retry
       *  intentionally drops the precondition. */
      force?: boolean;
    }
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

/**
 * The two calls `sqliteStore` needs from a SQLite driver. Every driver spells
 * these differently, so you pass a four-line shim rather than backlex taking a
 * dependency on one of them:
 *
 * ```ts
 * // bun:sqlite / better-sqlite3
 * const db = new Database("app.db");
 * sqliteStore({ collection: "notes", db: {
 *   run: (sql, p = []) => db.prepare(sql).run(...p),
 *   all: (sql, p = []) => db.prepare(sql).all(...p),
 * }});
 *
 * // expo-sqlite (React Native)
 * sqliteStore({ collection: "notes", db: {
 *   run: (sql, p = []) => db.runAsync(sql, p),
 *   all: (sql, p = []) => db.getAllAsync(sql, p),
 * }});
 * ```
 */
export interface SqliteLike {
  run(sql: string, params?: unknown[]): unknown | Promise<unknown>;
  all(sql: string, params?: unknown[]): unknown[] | Promise<unknown[]>;
}

/**
 * SQLite-backed store — the persistence option for React Native and for
 * browsers/desktop apps that already keep a SQLite file around. Rows are stored
 * as JSON keyed by id, which keeps the store schema-free: a collection can gain
 * or lose fields without a client-side migration.
 *
 * Table names are derived from the collection and sanitized to
 * `[a-z0-9_]` — they're interpolated into DDL, which can't take a bound
 * parameter, so nothing else may reach the statement.
 */
export const sqliteStore = (opts: {
  collection: string;
  db: SqliteLike;
  /** Table-name prefix. Default `backlex_sync`. */
  prefix?: string;
}): SyncStore => {
  const safe = (s: string) => s.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const base = `${safe(opts.prefix ?? "backlex_sync")}_${safe(opts.collection)}`;
  const rowsTbl = `${base}_rows`;
  const metaTbl = `${base}_meta`;
  const db = opts.db;

  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        await db.run(`CREATE TABLE IF NOT EXISTS ${rowsTbl} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
        await db.run(`CREATE TABLE IF NOT EXISTS ${metaTbl} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      })();
    }
    return ready;
  };
  /** Drivers disagree on row shape (object vs array); read the first value. */
  const firstValue = (r: unknown): string | null => {
    if (r == null) return null;
    if (typeof r === "string") return r;
    if (Array.isArray(r)) return r[0] == null ? null : String(r[0]);
    const vals = Object.values(r as Record<string, unknown>);
    return vals[0] == null ? null : String(vals[0]);
  };

  const readMeta = async (key: string): Promise<string | null> => {
    await init();
    const rows = await db.all(`SELECT v FROM ${metaTbl} WHERE k = ?`, [key]);
    return firstValue(rows[0]);
  };
  const writeMeta = async (key: string, value: string): Promise<void> => {
    await init();
    await db.run(
      `INSERT INTO ${metaTbl} (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      [key, value],
    );
  };

  return {
    async get(id) {
      await init();
      const rows = await db.all(`SELECT data FROM ${rowsTbl} WHERE id = ?`, [id]);
      const raw = firstValue(rows[0]);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    },
    async set(id, row) {
      await init();
      await db.run(
        `INSERT INTO ${rowsTbl} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [id, JSON.stringify(row)],
      );
    },
    async remove(id) {
      await init();
      await db.run(`DELETE FROM ${rowsTbl} WHERE id = ?`, [id]);
    },
    async all() {
      await init();
      const rows = await db.all(`SELECT data FROM ${rowsTbl}`);
      const out: Record<string, unknown>[] = [];
      for (const r of rows) {
        const raw = firstValue(r);
        if (raw) out.push(JSON.parse(raw) as Record<string, unknown>);
      }
      return out;
    },
    getMeta: readMeta,
    setMeta: writeMeta,
    async queueGet() {
      const raw = await readMeta("__queue");
      return raw ? (JSON.parse(raw) as QueuedOp[]) : [];
    },
    queueSet: (ops) => writeMeta("__queue", JSON.stringify(ops)),
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

/**
 * How a flush resolves a write the server refused because the row moved
 * underneath it.
 *
 * - `last-write-wins` (default) — don't ask. No precondition is sent, so the
 *   flush overwrites whatever is there. This is v1's behaviour, kept as the
 *   default so existing apps don't change semantics on upgrade.
 * - `server-wins` — drop the local write and keep the server's row.
 * - `client-wins` — retry the write without the precondition, overwriting.
 * - `merge` — call {@link SyncOptions.merge} with the local, server, and base
 *   rows and write back whatever it returns.
 * - `manual` — drop the write from the queue and hand it to
 *   {@link SyncOptions.onConflict}; the app decides what happens next.
 */
export type ConflictPolicy = "last-write-wins" | "server-wins" | "client-wins" | "merge" | "manual";

/** A write the server refused because the row changed after it was queued. */
export interface SyncConflict {
  id: string;
  /** The patch the client wanted to apply. */
  local: Record<string, unknown>;
  /** The row as the server has it now. */
  server: Record<string, unknown> | undefined;
  /** The row as it looked when the local write was queued (common ancestor). */
  base: Record<string, unknown> | undefined;
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
  /**
   * Replicate only the rows matching this filter instead of the whole
   * collection. Same JSON grammar as a list `filter`, but flat — no relation
   * hops (see `docs/offline-sync.md`). Changing the shape between runs is
   * detected and forces a clean re-sync.
   */
  shape?: Condition;
  /** Replicate only these columns. `id` and `updatedAt` always come along. */
  fields?: string[];
  /** How to resolve a write the server refused as stale. Default
   *  `last-write-wins`, which matches v1 and sends no precondition. */
  conflict?: ConflictPolicy;
  /** Three-way merge, required when `conflict: "merge"`. Return the patch to
   *  write. `base` is undefined when the ancestor wasn't recorded. */
  merge?: (c: SyncConflict) => Record<string, unknown>;
  /** Called for every conflict, whatever the policy — useful for telemetry.
   *  Under `conflict: "manual"` it's the only notification you get. */
  onConflict?: (c: SyncConflict) => void;
}

interface ChangesResponse {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
  shape?: string;
}

interface BatchResult {
  index: number;
  ok: boolean;
  id?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

const isOnline = (): boolean => {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine ?? true;
};

/** Live, offline-first controller for one collection (or one shape of it),
 *  returned by `createSync`. */
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
  const shape = options.shape ?? null;
  const shapeParam = shape ? `&shape=${encodeURIComponent(JSON.stringify(shape))}` : "";
  const fieldsParam = options.fields?.length
    ? `&fields=${encodeURIComponent(options.fields.join(","))}`
    : "";
  const policy: ConflictPolicy = options.conflict ?? "last-write-wins";

  const pendingIds = async (): Promise<Set<string>> => {
    const q = await store.queueGet();
    const s = new Set<string>();
    for (const op of q) s.add(op.kind === "create" ? op.tempId : op.id);
    return s;
  };

  /**
   * Rows the pull saw but held back because the id has an unflushed local
   * write. The cursor advances past them regardless, so without somewhere to
   * put them the server's version would be lost for good — and a later conflict
   * would have nothing to rebase against. Persisted so it survives a reload.
   */
  const deferredGet = async (): Promise<Record<string, Record<string, unknown>>> => {
    const raw = await store.getMeta("deferred");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  };
  const deferredSet = (d: Record<string, Record<string, unknown>>) =>
    store.setMeta("deferred", JSON.stringify(d));

  const applyRow = async (
    row: Record<string, unknown>,
    skip: Set<string>,
    defer?: Record<string, Record<string, unknown>>,
  ) => {
    const id = String(row[pk]);
    if (skip.has(id)) {
      // Local pending write wins until it flushes — but remember what the
      // server said, so the write can be reconciled against it later.
      if (defer) defer[id] = row;
      return;
    }
    // Three ways a row leaves the local store, and they mean different things:
    // `_deleted` — gone server-side; `_shape_exit` — still there, but no longer
    // ours to hold. Both drop the local copy; only the first is a deletion.
    if (row._deleted === true || row.deleted_at != null || row._shape_exit === true) {
      await store.remove(id);
    } else {
      await store.set(id, row);
    }
  };

  /**
   * The shape a local store was populated with. If the caller has since changed
   * `shape`, every row and the cursor belong to the *old* subset — layering a
   * new shape's deltas on top would leave rows no pull would ever correct. So
   * the store is emptied and re-synced from scratch. Queued offline writes
   * survive: they're the user's unsent work, not replicated state.
   */
  const reconcileShape = async (): Promise<void> => {
    const want = shapeKey(shape);
    const have = await store.getMeta("shape");
    if (have === want) return;
    if (have !== null) {
      for (const row of await store.all()) await store.remove(String(row[pk]));
      await store.setMeta("cursor", "");
    }
    await store.setMeta("shape", want);
  };

  /** Drain the changefeed from the saved cursor to the head. `unblock` names ids
   *  whose pending-write hold should be lifted for this pass (used while
   *  resolving a conflict, where the fresh server row is the whole point). */
  const pullInner = async (unblock?: Set<string>): Promise<number> => {
    await reconcileShape();
    let cursor = (await store.getMeta("cursor")) || null;
    let total = 0;
    const skip = await pendingIds();
    if (unblock) for (const id of unblock) skip.delete(id);
    const defer = await deferredGet();
    const before = JSON.stringify(defer);
    for (;;) {
      const qs = `?limit=${pageSize}${cursor ? `&since=${encodeURIComponent(cursor)}` : ""}${shapeParam}${fieldsParam}`;
      const res = await client.request<ChangesResponse>("GET", `/api/items/${slug}/changes${qs}`);
      for (const row of res.data) await applyRow(row, skip, defer);
      total += res.data.length;
      if (res.cursor) { cursor = res.cursor; await store.setMeta("cursor", cursor); }
      if (!res.hasMore) break;
    }
    if (JSON.stringify(defer) !== before) await deferredSet(defer);
    if (total) notify();
    return total;
  };

  const pull = (): Promise<number> => pullInner();

  /** Send one pass of the queue through the batch endpoint. Returns the ops the
   *  server refused as stale, paired with their result, plus everything else
   *  that failed (kept queued to retry). */
  const flushOnce = async (
    queue: QueuedOp[],
  ): Promise<{ conflicts: { op: QueuedOp; result: BatchResult }[]; remaining: QueuedOp[] }> => {
    const operations = queue.map((op) =>
      op.kind === "create"
        ? { op: "create" as const, data: op.data }
        : op.kind === "update"
          ? {
              op: "update" as const,
              id: op.id,
              data: op.data,
              // Only send the precondition when the app actually wants to hear
              // about conflicts. Under last-write-wins (and on a client-wins
              // retry) we deliberately overwrite, so we don't ask.
              ...(policy !== "last-write-wins" && !op.force && op.baseUpdatedAt
                ? { ifUnmodifiedSince: op.baseUpdatedAt }
                : {}),
            }
          : { op: "delete" as const, id: op.id },
    );
    const res = await client.request<{ data: { results: BatchResult[] } }>(
      "POST",
      `/api/items/${slug}/batch`,
      { operations },
    );
    const conflicts: { op: QueuedOp; result: BatchResult }[] = [];
    const remaining: QueuedOp[] = [];
    const defer = await deferredGet();
    let stashChanged = false;
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i];
      const r = res.data.results[i];
      if (!op) continue;
      if (!r || !r.ok) {
        if (op.kind === "update" && r?.error?.code === "CONFLICT") conflicts.push({ op, result: r });
        else remaining.push(op); // transient / other failure — retry next flush
        continue;
      }
      // A create's optimistic temp row is replaced by the server-assigned row.
      if (op.kind === "create") {
        await store.remove(op.tempId);
        if (r.data) await store.set(String(r.data[pk]), r.data);
      } else if (op.kind === "update" && r.data) {
        await store.set(String(r.data[pk]), r.data);
      }
      // The write landed, so the stashed pre-write server row is history.
      const id = op.kind === "create" ? op.tempId : op.id;
      if (defer[id]) { delete defer[id]; stashChanged = true; }
    }
    if (stashChanged) await deferredSet(defer);
    return { conflicts, remaining };
  };

  /**
   * Turn refused writes into retries, per the configured policy.
   *
   * The server's current rows are re-pulled once for the whole conflict set
   * rather than fetched per row — conflicts arrive together, and the changefeed
   * already returns permission-correct rows, so there's no second code path
   * that could disagree about what the client is allowed to see.
   */
  const resolveConflicts = async (
    conflicts: { op: QueuedOp; result: BatchResult }[],
  ): Promise<QueuedOp[]> => {
    if (conflicts.length === 0) return [];
    const contested = new Set(conflicts.map((c) => (c.op as { id: string }).id));
    // Land any server versions this client already saw but held back, then pull
    // for anything newer. Don't let the queue's own pending-write guard hide
    // those rows — resolving these ops is exactly what we're doing.
    const defer = await deferredGet();
    let stashChanged = false;
    for (const id of contested) {
      const row = defer[id];
      if (!row) continue;
      await applyRow(row, new Set<string>());
      delete defer[id];
      stashChanged = true;
    }
    if (stashChanged) await deferredSet(defer);
    await pullInner(contested);

    const retries: QueuedOp[] = [];
    for (const { op } of conflicts) {
      if (op.kind !== "update") continue;
      const server = await store.get(op.id);
      const conflict: SyncConflict = { id: op.id, local: op.data, server, base: op.base };
      options.onConflict?.(conflict);
      if (policy === "server-wins") continue; // drop the write; pulled row stands
      if (policy === "manual") continue; // the app owns it now
      if (policy === "client-wins") {
        retries.push({ ...op, force: true });
      } else if (policy === "merge") {
        if (!options.merge) {
          throw new Error('sync: conflict: "merge" requires a `merge` function');
        }
        retries.push({ ...op, data: options.merge(conflict), force: true });
      }
    }
    // Re-apply each retry optimistically so the UI doesn't flash the server's
    // value before the retry lands.
    for (const op of retries) {
      if (op.kind !== "update") continue;
      const cur = (await store.get(op.id)) ?? {};
      await store.set(op.id, { ...cur, ...op.data });
    }
    return retries;
  };

  /**
   * Flush queued offline writes via the batch endpoint. Reconciles temp ids,
   * and resolves stale writes per {@link SyncOptions.conflict}.
   *
   * Resolution gets exactly one retry pass. A second conflict on the same op
   * means the row is being written faster than this client can rebase; looping
   * would just burn requests, so the op stays queued for the next flush.
   */
  const flush = async (): Promise<void> => {
    const queue = await store.queueGet();
    if (queue.length === 0 || !isOnline()) return;
    const first = await flushOnce(queue);
    let remaining = first.remaining;
    const retries = await resolveConflicts(first.conflicts);
    if (retries.length > 0) {
      const second = await flushOnce(retries);
      remaining = [...remaining, ...second.remaining, ...second.conflicts.map((c) => c.op)];
    }
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
    const existing = (await store.queueGet()).find(
      (o): o is Extract<QueuedOp, { kind: "update" }> => o.kind === "update" && o.id === id,
    );
    // Successive edits to the same row keep the FIRST edit's ancestor: the base
    // is "what the server had before this client started touching the row", and
    // re-baselining on each keystroke would quietly hide a concurrent edit that
    // arrived in between.
    const base = existing?.base ?? cur;
    const baseUpdatedAt = existing ? existing.baseUpdatedAt : updatedAtOf(cur);
    await enqueue({ kind: "update", id, data, base, baseUpdatedAt });
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
      // The realtime channel carries the whole collection, so a shaped store has
      // to decide membership itself. `null` means the shape leans on something
      // only the server can resolve — fall back to a pull rather than guess.
      if (shape && row._deleted !== true) {
        const m = matchesCondition(row, shape);
        if (m === null) { void pull().catch(() => {}); return; }
        if (m === false) { void applyRow({ ...row, _shape_exit: true }, new Set<string>()).then(notify); return; }
      }
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

/** The row's `updatedAt` as an ISO string, tolerating the snake_case mirror and
 *  a Date. Null when the collection doesn't track one — the precondition is
 *  then simply not sent and the write falls back to last-write-wins. */
const updatedAtOf = (row: Record<string, unknown>): string | null => {
  const v = row.updatedAt ?? row.updated_at;
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

// Small deterministic string hash for temp-id entropy (FNV-1a).
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
};
