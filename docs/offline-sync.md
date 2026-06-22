---
title: Offline-first sync
description: Keep a local copy of a collection that works offline — pull an incremental changefeed (with delete tombstones), stay live over SSE, and queue writes while disconnected, flushing them on reconnect with last-write-wins conflict resolution.
---

backlex can keep a **local-first** copy of a collection: reads and writes hit a
local store immediately, a background loop pulls server changes, and writes made
while offline flush automatically when the connection returns. It's built from
two server primitives plus a client `sync` module.

## Server: the changefeed

```
GET /api/items/{slug}/changes?since=<cursor>&limit=<n>
→ { "data": [ …rows… ], "cursor": "<opaque>", "hasMore": true|false }
```

- Returns rows whose `updated_at` is **past the cursor**, keyset-paginated on
  `(updated_at, id)` — no skipped or duplicated rows across pages.
- **Includes soft-deleted tombstones** (marked `_deleted: true`) so a client can
  drop rows that were deleted while it was away. (Soft-delete bumps `updated_at`,
  so deletes always reach the feed — the collection must have `softDelete: true`
  for deletes to be observable; a hard delete leaves no tombstone.)
- Permission-aware — same row/field rules and draft-hiding as the list endpoint.
- Omit `since` for a full initial sync; pass the previous response's `cursor`
  for the incremental delta.

Per-item history is also exposed:

```
GET /api/items/{slug}/{id}/revisions   → { "data": [ …snapshots, newest first… ] }
```

## Client: `sync`

```ts
import { createClient, indexedDbStore } from "backlex";
const backlex = createClient({ url, apiKey });

const notes = backlex.sync({
  collection: "notes",
  store: indexedDbStore({ collection: "notes" }), // persists across reloads
  onChange: () => render(),                        // re-render on any local change
});

await notes.start();        // pull → go live (SSE) → auto-flush on reconnect

// local-first reads (synchronous-feeling, served from the store)
await notes.getAll();
await notes.get(id);

// local-first writes — applied optimistically, queued, flushed when online
const tempId = await notes.create({ title: "Draft" }); // temp id until it lands
await notes.update(id, { title: "Edited" });
await notes.remove(id);

await notes.flush();        // force a queue flush
notes.stop();               // stop live updates
```

### How it behaves

- **Pull** drains the changefeed from the saved cursor and applies each row to the
  store (upsert live rows, delete tombstones), persisting the new cursor.
- **Live** subscribes to `items:<collection>` (SSE) and applies events as they
  arrive, so the store stays fresh between pulls.
- **Offline writes** apply to the local store immediately and enqueue. `create`
  uses a temporary `tmp_…` id; on flush, the server-assigned row replaces it.
- **Flush** sends the queue through the [batch endpoint](/querying/) in one
  request and reconciles results; unconfirmed ops stay queued to retry. It runs
  automatically on `create`/`update`/`delete` when online and on the browser
  `online` event.
- **Conflicts** resolve last-write-wins by `updated_at`, except a row with a
  **pending local write** is held (not overwritten by a pull) until it flushes.

### Stores

- `memoryStore()` — non-persistent; works in any runtime (and in tests).
- `indexedDbStore({ collection, dbName? })` — persists across reloads in the
  browser.
- Bring your own by implementing the `SyncStore` interface (rows + meta +
  the write queue) for React Native / SQLite / etc.

## Limits & notes

- Delete detection requires `softDelete: true` on the collection (tombstones).
- Conflict resolution is last-write-wins; field-level merge is not built in.
- The changefeed needs an `updated_at` column (managed collections always have
  one; adopted tables can alias it).
