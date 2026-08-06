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

The page asks the two questions separately — **which day**, then **which
time** — because that is what a visitor is actually deciding, and because
answering both at once is what a wall of sixty identical buttons looks like.
The day rail carries only the days that have openings, so the first one is
always the soonest and is the one selected on arrival; each carries its count,
so "how busy is Thursday" is answerable without opening it. The chosen day's
times are cut into morning, afternoon and evening, which is how people ask for
an appointment long before they have a time in mind.

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

## Reading a day of work

Two questions get asked of the same rows, and they are read in opposite
directions: *who is coming next* and *what came in last*. `order=asc` on the
listing answers the first, `desc` (the default) the second. It is a SQL-level
sort rather than a re-sort of what came back, so the nearest booking survives
the page limit:

```bash
backlex booking list --resource clinic --from 2026-08-06T00:00:00Z --order asc --live
```

`--live` (`live=true`) drops what no longer stands — cancelled, no-show, and
holds the clock let go. "Who is coming on Thursday" is not answered by a list
that includes the two people who cancelled, and because the filter runs before
the page is cut, the count drops with the rows rather than promising a page
that is not there.

The admin page reads the operator's question by default — upcoming, nearest
first, live only — and puts the week's
shape above the list: how many places of the published grid are taken, how many
are left, what share that is, and when the next free one starts. The free half
comes from the slot grid and the taken half from the bookings themselves — a
booking an operator made off-grid is occupancy too, and subtracting one number
from the other would miss it.

A no-show is only offered once the slot has passed. Before that nobody has
failed to turn up yet, and `no-show` on a future booking is a cancellation
wearing the wrong label — so the endpoint takes the *stored* status, which stays
`confirmed` while the derived one already reads `completed`.

## Intake questions

A name and an address are what every booking needs. What *this* booking needs —
which treatment, which car, whether they have been before — is the resource's
own **questions**, edited in the admin next to the opening hours or on the
command line:

```bash
backlex booking update clinic \
  --ask "reason!=Check-up|Follow-up|Emergency" \
  --ask "notes:textarea" \
  --ask "insured!:boolean"
```

`!` marks a question required and the types are `text`, `textarea`, `select`
and `boolean`. Options are decisive: a question carrying them is a choice
whatever its type says, which is why `--ask "reason=A|B"` needs no `:select`.
Like `--open`, every `--ask` on the line replaces the whole set; `--no-ask`
clears it.

The **name** is the key the answer is stored under, and the same key a
`--map` entry points a mirrored column at — so it is what the flag takes,
rather than the label. In the admin the name follows the label while the
question is new and freezes once it has been saved: the answers on every
booking taken so far are keyed by it, and renaming would orphan them.

Two rules hold on every path:

- **Unknown answers are dropped, never rejected.** They land in a JSON column
  and, when mapped, in a real one. A public page that could grow that shape on
  its own would be a public page that can add columns.
- **A choice outside its options is refused**, whoever sent it.

`required`, though, binds the **public page only**. The questions are that
page's contract with the person filling it in; an operator writing down a
booking taken over the telephone may not have asked yet, and refusing the
booking loses the appointment rather than gaining the answer. Same reasoning as
the grid: what the public page may do is narrower than what an operator may.

## The page takes your colours

The page is not styled by the admin theme — nobody booking a haircut should
load a CMS's stylesheet — but that is an argument for it being *light*, not for
it looking like **ours**. A booking widget belongs on your site, which is why
both public routes ship framable in the first place, and a widget that cannot
take the host site's colour always looks borrowed.

```bash
backlex booking update clinic --theme light --accent "#34C79A" --font lexend
```

Three knobs, and deliberately the same three a [form](/forms/) has — `theme`,
`accent`, `font` — because they are the same three decisions. Both public pages
are painted by one module, so "light" means one thing across everything you
publish.

Each is optional and each is separately optional. **Omitting `theme` is a
choice, not an oversight**: the page then follows the visitor's own light/dark
setting, which is what every calendar published before this existed still does.
Setting only an accent leaves that intact and changes only the buttons.
`--plain` puts all three back.

One case where you almost certainly want to set it: **embedding**. Inside an
iframe the surrounding page decides what looks right, not the visitor's
operating system, and a visitor whose phone is in dark mode will otherwise
drop a black widget into the middle of your cream-coloured site.

The accent is a `#rrggbb` and nothing else — it is pasted into a style
declaration, so the server drops anything that is not one rather than trusting
the page to. Text on the accent picks itself: relative luminance decides dark
ink or white, so a pale brand colour does not produce an unreadable button.

Webfonts are only fetched when a face was actually chosen. A calendar that
never set one costs its visitors no extra request.

The manage page (`/b/<token>`) is painted the same way. A customer who follows
the link in their confirmation email to move an appointment should not arrive
somewhere that looks like a different company.

## Putting it on your own site

Both public pages are framable, so the link you already have is the embed:

```html
<iframe src="https://your-app.example/book/bkg_…" width="100%" height="720"
        frameborder="0" title="Booking"></iframe>
```

There is deliberately no second `/embed/…` URL. A form has one because its
standalone page stays same-origin-only; here **both** pages are meant to sit on
your site, so a separate address would only be another thing to rotate. The
admin prints the snippet next to the link, at the one moment the link exists.

On Cloudflare this only works because the two pages are served **by the Worker**
rather than by Static Assets: `_headers` can only ever add to a policy, and a
browser enforces the strictest of duplicate CSPs — so a framable override there
would have left the strict `frame-ancestors 'self'` standing next to it. They
are in `run_worker_first` for that reason alone.

## What stops a script booking your whole calendar

The same three layers a [public form](/forms/) gets, minus the one that needs
configuring:

- **Honeypot** — a field humans never see. Filled, and the response is exactly
  the one a real booking gets, while nothing is written. An endpoint that
  answered differently would be telling the script which of its submissions
  landed. Nothing is claimed either, so the slot is not held for a moment.
- **Rate limit** — per IP, on both taking a slot and reading the grid.
- **The grid itself** — the strongest of the three, and it was already there. A
  public booking has to land on a published slot, capacity is enforced by the
  database, and a `lead` of even an hour puts the whole of today out of reach.

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
| Intake questions | the resource's own [questions](#intake-questions) |

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
| CLI | `backlex booking <resources\|create\|url\|slots\|list\|book\|cancel\|move>` (`--ask`, `--answer`, `--theme`/`--accent`/`--font`) |

The public pages are `/book/:token` (pick a time) and `/b/:token` (change or
cancel one). Both sit under the framable CSP, because a booking widget belongs
on your site rather than ours.
