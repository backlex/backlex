---
title: Draft / publish
description: First-class draft and published states for content collections — auto-hidden drafts, a dedicated publish permission, and scheduled (timed) publishing applied by the cron tick.
---

Content collections can carry a **draft → published** lifecycle. Mark a
collection `versioned` and every row gains a `_status` (`draft` / `published`)
plus `_published_at` and `_publish_at` system columns. Drafts are then **hidden
from readers** who can't publish, items can be **published now** or **scheduled**
for later, and publishing is gated by its own `publish` permission.

## Enabling it

Set `versioned: true` on the collection (at create, or PATCH later — the column
is added additively to the existing table):

```bash
bun backlex collections create articles --versioned \
  --field title:text --field body:longtext
```

New rows start as `draft`. Adopted tables that already have `_status` /
`_published_at` / `_publish_at` columns can opt in by setting `versioned: true`
on the metadata row.

## Reading: drafts are hidden by default

For a versioned collection the read API (REST list + get, and GraphQL) returns
**only published items** to callers who lack `publish` or `update` permission
(and aren't admins). This is automatic — there's nothing to add to your query.

Privileged callers (admins, or anyone with `publish` / `update` on the
collection) see everything by default and can narrow with `?status=`:

| `?status=` | Privileged caller | Read-only caller |
|---|---|---|
| *(omitted)* | all rows | published only |
| `published` | published only | published only |
| `draft` | drafts only | published only (ignored) |
| `all` | all rows | published only (ignored) |

A draft fetched by id returns `404` for a read-only caller. GraphQL applies the
same published-only default (privileged callers can still filter on `_status`
via the query filter). Realtime subscribers on `items:<collection>` only receive
draft/scheduled events if they can see drafts.

## Publishing

```
POST /api/items/{slug}/{id}/publish              → publish now
POST /api/items/{slug}/{id}/publish?unpublish=1  → revert to draft
POST /api/items/{slug}/{id}/publish  { "publishAt": "2026-07-01T09:00:00Z" }  → schedule
POST /api/items/{slug}/{id}/publish  { "publishAt": null }                    → cancel a schedule
```

All three require the **`publish`** permission on the collection (not `update`)
— so you can let editors draft and edit while only publishers go live. The
endpoint emits a realtime `published` / `unpublished` / `scheduled` event.

SDK:

```ts
await backlex.from("articles").publish(id);
await backlex.from("articles").unpublish(id);
await backlex.from("articles").schedulePublish(id, "2026-07-01T09:00:00Z");
await backlex.from("articles").schedulePublish(id, null); // cancel
// privileged reads:
await backlex.from("articles").list({ status: "draft" });
```

MCP: `items.publish`, `items.unpublish`, `items.schedule_publish`.

## Scheduled publishing

A future `publishAt` keeps the item a **draft** (so it stays hidden) and records
`_publish_at`. The cross-runtime cron tick (`publishDueItems`, the same tick that
drains the [job queue](/jobs/) and sweeps [resumable uploads](/resumable-uploads/))
flips every versioned-collection draft whose `_publish_at` has passed to
`published`, stamps `_published_at`, clears `_publish_at`, and emits a realtime
`published` event. No extra infrastructure — latency is up to ~1 minute on
Cloudflare Workers, ~30s on Bun.

A "scheduled" item is simply `_status = 'draft'` with a future `_publish_at`; the
admin UI surfaces this as a **Scheduled** badge. Editing the item, calling
`unpublish`, or `publishAt: null` cancels the pending publish.

## Permissions

`publish` is a first-class action in the [permission DSL](/permissions/)
alongside `read` / `create` / `update` / `delete`. Grant it to a role to let its
members publish/unpublish/schedule. Admins hold it implicitly. It is **not**
seeded by default — a fresh collection's `authenticated` role gets owner-scoped
CRUD but not `publish`.

## Limits & follow-ups

- Draft and published are one row's state, not two divergent versions — editing a
  published row changes what's live immediately (use a draft copy workflow if you
  need staged edits). See [revisions](/audit-logs/) for change history.
- `_publish_at` is a single absolute time (no recurring schedules, no
  auto-unpublish/expiry yet).
- Storage/collection backend selection is unchanged.
