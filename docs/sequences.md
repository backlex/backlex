---
title: Sequence fields
---

A **sequence** is a document number the server issues: `INV-2026-0001`,
`PO-2001`, `WO-1001`, `Q-2026-042`. You declare the shape once and backlex fills
the column on every insert, from every surface.

The column is read-only through the API — on create *and* on update. You do not
send a number; you cannot change one afterwards.

## Why this isn't something the client can do

Seventeen of the twenty-seven schema templates carry a `required + unique`
document number, and before sequences every one of them had to be invented by
the caller. The obvious client-side approach is "read the highest, add one",
which two concurrent creates both compute from the same snapshot. On a column
with a unique index that is a failed insert; on one without, two invoices
quietly share a number.

`onCreate` could not help: it resolves a fixed token (`uuid`, `now`, `user`,
`tenant`) and there was no counting token to add — a counter needs somewhere to
keep the count.

## Shape

```json
{
  "name": "number",
  "type": "text",
  "required": true,
  "unique": true,
  "sequence": {
    "pattern": "INV-{YYYY}-{####}",
    "start": 1,
    "reset": "yearly",
    "timezone": "Europe/Istanbul"
  }
}
```

- **`pattern`** — literal text plus tokens (below). Required.
- **`start`** — the first number in a fresh period. Default `1`.
- **`reset`** — `never` (default) · `yearly` · `monthly` · `daily`.
- **`timezone`** — IANA zone the date tokens and the reset boundary resolve in.
  Default `UTC`.

The column's `type` must be `text`: the value is a rendered string, not a bare
counter.

`required` and `unique` are both allowed and both worth setting. The server
fills the column on every insert, so `NOT NULL` can never reject a write, and
`UNIQUE` is the backstop that turns a numbering mistake into a refused insert
instead of two documents with one number.

### Pattern tokens

| Token | Renders |
|---|---|
| `{YYYY}` | four-digit year |
| `{YY}` | two-digit year |
| `{MM}` | two-digit month |
| `{DD}` | two-digit day of month |
| `{#}`, `{##}`, `{###}`, … | the counter, zero-padded to the number of `#` |

Everything else is literal. Write `{{` or `}}` for a literal brace.

A counter that outgrows its padding **widens** rather than truncating —
`{###}` renders 1000 as `1000`, never `000`. Padding is presentation, not a
limit.

| Pattern | First three values |
|---|---|
| `INV-{####}` | `INV-0001`, `INV-0002`, `INV-0003` |
| `WO-{####}` with `start: 1001` | `WO-1001`, `WO-1002`, `WO-1003` |
| `Q-{YYYY}-{###}` | `Q-2026-001`, `Q-2026-002`, `Q-2026-003` |
| `{YYYY}{MM}-{####}` | `202608-0001`, `202608-0002`, … |

### Resetting

`reset` restarts the counter each period. There is no scheduled job behind it:
the counter is keyed by period, so a yearly sequence simply asks for the bucket
named `2027`, finds nothing there, and starts at `start`. Nothing runs at
midnight, so nothing can fail to run at midnight.

Because the reset only changes which *bucket* the counter comes from, the
rendered value has to carry the period too, or January reissues last year's
numbers. backlex refuses the combination at save time:

- `yearly` needs `{YYYY}` or `{YY}` in the pattern
- `monthly` also needs `{MM}`
- `daily` also needs `{DD}`

### Time zone

The zone lives **on the field**, not in your workspace display settings. A
document number's year is a property of the series: changing which timezone the
admin views dates in must never renumber next January's invoices. The admin
editor pre-fills it with your own zone, so the common case needs no thought.

It matters more than it looks. An invoice created at 01:00 on 1 January in
Istanbul is still 22:00 on 31 December in UTC — the default zone would number it
under the wrong year.

## What is guaranteed — and what is not

**Guaranteed: unique and monotonic within a period.** Two rows never share a
counter, and a later allocation always gets a higher one. This holds under
concurrency because the counter is bumped by a single
`INSERT … ON CONFLICT DO UPDATE SET last_value = last_value + n RETURNING
last_value` — one statement, evaluated by the database, so whichever create
lands second sees the first one's write.

**Not guaranteed: no gaps.** The counter is bumped outside whatever transaction
the row write is in — exactly like a Postgres `SEQUENCE`, and for the same
reason. If the insert that took a number then fails a constraint, or an atomic
batch rolls back, that number is spent and the series has a hole. Closing that
would mean holding the counter locked for the duration of every insert, which
serialises all writes to the collection.

So: if you are subject to a statutory gapless-numbering rule, that is a
bookkeeping process, not a database default. backlex will not silently pretend
to give you one.

backlex does reduce gaps where it is free to: a number is taken at the *end* of
the validation phase, so a request that was going to be rejected anyway does not
burn one.

## Bulk writes

The batch endpoint and CSV import take **one block** of numbers per sequence
field for the whole run rather than one statement per row. An import of ten
thousand rows costs one allocation, not ten thousand.

The block is sized to the number of rows submitted, so rows that turn out to be
updates or that fail validation leave their numbers spent — see gaps, above. The
date tokens are fixed for the whole run, so an import that straddles midnight
numbers consistently instead of splitting mid-file.

## Rows that arrived before the counter

Adopting a table that already holds `INV-0001` … `INV-0499` would otherwise
start the counter at zero and reissue `INV-0001` on the very first create. Same
for a restore from a dump taken before the counter existed.

Adding a sequence field to a collection that already has rows syncs the counter
automatically. You can also run it on demand:

```bash
bun backlex collections sync-sequences invoices
```

```
POST /api/items/invoices/sequences/sync
```

It reads every value in the column, decodes the ones this pattern could have
produced, and moves each period's counter up to the highest it finds. Counters
only ever move **forward** — lowering one would reissue numbers that are already
on documents, and rows can be deleted, so the counter (not the table) is the
record of what has been handed out. Values the pattern could not have produced
are reported as `unreadable` rather than guessed at.

Backups include the counters, so a restore does not need this.

## Peeking

```
GET /api/items/invoices/sequences/next
```

Returns what each sequence column would render next, without consuming it. It is
a preview by nature — another create can take that number first — so show it,
never store it.

## Surfaces

Sequences are issued on every write surface: REST, GraphQL, the SDK, the batch
endpoint, CSV import, public form submissions and MCP. All of them refuse a
client-supplied value.

```ts
await client.from("invoices").create({ customer: id });
// → { data: { id: "…", number: "INV-2026-0001", … } }

await client.from("invoices").nextSequences();   // { number: "INV-2026-0002" }
await client.from("invoices").syncSequences();   // repair
```

MCP: `schema.sequences_sync`.

## Limits worth knowing

- **One counter per field.** A pattern may contain exactly one counter token.
- **No per-parent numbering.** `WEB-1`, `WEB-2` numbered *within each project*
  is not supported: the counter would have to key on another row's value, and
  rendering the prefix would mean reading that row on every insert. Use a
  `{YYYY}`-scoped series, or compose the display value from two columns.
- **Not convertible in the admin.** A plain column cannot be turned into a
  sequence from the field editor — the existing values would keep whatever they
  had while the counter started fresh. The API allows it (and syncs the counter)
  if you know that is what you want.
- **`{YY}` loses the century** when a repair decodes old values; they are read as
  20xx.

## See also

- [Rollup fields](./rollups.md) — the other column backlex maintains for you
- [Adopting existing tables](./adopting-tables.md)
- [Hashed fields](./hashed-fields.md)
