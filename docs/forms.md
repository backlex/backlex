---
title: Public forms
description: Embeddable, unauthenticated forms that write submissions into a collection — with honeypot/rate-limit/Turnstile spam protection and full REST/SDK/GraphQL/MCP/CLI parity.
---

Embeddable, unauthenticated forms that write submissions straight into a
collection. Build the form in the admin (**Data → Forms**), then share the
public link (`/f/<token>`) or drop the iframe snippet (`/embed/f/<token>`)
into any site. Submissions run the exact same write path as an authenticated
create — field validation, hashed fields, flows, webhooks, realtime events and
the audit trail all apply unchanged.

## How it works

- A form row stores the target collection, an **ordered subset of exposed
  fields** (with optional label/help overrides), display settings, and the
  SHA-256 hash of its public token (`frm_<hex>`, shown exactly once on
  create/rotate — same scheme as record share links).
- `GET /api/public/forms/:token` returns the render definition: exposed
  fields only, with type, label, required flag, dropdown choices and
  validation hints. Nothing else about the collection leaks.
- `POST /api/public/forms/:token/submit` writes through `performCreate` with a
  **null user** and the exposed field set as the permission clamp. Unknown or
  unexposed keys are silently dropped; the created row id is never returned to
  the submitter.
- On **versioned collections** submissions land as `draft` — an instant
  moderation queue: review in the admin, publish what you accept.

## Field eligibility

Scalar fields can be exposed — `text`, `longtext`, `integer`, `number`,
`boolean`, `timestamp` (dropdowns are `text` + choices) — plus single `file`
fields (see **File-upload blocks** below) and `json` fields that define choices,
which render as a **multi-select** and store the chosen values as an array.
Excluded: relation / hash / plain json / uuid, `private`, `computed`,
`localized`, and server-auto-filled (`onCreate`) fields. The fence is enforced
at definition time AND re-derived on every public read/submit, so a field that
later becomes ineligible silently disappears from the form instead of leaking.

## Scale questions

An `integer` block can be answered by picking one point on a row instead of
typing a number:

```jsonc
{ "name": "recommend", "label": "Would you recommend us?",
  "scale": { "min": 0, "max": 10, "style": "nps",
             "minLabel": "Not at all", "maxLabel": "Definitely" } }
```

- `style: "stars"` — a star row (the old `rating: true` is exactly
  `{ min: 1, max: 5, style: "stars" }` and still parses).
- `style: "number"` — numbered buttons.
- `style: "nps"` — the 0–10 row, which the results panel scores as promoters
  minus detractors.

At most 11 points (`SCALE_MAX_POINTS`); a wider one is refused when the form is
saved. The bound is re-checked **on submit**, so a hand-written POST cannot put
a 47 in an NPS column — the page's own row is not the guard.

The answer is an ordinary integer in an ordinary integer column, which is what
lets the results panel, dashboards, KPIs and CSV exports all read it without
knowing the question was drawn as stars.

## Matrix questions

Several questions asked on one shared set of columns — the agreement grid, the
"rate each of these" table:

```jsonc
{ "kind": "matrix", "label": "How was our support?",
  "scale": { "min": 1, "max": 5, "style": "number",
             "minLabel": "Poor", "maxLabel": "Great" },
  "rows": [{ "name": "speed", "label": "Speed" }, { "name": "friendliness" }] }
```

**A matrix is how questions are drawn, not how they are stored.** Every row
names an ordinary collection field and its answer lands in that field's own
column, which is what lets the results panel, dashboards, KPIs and CSV exports
read a grid without knowing one was drawn. Everything past the point where the
form is read sees the rows as the ordinary questions they are.

The rows have to agree on their columns, and which kind of columns follows from
the fields rather than from a mode to keep in sync with them:

- **scale** — every row is an `integer` field, so the columns are the points of
  the block's own `scale` (the same shape scale blocks use, same 11-point cap).
- **choice** — every row offers the *same choices in the same order*, so the
  columns are those choices. This is the likert grid. Same values, same order:
  a third column meaning "Neutral" on one line and "Disagree" on the next is
  not a grid, and the header is drawn once for every row under it.

At most 20 rows, and a field may be on the form once — asking one field twice
writes one answer over the other, and which survives is block order.

Refusals are said when the form is **saved**, naming the row that is the
problem, because the alternative is a grid that quietly loses a line at read
time and looks like a bug in the form page. Refused later, too: a matrix whose
rows lose their shared columns — a choice list edited out from under it — drops
out **whole** on the next read, because half a grid is not a question anyone can
answer.

The public page draws the grid wide and stacks it narrow: five columns at a
phone's width are 60px each, so below ~640px (and above 7 columns at any width)
each row becomes its own question with its answers spelled out. Nothing about
the answers changes between the two. Rows travel to the page as ordinary field
blocks carrying a `matrix` marker, so a page bundle cached from before matrices
existed renders them as the plain scale rows and dropdowns they also are.

Answers are held to their columns on submit — a value in no column is refused,
the same way a scale answer off its row is. That check covers every dropdown and
multi-select on a form, not only matrix rows: the page renders the choices, and
the page is not the guard.

## Results

`GET /api/admin/forms/:id/results` summarises the answers — one distribution
per exposed question, built on the same aggregate engine dashboard panels use:

- **choice / boolean** — a count per value, in the schema's own choice order, so
  a bar chart keeps its bars in the same places between two reads.
- **multi-select** — a count per *chosen value* (the JSON array is exploded), so
  the shares can add up to past 100%. `answered` counts people, not picks.
- **scale** — every point of the row (including the empty ones) plus the mean;
  `style: "nps"` also returns `{ promoters, passives, detractors, score }`.
- **matrix rows** — nothing special: each is summarised as the scale or choice
  question it is, carrying `matrix: { id, label }` so the panel puts the grid's
  rows back under the heading they were asked under.
- **number** — the mean.
- **text / longtext / timestamp / file** — how many answered, and nothing else.

Free-text answers are **counted, never quoted**. Reading them back through a
second endpoint would be a weaker copy of the collection's own list endpoint —
one without its permissions, field allow-list or audit trail. The Submissions
tab reads them through `/api/items/:collection` instead.

The counts cover the whole target collection, not only rows this form wrote:
nothing stamps a row with the form that wrote it, because a form is a way in
and not an owner. `rows` is that figure; `submissionCount` is the form's own
counter.

## File-upload blocks

A `file`-typed collection field can be placed on a form. The public page
uploads the file **before** submit (`POST /api/public/forms/:token/upload`,
multipart) and receives a signed one-time **ticket**; the submit payload
carries the ticket as the field value and the server swaps it for the stored
key. A raw storage key in the payload is always rejected — an anonymous
submitter can never point a row at an existing object.

Server-side valves on every upload (the page's own checks are cosmetic):

- **Size** — per-block `maxBytes` (builder: "Max file size"), always clamped
  by the env ceiling `FORM_UPLOAD_MAX_BYTES` (default 5 MiB).
- **Type** — per-block MIME allow-list (`accept`, e.g. `image/*`,
  `application/pdf`; builder offers category chips). No list ⇒ any type.
- **Rate** — 20 uploads/min per (form, IP) plus a per-form daily budget
  (`FORM_UPLOAD_MAX_PER_DAY`, default 500).
- **Quota** — the workspace hard storage cap (usage metering) applies.

Files land under `form-uploads/<form-id>/` with a random basename (private
ACL, original filename kept in metadata). Uploads that are never submitted
are swept by the cron tick after 24h; tickets expire after 2h. Demo-mode
instances refuse public uploads entirely. Turnstile (when enabled) still
gates the submit — uploads are protected by the valves above instead.

## When it closes, and who may answer

A form is `active` or paused — paused answers **410** everywhere and says
nothing else, because its link was not supposed to be in circulation. Closing
is a different thing, and it renders: the page keeps its title and shows one
sentence, because "this closed on Friday" is what the person following the link
came for and a 404 in its place is a support ticket.

```jsonc
"settings": {
  "opensAt": 1786060800000,      // epoch ms — before this: "isn't open yet"
  "closesAt": 1786665600000,     // …and from this on: "closed"
  "maxResponses": 200,           // stop once this many were accepted
  "onePerBrowser": true,         // a cookie, see below
  "inviteOnly": true,            // only an unspent invite gets in
  "closedMessage": "Voting closed on Friday. Thanks to everyone who took part."
}
```

Submits against a closed form answer `410` with that same sentence, so a tab
left open across the closing time is told what a fresh arrival is told. A
schedule that closes before it opens is refused when the form is saved.

The response cap is checked **before** the row is written, so a simultaneous
burst can land a couple over it. The alternative — reserving a slot in the
statement that increments the counter — would spend the cap on submissions that
then failed validation, which is the worse mistake for a survey nobody can
re-open.

### One answer per browser

`onePerBrowser` sets an opaque, HttpOnly cookie after a successful submit
(`blx_fa_<hash of the form id>`), and both the definition and the submit honour
it. It is `SameSite=None; Secure` over https so the guard survives being
embedded in a cross-site iframe.

It is a **courtesy, not a count**: another browser, a private window or a
cleared cookie jar all answer again, and the admin toggle says so. When the
number has to be right, invite.

### Invite links

`inviteOnly` closes the form to everyone but a visitor holding an unspent
invite. Each invite is minted per recipient, is single-use, and is entered
through `/f/<form-token>?i=<invite-token>` — the form's own token is still
required, because an invite grants a turn and not access.

```bash
backlex forms invite <form-id> --emails ada@example.com,grace@example.com \
  --form-token frm_… --send
backlex forms invites <form-id>          # who answered
backlex forms revoke-invite <form-id> <invite-id>
```

The plaintext tokens are in the mint response and **nowhere else** — only their
SHA-256 is stored, exactly as for the form token itself. A lost link is
re-minted, not recovered.

The invite is spent *before* the row is written, because that is the only
ordering in which a double-click cannot leave two answers behind one link. A
submission that then fails validation hands it back: a missed required field is
a mistake to correct, not a door that locks behind you.

### Reminding whoever hasn't answered

```bash
backlex forms remind <form-id> --form-token frm_… --send
backlex forms remind <form-id> --ids inv1,inv2 --min-hours 48
```

**An invite is a turn, not a link.** A reminder cannot re-send the link that was
mailed — only the SHA-256 is stored — so it mints a fresh one, and the earlier
ones keep working: every link an invite has ever had opens the same turn, and
spending any one spends it. The alternative, rotating the invite's own token,
would kill the link in the first mail in front of exactly the person the
reminder is trying to reach. The first link lives on the invite,
every later one in `form_invite_tokens`, and revoking the invite kills all of
them at once.

Who is left alone: anyone who has answered, and anyone reminded within
`minIntervalHours` (default 24) unless you pass `force`. `skipped` says how
many. Reminding is refused outright when the form is paused, not open yet,
closed or full — a reminder that sends someone to a form which turns them away
is a support ticket with an apology attached.

Mail is optional (`send: true`), uses the `form_reminder` template when the
workspace defines one, and marks `sentAt`; the invite list carries `remindedAt`
and `reminderCount` either way. As with minting, the plaintext links are in the
response and nowhere else.

Emailing is optional (`send: true`) and uses the `form_invite` template when the
workspace defines one, else a built-in fallback. A recipient with no address is
allowed on purpose — a workshop hands links out on paper.

One call mints at most 500 invites. When you are also emailing them, mint in
batches of ~100: the sends run inside the request, and a single call that has to
deliver hundreds of messages is a request waiting to time out. Invites already
minted are unaffected by a send that fails — they are in the response, and the
list shows which ones went.

## Coming back to a half-filled form

A long survey loses people at the point where they have to finish it in one
sitting. `saveProgress` keeps what has been filled in so far:

```jsonc
"settings": { "saveProgress": true }
```

The page posts its answers on a short debounce and on every step change
(`PUT /api/public/forms/:token/draft`); the next definition read hands them back
in `draft`, and the page renders the same questions, on the same step, already
answered. The visitor sees one line — *"Saved — you can close this page and come
back"* — and a **Start over** link that throws the draft away
(`DELETE …/draft`).

**What identifies "the same person" is whatever they already hold.** An invited
person's key is their invite token, so the draft follows the link they were
mailed: the phone that started the survey and the laptop that finishes it are
the same person. Everyone else gets an opaque, HttpOnly cookie
(`blx_fp_<hash of the form id>`, `SameSite=None; Secure` over https so it
survives a cross-site iframe) — the same courtesy-not-a-count posture as
`onePerBrowser`, and another browser starts fresh.

Only the SHA-256 of that key is stored, exactly as for form and invite tokens.
`form_drafts` is therefore a set of partial answers that nobody can attribute to
a link without holding the link.

What a draft does **not** carry:

- **Files.** An upload's ticket expires in two hours, and handing back a dead
  one would turn "welcome back" into a failed submit at the very end. The file
  is the one answer that gets asked again.
- **Anything not on the form.** The same exposed-field clamp the submit uses,
  re-derived against today's schema — a question dropped from the form does not
  come back through a draft written while it was still on it.
- **More than 64 KB**, and no more than 60 saves/minute per (form, IP). A public
  endpoint that writes rows on a timer needs a valve.

Lifecycle: the submit that completes the form deletes its draft, deleting the
form deletes all of them, and the cron tick sweeps whatever nobody came back to
after **30 days**. A closed or paused form neither saves nor resumes — there is
nothing to come back to.

The admin's results panel shows `inProgress` beside the answers: how many people
started and stopped, which is the one figure the target collection cannot tell
you.

## Spam protection

Three independent layers on submit:

1. **Honeypot** — the public page renders an invisible `website` input; a
   filled value fakes a success response and writes nothing.
2. **Per-form/IP rate limit** — 10 submissions/minute per (form, IP), separate
   from the global API limiter (Durable Object on Workers, in-process
   elsewhere).
3. **Cloudflare Turnstile** (opt-in per form) — set `TURNSTILE_SITE_KEY` +
   `TURNSTILE_SECRET_KEY` in the environment, then flip the form's Turnstile
   toggle. Verification is **fail-closed**: turnstile-enabled forms reject
   every submit when the secret is missing. The form pages' CSP allows the
   widget (`script-src`/`frame-src challenges.cloudflare.com`).

## Embedding

`/embed/f/<token>` serves a compact variant with `frame-ancestors *` (and no
`X-Frame-Options`), so it can be iframed from any origin — same mechanism as
dashboard embeds. `/f/*` and `/embed/*` are `run_worker_first` paths on
Cloudflare so the Worker (not Static Assets `_headers`) controls their CSP.

```html
<iframe src="https://your-app.example/embed/f/frm_…" width="100%" height="600" frameborder="0"></iframe>
```

## Token lifecycle

- **Create** → returns `{ token, url, embedUrl }` once. Only the hash is stored.
- **Rotate** (`POST /api/admin/forms/:id/rotate-token`) → old link dies
  immediately, new one-time token returned. Use when a link leaks.
- **Deactivate** (`active: false`) → both public endpoints 404 without
  deleting the form.
- **Delete** → the form definition is removed; submitted rows stay.

## Surfaces

Everything goes through one service (`services/forms.ts`):

| Surface | Entry |
|---|---|
| REST | `/api/admin/forms` (+ `/eligible-fields/:collection`, `/:id/rotate-token`, `/:id/results`, `/:id/invites`, `/:id/invites/remind`), public `/api/public/forms/:token` (+ `/upload`, `/draft`, `/submit`) |
| SDK | `client.forms.*` |
| GraphQL | `publicForms` / `publicForm` / `publicFormResults` / `publicFormInvites`, `createPublicForm` / `updatePublicForm` / `deletePublicForm` / `rotatePublicFormToken` / `invitePublicForm` / `remindPublicFormInvites` / `revokePublicFormInvite` |
| MCP | `forms.*` (list, get, eligible_fields, create, update, rotate_token, results, invites, invite, remind_invites, revoke_invite, delete) |
| CLI | `backlex forms <list\|get\|fields\|create\|update\|rotate-token\|results\|invites\|invite\|remind\|revoke-invite\|delete>` |

Parity gate: `apps/web/tests/forms-surfaces.test.ts`; core behaviour:
`apps/web/tests/forms.test.ts`; matrix grids:
`apps/web/tests/forms-matrix.test.ts`; survey shapes + results arithmetic:
`apps/web/tests/forms-results.test.ts` (and `forms-results-pg.test.ts` for the
Postgres spelling of the array explode); closing rules:
`apps/web/tests/forms-availability.test.ts`; invites + reminders:
`apps/web/tests/form-invites.test.ts` (and `form-invites-pg.test.ts` for the
Postgres spelling of the reminder join and its batch stamp); saved progress:
`apps/web/tests/form-drafts.test.ts` (and `form-drafts-pg.test.ts` for the
Postgres spelling of the upsert and the sweep's timestamp bound).

## Not yet

- Relation fields.
- Localized fields.
- Multiple files per block (a `file` field stores one key).
- Resuming a draft on another browser without an invite — the cookie is the key
  there, and minting a shareable resume link would be a second bearer secret to
  lose.
