---
title: Date ranges
---

A **period** is two `timestamp` columns you already have, plus a declaration
tying them together:

```jsonc
{
  "name": "starts_at",
  "type": "timestamp",
  "range": {
    "end": "ends_at",     // the sibling column holding the end
    "bounds": "[)",       // default — the end is NOT inside the period
    "ordered": true       // default — refuse a row that ends before it begins
  }
}
```

Nothing is migrated and nothing moves. Both columns stay ordinary timestamps,
sortable and filterable as themselves. What the declaration buys is the part
that was impossible before: asking what **overlaps**.

## Why this is a declaration, not a new column type

Twenty-eight start/end pairs across fifteen of the twenty-seven schema templates
are a period — leases, contracts, campaigns, sprints, promotions, open houses,
payroll runs, blocked times. Three things were broken:

- **Overlap.** "Which leases clash with this one?" is the question those
  collections exist to be asked, and every caller hand-wrote it — *differently*.
  Whether a period ending at 10:00 collides with one starting at 10:00 was a
  convention nobody had written down, and getting it wrong double-books a room.
- **Open ends.** A contract with no end date is one that is still running. But
  `end_date >= today` excludes NULL, so the obvious "currently active" filter
  silently drops exactly the rows that ARE active — a query that looks right and
  returns a subset, with nothing to mark it.
- **Ordering.** Nothing stopped a row saving with its end before its start.

The obvious fix — one column holding both, a Postgres `tstzrange` or JSON — is
the wrong one three times over. SQLite has no range type, so it would not be
portable. All twenty-eight pairs would need a data migration. And sorting or
filtering by the start alone, the most common thing anyone does with these
columns, would get harder.

([#32 booking](./booking.md) solved overlap for *bookings*, with a partial unique
index. That is a real solution and it is not available to a lease or a sprint.)

## Bounds: the one decision that matters

`"[)"` — **half-open, the default.** The start is inside the period, the end is
not. It is the only convention under which back-to-back periods do not collide:
a room booked 09:00–10:00 and one booked 10:00–11:00 must both be allowed. Every
range of *instants* wants this.

`"[]"` — **closed.** Both endpoints are inside. This is what a range of *days*
means: leave "from Monday through Friday" includes Friday, so another request
starting Friday really does clash.

In the admin this is phrased as a question rather than as brackets — *when one
period ends exactly as another begins, do they clash?* — because that is the
consequence, and it is invisible until something double-books.

## Asking the questions

### `_overlaps` — what clashes with this window

```
?filter={"starts_at":{"_overlaps":{"start":"2026-09-15T00:00:00Z","end":"2026-09-20T00:00:00Z"}}}
```

A `[start, end]` array works too — it is what a date-range picker hands over.
Either side may be omitted, which means open in that direction:
`{"start":"2026-09-15T00:00:00Z"}` asks for everything that has not finished by
then. Omitting **both** is refused rather than answered with the whole table.

### `_covers` — what is in effect at an instant

```
?filter={"starts_at":{"_covers":"2026-09-18T00:00:00Z"}}
```

The degenerate overlap, and worth its own operator because "what applies right
now" is asked far more often than "what clashes with this".

### A NULL endpoint is an OPEN one

This is the sharp part. A row with `ends_at = NULL` has not ended, so it comes
back from every window after its start — including windows years later. A row
with `starts_at = NULL` has always applied. Both operators handle this; a
hand-written `ends_at >= X` does not.

### The start column is still a start column

`starts_at: { _gte: X }` is a perfectly good question and is not a range
question. Every ordinary operator still applies to the column, and sorting by it
is unchanged.

## Ordering

With `ordered` (the default), a write whose end is before its start is a 422
naming both columns. A **zero-length half-open** period is refused too: it
contains no instant at all, so it can never overlap anything and can never be in
effect — almost always a mistake, and invisible afterwards. Under closed bounds a
zero-length period is a single instant, which is coherent, so it is allowed.

An **empty** endpoint is always fine. That is an open period, not a broken one.

The rule runs on every write door — REST, the SDK, GraphQL, the batch endpoint,
flows, bookings, payment syncs. On the REST path it is judged against the fully
merged row, so a PATCH that moves only the end is compared against the stored
start.

## How the operators work, and why it matters

`_overlaps` and `_covers` never reach SQL as themselves. They are **expanded**
into `$and` / `$or` trees over the two real columns, using operators the DSL
already has (`_lt`, `_gte`, `_null`).

That is the whole portability argument. The condition DSL has two independent
implementations — compiled to SQL for queries, interpreted in JavaScript for
realtime delivery and the permission simulator. A new operator would have to be
written twice and the two would eventually disagree. An expansion into existing
operators cannot disagree with itself.

Same move as [geo](./geo.md)'s squared distances: change the question into one
the machinery already answers, rather than teaching the machinery a new one.

## A fix that came with this

A `timestamp` column is `INTEGER` epoch-ms on SQLite and `timestamptz` on
Postgres. Filter operands used to be bound exactly as they arrived — so an ISO
string, *the form every read hands back*, reached SQLite as TEXT and was compared
against an integer column. SQLite orders every number before every string, so the
comparison did not fail. It **inverted**:

```
# against a row dated 2026-09-15, on SQLite/D1, before the fix
?filter={"at":{"_gte":"2026-09-01T00:00:00Z"}}   → []      (wrong)
?filter={"at":{"_lte":"2026-09-01T00:00:00Z"}}   → [row]   (wrong)
```

Confidently wrong in both directions, for the exact date format the API emits.
Passing epoch numbers worked, and the same query on Postgres was always correct —
which is why it survived.

Operands are now put through the **same `serialize` the write path uses** to
produce the column's contents, so a filter and a column cannot drift: one
function decides both.

## The schema templates

All twenty-eight pairs now declare their period. The bounds are **derived**
rather than chosen per pair: a `datetime` field is a range of instants and gets
`[)`, a `date` field is a range of days and gets `[]`. A test asserts that
mapping, because getting it backwards is invisible until something double-books.

## Limits, stated plainly

- **There is no exclusion constraint.** Declaring a period lets you *find*
  overlaps; it does not stop two rows from covering the same one. Where the
  overlap must be impossible rather than merely visible — seat inventory — that
  is a partial unique index, which is what [booking](./booking.md) uses and why
  it is a separate feature.
- **`_overlaps` is a query operator, not a permission one.** The expansion runs
  where the collection's fields are known (the REST list, the aggregate endpoint,
  GraphQL). A permission condition is stored raw, so write those against the two
  columns directly.
- **One period per pair.** A field declares one `range.end`; a collection may
  have several pairs, each declared on its own start column.
- **`localized` and `unique` are refused.** A per-locale period would be
  invisible to the queries that ask about it, and two rows covering the same
  period is what an overlap search exists to find, not something to forbid at the
  column.
