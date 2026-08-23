---
title: Draft / publish
description: First-class draft and published states for content collections — auto-hidden drafts, a dedicated publish permission, and scheduled (timed) publishing applied by the cron tick.
---

Content collections can carry a **draft → published** lifecycle, plus an
**archived** state. Mark a collection `versioned` and every row gains a
`_status` (`draft` / `published` / `archived`) plus `_published_at` and
`_publish_at` system columns. Drafts **and archived rows** are **hidden from
readers** who can't publish, items can be **published now** or **scheduled** for
later or **archived** (pulled from publication), and every state change is gated
by the same `publish` permission.

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
| `archived` | archived only | published only (ignored) |
| `all` | all rows | published only (ignored) |

A draft fetched by id returns `404` for a read-only caller. GraphQL applies the
same published-only default (privileged callers can still filter on `_status`
via the query filter). Realtime subscribers on `items:<collection>` only receive
draft/scheduled events if they can see drafts.

## Publishing

```
POST /api/items/{slug}/{id}/publish              → publish now
POST /api/items/{slug}/{id}/publish?unpublish=1  → revert to draft
POST /api/items/{slug}/{id}/publish?archive=1    → archive (leave via publish/unpublish)
POST /api/items/{slug}/{id}/publish  { "publishAt": "2026-07-01T09:00:00Z" }  → schedule
POST /api/items/{slug}/{id}/publish  { "publishAt": null }                    → cancel a schedule
```

All of these require the **`publish`** permission on the collection (not
`update`) — so you can let editors draft and edit while only publishers go live.
The endpoint emits a realtime `published` / `unpublished` / `archived` /
`scheduled` event.

**Archiving** sets `_status = 'archived'` and clears both timestamps. An
archived row is hidden from readers exactly like a draft, but the distinct state
lets you tell "not yet published" apart from "was live, pulled down". There is no
separate unarchive verb — a normal `publish` (→ published) or `unpublish`
(→ draft) moves the row back out of archived.

SDK:

```ts
await backlex.from("articles").publish(id);
await backlex.from("articles").unpublish(id);
await backlex.from("articles").archive(id);
await backlex.from("articles").schedulePublish(id, "2026-07-01T09:00:00Z");
await backlex.from("articles").schedulePublish(id, null); // cancel
// privileged reads:
await backlex.from("articles").list({ status: "draft" });
await backlex.from("articles").list({ status: "archived" });
```

MCP: `items.publish`, `items.unpublish`, `items.archive`, `items.schedule_publish`,
`items.schedule_unpublish`.

## Scheduled unpublish (expiry)

The mirror of scheduled publishing: a future **`unpublishAt`** sets an expiry.
The item stays in its current state (typically `published`) until the cron tick
(`unpublishDueItems`, alongside `publishDueItems`) finds `_unpublish_at <= now`
and reverts it to **draft** — clearing `_published_at` and `_unpublish_at` and
emitting an `unpublished` event. Setting an expiry never changes the current
state or bumps `updated_at`; `{ unpublishAt: null }` cancels it. Publishing,
unpublishing, or archiving also clears any pending expiry.

```ts
await backlex.from("articles").scheduleUnpublish(id, "2026-09-01T00:00:00Z");
await backlex.from("articles").scheduleUnpublish(id, null); // cancel
```

## Scheduled publishing

A future `publishAt` keeps the item a **draft** (so it stays hidden) and records
`_publish_at`. The cross-runtime cron tick (`publishDueItems`, the same tick that
drains the [job queue](/docs/jobs/) and sweeps [resumable uploads](/docs/resumable-uploads/))
flips every versioned-collection draft whose `_publish_at` has passed to
`published`, stamps `_published_at`, clears `_publish_at`, and emits a realtime
`published` event. No extra infrastructure — latency is up to ~1 minute on
Cloudflare Workers, ~30s on Bun.

A "scheduled" item is simply `_status = 'draft'` with a future `_publish_at`; the
admin UI surfaces this as a **Scheduled** badge. Editing the item, calling
`unpublish`, or `publishAt: null` cancels the pending publish.

## Staged edits (draft ≠ live)

By default, draft and published are one row's state — editing a published row
changes what's live immediately. Turn on **`stagedEdits`** (Settings → "Staged
edits", versioned collections only) for a true staged workflow:

- A PATCH against a **published** row no longer touches the live row. The
  (validated) patch is stored as the item's **staged patch** — one JSON patch
  per item, merged shallowly per field across saves. Readers keep seeing the
  published content; the response carries `_staged: true` with the staged
  values previewed on top. `updated_at` doesn't move.
- **Publish applies the staged patch** (through the normal update path —
  validation, search/vector reindex, revisions, and events all fire), then
  publishes. Unpublish/archive/schedule fold the patch into the row as it
  leaves the published state, so the draft you land on carries your edits.
- Draft and archived rows keep editing **directly** — staging only guards the
  published state.
- Privileged reads flag pending patches: list rows and single GETs carry
  `_staged: true`; `?staged=1` on a single GET returns the merged preview.
  Read-only callers never see either.
- `PATCH …?live=1` bypasses staging and edits the live row directly — it
  requires the **publish** permission (the same bar as publishing), not just
  `update`. So with staging on, editors stage and publishers go live.
- `DELETE /api/items/{slug}/{id}/staged` discards the pending patch without
  applying it (`update` permission).

```ts
await backlex.from("articles").update(id, { title: "v2" }); // staged (row is published)
await backlex.from("articles").one(id, { staged: true });   // merged preview
await backlex.from("articles").publish(id);                 // applies + publishes
await backlex.from("articles").discardStaged(id);           // or drop the patch
await backlex.from("articles").update(id, { title: "hotfix" }, { live: true }); // bypass
```

MCP: `items.discard_staged` (updates stage automatically through the shared
route). The admin item editor shows a **Staged changes** badge, edits the
staged preview, and offers **Publish changes** / **Discard changes**.

## Permissions

`publish` is a first-class action in the [permission DSL](/docs/permissions/)
alongside `read` / `create` / `update` / `delete`. Grant it to a role to let its
members publish/unpublish/schedule. Admins hold it implicitly. It is **not**
seeded by default — a fresh collection's `authenticated` role gets owner-scoped
CRUD but not `publish`.

## Limits & follow-ups

- Without `stagedEdits`, draft and published are one row's state — editing a
  published row changes what's live immediately; the admin item editor flags
  this with an **Edited since publish** badge (`updated_at` is later than
  `_published_at`). Turn on [staged edits](#staged-edits-draft--live) for the
  separated workflow. See [revisions](/docs/audit-logs/) for change history.
- A staged patch stores the *patch*, not a full row snapshot. If the schema
  changes incompatibly between staging and publishing, the publish surfaces the
  validation error (fix or discard the patch).
- `_publish_at` / `_unpublish_at` are single absolute times (no recurring
  schedules).
- Storage/collection backend selection is unchanged.
