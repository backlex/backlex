---
title: Change data capture
description: Deliver a collection's changefeed — deletes included — to a webhook or to your own bucket, at-least-once with a watermark backlex keeps for you.
---

[Offline sync](/docs/offline-sync) gave the API an incremental changefeed:
`/{slug}/changes` returns rows changed since a cursor, **including delete
tombstones and shape move-out markers**, keyset-paginated so a reader resumes
exactly where it stopped.

What it had was no consumer other than a client polling it. Replicating a
collection into a warehouse, a queue or an archive meant writing that poller,
holding the cursor yourself, and getting the retry semantics right.

```bash
backlex cdc create --name warehouse --collection orders \
  --url https://ingest.example.com/backlex --secret whsec_…
```

From there backlex advances the sink one page per cron tick, remembers how far
it got, and retries what did not land.

## What a destination receives

```json
{
  "sink": "warehouse",
  "collection": "orders",
  "records": [
    { "key": "orders:ord_42:1786290000000", "op": "upsert", "data": { … } },
    { "key": "orders:ord_17:1786290100000", "op": "delete", "data": { "id": "ord_17", … } }
  ]
}
```

| `op` | Means |
|---|---|
| `upsert` | the row changed — insert or update it |
| `delete` | a tombstone — **remove it** |
| `exit` | the row stopped matching this sink's `shape` — remove it from the replica, though it still exists |

**A destination that treats all three as an upsert keeps deleted rows forever.**
That distinction is the whole reason this reads the changefeed rather than
selecting rows by `updated_at` — a sink built that way replicates every insert
and update and silently never replicates a delete, which makes a warehouse
quietly wrong rather than obviously broken.

## At-least-once, and why

The cursor advances **only after a batch is acknowledged**. A failed delivery
leaves it where it was, so the same batch is retried on the next tick.

That means duplicates are possible and losses are not. Every record carries a
`key` of `<collection>:<id>:<version>` which is **identical across retries**, so
a destination keyed on it converges. The alternative — advance first, deliver
after — loses rows on any failure with nobody able to say which ones.

Fifteen consecutive failures disable the sink, the same breaker outbound
[webhooks](/docs/webhooks) and [sync hooks](/docs/sync-hooks) use. Re-enabling
clears the counter.

## Destinations

**`webhook`** — POST each batch to a URL. With a `secret`, it is signed with
[Standard Webhooks](https://www.standardwebhooks.com) headers, the same scheme
[auth hooks](/docs/auth-hooks) use, so an app that already verifies one of ours
needs no second implementation. The URL goes through the same SSRF guard every
other admin-supplied URL does.

**`storage`** — NDJSON objects in this workspace's own bucket, one per batch,
under `<prefix>/<collection>/`. They appear in the file browser and count toward
storage usage like any other object — and the [S3 endpoint](/docs/s3) can read
them, so `rclone sync` moves them anywhere from there.

The object name is derived from the cursor the batch **started** at, so a retry
overwrites its own object instead of adding a second one. At-least-once delivery
should not show up as duplicate files, which is the one thing a reader of a
bucket cannot deduplicate.

## What a sink replicates

A sink reads the collection **unconditionally** — not through the permissions of
whoever created it. That is deliberate: resolving the creator's row conditions
would make the replica a silent subset that changes if their role does.

The narrowing knob is `shape`, a flat filter in the same grammar the changefeed
takes:

```bash
backlex cdc create --name eu-only --collection orders \
  --url https://… --shape '{"region":{"_eq":"eu"}}'
```

A row that *stops* matching comes back as `op: "exit"` rather than not at all —
your replica has to be told to drop it.

`--fields` projects columns. `--batch` sets how many records go in one delivery
(default 100, max 500).

## Operating one

```bash
backlex cdc run <id>     # advance one page now and print the result
backlex cdc list         # how far each sink is, and its last error
```

`run` goes through the same code the cron does, so it is a real delivery rather
than a simulation — and it prints the destination's error, which is the
difference between "the destination is refusing this" and "there is nothing to
send".

`--reset-cursor` replays the collection from the beginning. It is the one
operation here that can flood a destination, so it is never implicit.

## Surfaces

| Surface | Where |
|---|---|
| REST | `/api/admin/cdc-sinks` |
| SDK | `backlex.cdc.*` |
| MCP | `cdc.list/create/update/run/delete` |
| CLI | `backlex cdc …` |
