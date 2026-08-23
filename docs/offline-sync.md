---
title: Offline-first sync
description: Keep a local copy of a collection — or just the slice you care about — that works offline. Pull an incremental changefeed with delete tombstones and shape move-out markers, stay live over SSE, and queue writes while disconnected, resolving conflicts by a policy you choose.
---

Backlex can keep a **local-first** copy of a collection: reads and writes hit a
local store immediately, a background loop pulls server changes, and writes made
while offline flush automatically when the connection returns. It's built from
two server primitives plus a client `sync` module.

Three things you can tune, in rough order of how often you'll want them:

- **Shape** — replicate a *subset* of a collection instead of all of it.
- **Store** — where the local copy lives (memory, IndexedDB, SQLite).
- **Conflict policy** — what happens when your offline write races someone else's.

## Server: the changefeed

```
GET /api/items/{slug}/changes?since=<cursor>&limit=<n>&shape=<filter>&fields=<a,b>
→ { "data": [ …rows… ], "cursor": "<opaque>", "hasMore": true|false, "shape": "<key>" }
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

Also available as `client.from(slug).changes(…)` in the SDK, the
`<collection>Changes` GraphQL query, the `collections.changes` MCP tool, and
`backlex items changes <slug>`. All five run the same server-side service — the
permission, tenant, draft and shape rules exist in exactly one place.

Per-item history is exposed separately:

```
GET /api/items/{slug}/{id}/revisions   → { "data": [ …snapshots, newest first… ] }
```

### Shapes: replicating a subset

A **shape** is a filter naming the rows a client actually wants. It uses the
same JSON grammar as a list `filter`:

```
GET /api/items/tasks/changes?shape={"status":{"_eq":"open"}}
```

Matching rows come back in full. The interesting case is a row that **stops**
matching — someone closed your task. It's not deleted, so there's no tombstone,
and it no longer matches the filter, so a naive filtered feed would just never
mention it again and your local store would keep a stale copy forever. So the
feed returns a **move-out marker** instead:

```json
{ "id": "abc123", "_shape_exit": true }
```

Id only, no payload. The client drops the row. A row that later re-enters the
shape arrives in full again.

Two restrictions make this sound, and both are enforced with a `422`:

- **Flat fields only** — no relation hops (`customer.tier`). Membership has to
  be decidable from the row itself; if it depended on a second table, a change
  over there would move rows in and out of your shape with no entry in *this*
  collection's feed to carry the news.
- **No hashed fields** — same reason the list filter rejects them: it would turn
  the feed into a digest-verification oracle.

A shape is **not** a security boundary — permissions are. The shape decides what
a client bothers to replicate; `permission` decides what it's allowed to see,
and it's applied underneath every shape query. A field the caller can't read
can't be shaped on either.

The response echoes a stable `shape` key. The client stores it and re-syncs from
scratch if it ever changes, so a new shape never gets layered over rows
replicated under the old one.

### Optimistic concurrency on writes

`POST /api/items/{slug}/batch` accepts a per-operation precondition:

```json
{ "operations": [
  { "op": "update", "id": "abc", "data": { "title": "mine" },
    "ifUnmodifiedSince": "2026-07-27T10:00:00.000Z" }
]}
```

If the row moved since that timestamp the op fails with `CONFLICT` and
`error.details.currentUpdatedAt`, while every other op in the batch still lands.
Omitting the field keeps last-write-wins. (The single-item `PATCH` route has had
the same guard via the `x-if-unmodified-since` header.)

## Client: `sync`

```ts
import { createClient, indexedDbStore } from "backlex";
const backlex = createClient({ url, apiKey });

const tasks = backlex.sync({
  collection: "tasks",
  store: indexedDbStore({ collection: "tasks" }), // persists across reloads
  shape: { status: { _eq: "open" } },             // replicate only open tasks
  fields: ["title", "status", "due"],             // and only these columns
  conflict: "merge",
  merge: ({ local, server }) => ({ ...server, ...local }),
  onChange: () => render(),                       // re-render on any local change
});

await tasks.start();        // pull → go live (SSE) → auto-flush on reconnect

// local-first reads (served from the store)
await tasks.getAll();
await tasks.get(id);

// local-first writes — applied optimistically, queued, flushed when online
const tempId = await tasks.create({ title: "Draft" }); // temp id until it lands
await tasks.update(id, { title: "Edited" });
await tasks.remove(id);

await tasks.flush();        // force a queue flush
tasks.stop();               // stop live updates
```

### How it behaves

- **Pull** drains the changefeed from the saved cursor and applies each row to
  the store — upsert live rows, delete tombstones, drop move-outs — persisting
  the new cursor.
- **Live** subscribes to `items:<collection>` (SSE) and applies events as they
  arrive. Under a shape the client evaluates membership locally, so an event for
  a row outside the shape is dropped and a row edited *out* of it is removed
  immediately. If the shape references something only the server can resolve
  (`$user.id`, a relation hop), the client doesn't guess — it triggers a pull.
- **Offline writes** apply to the local store immediately and enqueue. `create`
  uses a temporary `tmp_…` id; on flush, the server-assigned row replaces it.
- **Flush** sends the queue through the [batch endpoint](/docs/querying/) in one
  request and reconciles results; unconfirmed ops stay queued to retry. It runs
  automatically on `create`/`update`/`delete` when online and on the browser
  `online` event.
- **Changing the shape** between runs is detected via the shape key: the store
  is emptied and re-synced from scratch. Queued offline writes survive — they're
  the user's unsent work, not replicated state.

### Conflict policies

By default a flush overwrites whatever is on the server (`last-write-wins`),
which is v1's behaviour. Set `conflict` to something else and the client sends
each queued update's original `updatedAt` as a precondition, so the server can
tell it which writes raced:

| Policy | What happens on a refused write |
|---|---|
| `last-write-wins` *(default)* | No precondition sent — the write overwrites. |
| `server-wins` | Drop the local write; keep the server's row. |
| `client-wins` | Retry without the precondition; the local write overwrites. |
| `merge` | Call `merge({ local, server, base })` and write the result. |
| `manual` | Drop the op and hand it to `onConflict`; your app decides. |

`onConflict` fires under every policy, so you can log or count conflicts
regardless of how they're resolved.

The **base** is the row as it looked when the write was queued — the common
ancestor a three-way merge needs. Successive edits to the same row keep the
*first* edit's base, so a concurrent change that arrived mid-editing is still
visible to your merge function rather than being quietly absorbed.

Resolution gets exactly one retry pass. A row being written faster than a client
can rebase stays queued for the next flush instead of spinning.

### Stores

- `memoryStore()` — non-persistent; works in any runtime (and in tests).
- `indexedDbStore({ collection, dbName? })` — persists across reloads in the
  browser.
- `sqliteStore({ collection, db })` — any SQLite driver, via a small shim:

  ```ts
  import { Database } from "bun:sqlite"; // or better-sqlite3
  const db = new Database("app.db");
  sqliteStore({ collection: "tasks", db: {
    run: (sql, p = []) => db.prepare(sql).run(...p),
    all: (sql, p = []) => db.prepare(sql).all(...p),
  }});

  // expo-sqlite (React Native)
  sqliteStore({ collection: "tasks", db: {
    run: (sql, p = []) => db.runAsync(sql, p),
    all: (sql, p = []) => db.getAllAsync(sql, p),
  }});
  ```

  Rows are stored as JSON keyed by id, so the local schema never needs a
  migration when a collection gains or loses a field.
- Bring your own by implementing the `SyncStore` interface (rows + meta +
  the write queue).

## Limits & notes

- Delete detection requires `softDelete: true` on the collection (tombstones).
- Shapes are flat — see the restriction note above.
- Field-level automatic merge is not built in; `conflict: "merge"` hands you
  `local` / `server` / `base` and you decide.
- The changefeed needs an `updated_at` column (managed collections always have
  one; adopted tables can alias it).
