---
title: Item views
description: Four ways to look at the same collection — Table, Kanban, Gallery and Calendar — how a card gets its label, what the Kanban board groups by, and which moves fire a real lifecycle action.
---

Every collection's item list renders through one of four views. They are four
readings of the **same query** — the same filters, the same sort, the same
permission scope — not four different data sets.

| View | What it is for | Needs |
|---|---|---|
| **Table** | the default; sorting, inline edit, column picker, spreadsheet grid mode, bulk actions | — |
| **Kanban** | moving rows between the values of a status-shaped column | a dropdown field to group by |
| **Gallery** | scanning rows as cards | — |
| **Calendar** | seeing rows laid out across a month | a date to bucket by |

## Picking a view

The toggle sits above the list: a segmented strip on desktop, a dropdown below
`640px`. The choice lives in the URL as `?view=table|kanban|gallery|calendar`,
so a view is linkable and survives a reload.

Two guards:

- **An unknown `?view=` value falls back to `table`** rather than rendering
  nothing.
- **Kanban hides itself when there is nothing to group by.** If the collection
  has no dropdown field (and no `_status` lifecycle), the Kanban option is
  removed from the toggle *and* `?view=kanban` resolves to `table` — a
  hand-typed URL can't strand you on an empty board.

## How a card gets its label

Table rows show columns, so they don't need this. The other three views show a
**card**, and a card needs one line of text that identifies the row. Backlex
resolves it in order:

1. the collection's **display template**, if set (Settings → display template);
2. otherwise a scan for a title-ish field (`title`, then `name`, …);
3. otherwise the first two filled text fields, composed;
4. otherwise a **shortened id** — never a full UUID.

`localized` field maps collapse to the workspace content default language
(`i18nDefaultLocale`), then English.

Because step 4 is a poor label, the admin shows a prompt above the list when a
collection has **no display template and no `title`/`name` field** and you are
on a non-Table view. Setting a display template is the fix.

## Table

The default. Everything specific to it — the column picker, [spreadsheet grid
editing](/querying/), bulk select and the bulk bar — is Table-only and hidden
on the other three views. The **Live tail** toggle is not: it works in every
view.

## Kanban

### What it groups by

The board's columns come from a **status-shaped column**, resolved in this
order:

1. **Your explicit choice** — Settings → kanban (`kanbanGroupBy`), when it names
   a real dropdown field on the collection. A stale or renamed value falls
   through rather than breaking the board.
2. A field literally named **`status`** with a dropdown interface, so the
   bundled templates light up with no configuration.
3. Otherwise **any** dropdown field.

Columns are that field's own choices, in the order the field declares them, and
each column header carries a live count.

> **A row whose value matches no column is not on the board.** Columns are
> exact-match buckets over the field's declared choices, so a row holding a
> value that was removed from the choice list simply doesn't appear. It is still
> in the Table view. If rows go missing from a board, compare the field's
> choices against the values actually stored.

### Moving a card

Drag a card to another column and the row's field is written — optimistically,
so the card lands immediately and rolls back with a toast if the server refuses.

Two things happen **before** the write:

- **[Status transitions](/status-transitions/) are checked client-side.** If the
  field declares transitions and the move isn't allowed (by value or by your
  role), the card does not move and you get a toast. The server would refuse it
  anyway — but a card that visibly jumps and springs back reads as a bug, where
  a card that simply doesn't move reads as a rule.
- Dropping a card back into its own column is a no-op.

### The lifecycle board

On a [versioned collection](/draft-publish/) you can set the Kanban group-by to
**`_status`**. That board is different in kind: its columns are **draft /
published / archived**, and dragging a card fires the **real lifecycle action**
— publish, unpublish or archive — not a column write. So the move is
permission-gated as publishing, stamps `_published_at`, and emits the same
realtime event a publish from the editor does.

`_status` is deliberately kept out of the Table view's inline-editable status
column: that column must stay a writable user field, and the lifecycle is not
one.

### Making a custom column trigger the lifecycle

The two axes can be joined. On a versioned collection, Settings → kanban lets
you map a group-by **value** to a lifecycle **action** — `done → publish`, say.
Then dragging a card into the `done` column both writes `stage = "done"` and
publishes the row, so the board column and the lifecycle stay in step. This is
the "special folder" model: ordinary grouping columns coexist with a few that
mean something to the system.

Unmapped values stay ordinary column writes.

### The per-column `+`

Each column header has a `+` that opens the create form with **that column's
value pre-filled** — it appends `?new=<field>:<value>` to the URL and the editor
seeds the new row from it. It is skipped on the `_status` board, where every new
item is a draft by definition.

## Gallery

A responsive grid of cards, each showing the row label, its status badge when
the row has one, and the slug (or shortened id) over a cover area.

> **The cover is a generated gradient, not the row's image.** It is derived
> deterministically from the row id — the same row always gets the same two
> colours, and no request is made. Gallery does not read a file or image field
> today.

## Calendar

A month grid, Monday-first, with arrows to walk months. Each day cell lists up
to three rows and then `+N more`; clicking any entry opens the editor.

What it buckets by, exactly: the first of `published_at`, `publishedAt`,
`updated_at`, `updatedAt` that the row actually carries. Falling back to the
update time is deliberate — a freshly created draft has no publish date yet and
would otherwise be invisible on the calendar. A row with none of the four, or an
unparseable value, is skipped.

Two things to know:

- **Bucketing is UTC.** A row timestamped late in the evening in a timezone
  ahead of UTC lands on the following day's cell.
- **The date field is not configurable.** A collection whose meaningful date is
  `due_at` or `starts_at` will not be laid out by it.

## Limits

- **The alternate views render the rows the list already fetched — up to the
  API's default page of 50** (hard cap 200). They are a reading of the current
  page, not of the whole collection, so a Kanban column count is a count of
  what's loaded. Narrow with filters rather than expecting the board to hold
  everything.
- **Kanban / Gallery / Calendar are admin-UI views.** They are not a stored
  per-user preference, an API concept, or something the SDK exposes — `?view=`
  is the whole of their state. What *is* stored on the collection is the
  group-by choice and the action map (`kanbanGroupBy`, `kanbanActionMap`), which
  travel with a [schema template](/templates/) and a
  [schema version](/schema-versions/).
- Table-only affordances (column picker, grid edit, bulk bar) do not appear on
  the other three.

## See also

- [Draft / publish](/draft-publish/) — the `_status` lifecycle the Kanban board
  can drive
- [Status transitions](/status-transitions/) — which value a status may move to
- [Querying](/querying/) — the filters and sort every view shares
