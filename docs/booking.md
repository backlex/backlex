---
title: Availability & booking
description: Publish a calendar a stranger can pick a time from — opening rules in the resource's own zone, a capacity guarantee the database enforces, and a public page that needs no account.
---

Ten of the twenty-six schema templates carry a slot-shaped collection —
`appointments`, `clinic`, `fitness`, `restaurant`, `field-service`,
`real-estate`, `rental`, `events`, `nonprofit`, `ats` — and the `appointments`
one goes as far as modelling `availability_rules` and `bookings` itself. What
none of them could express is **when the thing behind the row is free**. That,
rather than the storage of a booking, is what this adds.

A collection was always able to hold a booking. What it cannot do is refuse the
second write for the same instant.

## The shape

A **resource** is the thing people book — a person, a room, a court, a table. It
carries the policy: how long one booking lasts, how many fit at once, how much
notice you need, how far ahead the calendar is open. Its **rules** are the
opening pattern and the exceptions to it. Neither stores a slot: the open times
are computed from both on every read, because a materialised slot table has to
be regenerated whenever a rule moves and is quietly wrong until it is.

```bash
backlex booking create clinic --name "Dr Yılmaz" --tz Europe/Istanbul \
  --slot 30 --buffer-after 10 --lead 120 --horizon 45 \
  --open mon:09:00-12:00 --open mon:14:00-18:00 \
  --open wed:09:00-12:00 \
  --block 2026-08-10..2026-08-17
```

That prints the public page URL **once**. Only its hash is stored, so nothing
can show it again; `backlex booking url clinic` mints a replacement and kills
the old one.

Your visitor opens `/book/<token>`, picks a time and leaves their name. They get
a confirmation email with a calendar invite attached and a link to change or
cancel. You see the booking in the admin, or:

```bash
backlex booking slots clinic         # what is still open
backlex booking list --resource clinic --status confirmed
```

## Rules are local; slots are instants

"Mondays 09:00" does not move when the clocks do. The instant it names does.

So a rule is stored as a weekday plus minutes from **local midnight**, and it
only becomes a UTC instant against the resource's own `timeZone`. That zone is
not a display preference — it is the only thing that can settle which instant
the operator meant, and it is why `--tz` matters more than it looks.

Two consequences worth knowing before they surprise you:

- **A local time that does not exist yields no slot.** On the morning the clocks
  go forward, 02:30 is not a late start — it is not a time. The slot is dropped
  rather than quietly moved to 03:30 for somebody who read 02:30.
- **The repeated autumn hour resolves to its earlier instant**, matching what
  calendars do with a doubled hour. The second pass through 02:30 is simply not
  offered.

A span that crosses midnight is **two rules**:

```bash
backlex booking create bar --name "Late bar" --tz Europe/Istanbul \
  --open fri:22:00-24:00 --open sat:00:00-02:00
```

That is deliberate. With `0 <= start < end <= 1440` as an invariant, no interval
anywhere in the system has to be read as "wraps around".

A one-off closure is a rule with no weekday and a date range instead — which is
how a holiday or a week of leave is said:

```bash
backlex booking update clinic --block 2026-08-10..2026-08-17
backlex booking update clinic --block 2026-09-01..2026-09-01:12:00-13:00
```

Every `--open`/`--block` on the line **replaces** the whole pattern. Opening
hours are edited as one thing, not row by row.

## Buffers apply to both sides

`bufferBefore` and `bufferAfter` are different activities — preparing and
clearing up — so both have to fit between two consecutive bookings. Fifteen
minutes either side means a **thirty**-minute gap, not fifteen. If you want a
one-sided gap, set one side.

This is also a correctness requirement rather than a preference: charging the
buffer only to the booking that already exists makes the conflict test
asymmetric, so whether two bookings collide would depend on which was entered
first. A concurrency guard cannot have that property — two writers racing must
reach the same verdict about each other.

## Two people, one slot

This is the part the whole design turns on.

Reading and then writing cannot enforce a capacity: there is no row lock to take
on D1, so another writer fits between the count and the insert. Inserting and
then sorting the contenders and making the loser withdraw is closer, and it is
what this shipped with first — but it is still unsound. A booking that arrives
late can sort ahead of one that already checked and passed, and nothing goes
back to re-check the earlier one, so both keep their rows.

So the database decides it. Each booking claims a numbered **seat**, and a
partial unique index on `(resource, start, seat)` over the occupying statuses
makes two bookings for the same seat at the same instant impossible. The writer
walks `0..capacity-1` and takes the first that inserts; running out of seats is
a full slot and answers `409`.

A softer check still runs after it, for the overlaps an index keyed on the exact
start instant cannot see — an operator's irregular entry, a differing duration,
two slots that only collide through the buffers.

## Held bookings, and expiry nobody has to sweep

`hold: true` parks a slot instead of confirming it — what a deposit is paid or a
longer intake form is filled in during. A hold occupies the slot exactly as a
confirmation does, until `holdMinutes` runs out.

Nothing sweeps it. A lapsed hold stops occupying its slot because the clock
passed it, so a wedged cron cannot keep a slot closed. `completed` is derived the
same way — a confirmed booking whose end time has passed — which is why
yesterday's appointments stop looking upcoming without anything having run.

The one place this becomes a written value is the seat index, which reads a
column and cannot see a clock. The writer who actually needs the seat back
materialises the `expired` status at the moment it needs it. Lazily, on purpose:
a cron that swept holds would be a second source of truth about when a hold
ends, and the wrong one whenever it was behind.

## The operator is not confined to the grid

The public page may only take what the grid published — the grid *is* the offer,
and a UI that invites an unbookable time spends its day showing errors.

Every other surface may book anywhere. Taking a call is exactly the case a
published grid cannot describe:

```bash
backlex booking book clinic --start 2026-08-03T15:07:00Z --name "Walk-in"
```

The capacity guarantee still applies. `source` on the row records which path it
came in through, so a self-service no-show reads differently from an operator's
data entry.

## Mirroring into your own collection

The ledger is authoritative for the **slot**. Set `mirrorCollection` and each
booking is also written as a row in a collection you own, where permissions,
flows, realtime, revisions and exports apply to it as usual:

```bash
backlex booking update clinic --mirror appointments \
  --map start=starts_at --map name=patient --map status=state
```

`--map` keys are `start`, `end`, `name`, `email`, `phone`, `status`, `resource`,
`notes`, or any question name. Mirroring is best-effort: the booking is already
made and the slot already held, so a renamed collection or a mistyped column
must not turn a confirmed appointment into a 500 for the customer. The failure
shows up as a booking with no `mirrorItemId`.

## Composing with what is already there

A booking announces itself on the `booking` channel, so a flow can trigger on
`event:booking:created`, `booking:cancelled`, `booking:rescheduled`,
`booking:confirmed` or `booking:no_show`. That is where this joins the rest:

| You want | Reach for |
|---|---|
| A reminder the morning before | a `cron` flow + [`sms`](/flows/) or `email` |
| The appointment in your own Google Calendar | the [Calendar destination](/integrations/) |
| A deposit before you confirm it | `hold: true` + [`payment.checkout`](/payments/), then `confirm` |
| A waiver signed before they arrive | [`document.sign`](/e-signature/) |
| Intake questions | the resource's own `questions` |

The channel is `booking`, singular, and not `bookings` — item events publish on
`items:<slug>`, and three of the schema templates own a collection called
`bookings`. A trigger pattern matching both would fire your reminder twice.

These events reach flows, webhooks, event functions and extension hooks — and
nothing else. They are deliberately **not** on the realtime bus: a booking
carries a customer's name, address and telephone number, and the realtime
plane's per-subscriber permission filter only applies to row-shaped payloads.
If you want bookings on a realtime channel, mirror them into a collection; a
mirrored row is a row, so `items:<slug>` gates it like any other.

## Tokens

Two, and both are bearer credentials stored only as a SHA-256:

- The **page token** (`bkg_…`) is the grant to see a calendar and take a slot on
  it. Returned once on create, and again only when you rotate it.
- The **manage token** (`bkm_…`) is the grant to change or cancel **one**
  booking. It reaches the customer in their confirmation email.

A reschedule mints a new manage token and spends the old one — a link that kept
working after the appointment moved would cancel the wrong thing.

The CLI prints both, and it is the only surface that does: a terminal is your own
screen, and getting a URL to paste into your own site is most of the reason to
reach for it. REST, the SDK and GraphQL return them to the caller who just made
them. **MCP strips them**, because a tool result is transcript that gets
summarised, forwarded and stored.

Every failure to resolve a token answers identically — an unknown token, a
paused resource and a deleted one all give the same 404. Distinguishing them
would make the endpoint an oracle for which tokens ever existed.

## Surfaces

Everything funnels through one service, so the capacity guarantee, the derived
statuses and the grid check cannot drift between them.

| | |
|---|---|
| REST | `/api/admin/booking/*`, public `/api/public/book/*` |
| SDK | `client.booking.*` |
| GraphQL | `bookingResources`, `bookingSlots`, `bookings`, `createBooking`, … |
| MCP | `booking.list_resources`, `booking.slots`, `booking.book`, … |
| CLI | `backlex booking <resources\|create\|url\|slots\|list\|book\|cancel\|move>` |

The public pages are `/book/:token` (pick a time) and `/b/:token` (change or
cancel one). Both sit under the framable CSP, because a booking widget belongs
on your site rather than ours.
