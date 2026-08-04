---
title: Email fields
---

An address stored the one way every mail server accepts.

An `email` field takes whatever a person types or pastes — `  Ada@Example.COM `,
`<ada@example.com>`, `ada@örnek.com` — and stores one canonical string. The
column is `TEXT`, byte-for-byte the same storage a plain `text` field uses, so
turning an existing email column into one of these needs **no migration**. Only
the values already in it need folding, and there is a command for that.

```jsonc
{ "name": "email", "type": "email", "unique": true }
```

## Why this is a field type and not a validation rule

Fifty-eight columns across twenty-five of the twenty-seven schema templates are
an email address. Every one of them used to be `text` plus a hand-written regex.
Three things broke at once, and none of them is fixable with a better regex.

**Identity.** `Ada@Example.com` and `ada@example.com` are one mailbox and two
strings. Fourteen of those columns are declared `unique`, across fourteen
different templates — and every one was enforcing nothing against the commonest
way an address gets written twice. A customer looking themselves up by the
address they always type finds no row. Deduplication cannot work at all.

Every part of the product that needed identity was already fixing this by hand,
in a different place each time: the portal auto-link wraps the *column* in
`lower()` (which also means the index on it goes unused), and the Mailchimp and
Klaviyo integrations lowercase on the way out because both key a subscriber on
the folded address. The column itself was never canonical, so each consumer paid
for it separately.

**Delivery.** An internationalized domain has to reach the SMTP envelope in its
A-label form. Nothing converted one, so `ada@örnek.com` stored the U-label and
every send against it depended on whatever the provider happened to do with
non-ASCII.

**Agreement.** There were eight hand-written email regexes in this repo and they
did not agree. The field-level one accepted `,`, `;`, `<`, `>` and `"`; the three
send paths (`reports`, `signatures`, `booking`) rejected exactly those. An
address could pass validation when it was stored and be refused months later by
the thing that was supposed to mail it — with the failure landing on whoever was
waiting for the email, not on whoever typed it. There is one validator now, and
`email-surfaces.test.ts` pins the corpus that used to split them.

A regex can reject a bad address. It cannot fold a good one.

## Configuring one

Every setting is optional. A bare `email` field already does the thing the type
exists for.

```jsonc
{
  "name": "work_email",
  "type": "email",
  "unique": true,
  "email": {
    "allowedDomains": ["example.com"],   // and its subdomains
    "caseSensitiveLocal": false,          // the default
    "display": "ascii"                    // the default
  }
}
```

| Setting | Meaning |
|---|---|
| `allowedDomains` | Refuse an address outside these domains at write time. A subdomain of a listed domain matches, so `example.com` admits `ada@mail.example.com`. Write them readably (`örnek.com`); they are folded to A-labels on use, so the rule and the values it judges are compared in the same alphabet. |
| `caseSensitiveLocal` | Keep the case of the part before the `@`. Off by default — see below. |
| `display` | `unicode` renders an international domain in its own alphabet in the admin and CSV export. The column is unaffected. |

### The one judgement call: folding the local part

RFC 5321 §2.4 reserves the interpretation of a local part to the receiving
server, so lowering it is a **policy**, not a fact the way lowering a domain is
(DNS is case-insensitive by RFC 4343).

It is on by default anyway, for two reasons. Identity is the entire point of the
type — `unique`, portal auto-link and marketing-list dedup all need one mailbox
to be one string. And every consumer in this repo that needed identity was
already folding by hand, so the default matches the behaviour that shipped.

Set `caseSensitiveLocal: true` for a workspace whose mail server genuinely
distinguishes `Ada@` from `ada@`. Note that `unique` then stops catching the
pair, which is the trade you are making.

## What is bundled, and what is refused

Folding a domain needs IDNA, and its transcoding half is **closed**: RFC 3492 is
an algorithm, not a dataset, it is exactly reversible, and it is about a hundred
lines. So it is bundled in both directions. The column holds the A-label because
that is what gets delivered; the admin renders the U-label back because that is
what a person recognises.

Deciding whether an address will actually *receive* mail is the opposite kind of
problem, and every tempting version of it is refused:

- **No typo correction.** `gmial.com` → `gmail.com` needs a list of domains worth
  correcting toward, which is open and drifts. A wrong "correction" silently
  mails a stranger.
- **No disposable or role-address blocklist.** Same open dataset — and `info@` is
  a perfectly ordinary address for a supplier row.
- **No subaddress stripping.** `ada+news@example.com` is a working, distinct
  address. Folding away the `+tag` is a per-provider convention, and applying it
  to a provider that does not share it destroys deliverability.
- **No MX or SMTP probe.** That is a network call on the write path, and its
  answer is true only at the instant it is asked.

This is the same judgement [phone](./phone.md) made about numbering plans and
[geo](./geo.md) made about geocoders: bundle the dataset that is closed, refuse
the one that is not.

### Shapes that are refused outright

The stored envelope is deliberately narrower than RFC 5322's grammar:

- **No quoted local part.** `"ada bell"@example.com` is legal and is the single
  richest source of the escaping bugs this type exists to end — it is where the
  `<`, `>` and `"` the old field-level regex admitted came from.
- **No address literal.** `ada@[192.0.2.1]` bypasses DNS, so none of the folding
  means anything for it.
- **At least two labels.** `ada@localhost` is deliverable only inside one
  machine, and a single-label domain in a customer row is a typo every time.

## Reading and writing

Reads always return the canonical value. Writes accept anything a person types.

```bash
curl -X POST /api/items/customers \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"  Ada@Example.COM "}'
# → 201 { "data": { "email": "ada@example.com", … } }
```

The folding happens on the **payload**, right after validation — not inside
`serialize`. `performCreate` builds its 201 body, its realtime event, its
activity row and its search text out of the in-memory payload, so folding only at
the column would hand the caller a string that does not equal the row that was
just made, and replicate it through the changefeed into an offline store.

Every write surface goes through the same call: REST, the SDK, GraphQL, the batch
endpoint, MCP, flows, bookings and payments.

### Filtering

Whole-address operands are folded to match the column:

```bash
# All four find the same row.
?filter={"email":{"_eq":"ADA@Example.COM"}}
?filter={"email":{"_in":["Ada@Example.com"]}}
?filter={"email":"ada@example.com"}
?filter={"email":{"_ends_with":"@Example.com"}}
```

That last one is where email parts company with `phone`, which passes substring
operators through untouched. It can afford to — a canonical E.164 number has no
case. A canonical address is folded text, and `_ends_with: "@Example.com"` —
"everyone at this customer", the most useful query anyone writes against one of
these columns — would otherwise match nothing at all.

So a fragment **is** folded, but only when the field folds the whole value. With
`caseSensitiveLocal: true` it is passed through untouched: the fragment could be
from either half and there is no way to tell, so nothing is guessed.

A fragment anchored at the `@` is a whole domain, so it is also encoded the way
the column was — `_ends_with: "@örnek.com"` finds the row stored as
`ada@xn--rnek-4qa.com`. That matters because `display: "unicode"` shows an
operator the readable form, and searching the string the admin just printed has
to work. A fragment that is *not* anchored at the `@` is left alone: Punycode
encodes a whole label rather than a substring of one, so `_contains: "örnek"`
has no conversion that could match, and inventing one would return rows that
merely look related.

An operand that is not an address is compared literally. That is deliberate — it
is what lets you find the rows a normalization pass has not reached yet, by
searching for the raw string still sitting in them.

## Fixing the rows you already have

Making a column an email field folds everything written **from now on**. The rows
already there are still however they were typed.

```bash
# See what would change — and, on a unique column, which duplicates
# folding is about to surface.
bun backlex collections normalize-emails customers email --dry-run

# Then do it. Safe to re-run; walks the whole table by cursor.
bun backlex collections normalize-emails customers email
```

Also available as `POST /api/email/normalize/{slug}`, the SDK's
`normalizeEmails(field, opts)`, and the `email.normalize` MCP tool.

Three promises:

- Values already canonical are left untouched.
- A value that cannot be read as an address is **reported by row id and left
  exactly as it is**. Overwriting it with a guess — or with `NULL` — destroys the
  only copy of whatever it was, and the operator who typed it is the one who can
  say what it meant.
- The report returns **ids, never addresses**. It is a plausible thing to log,
  and each value identifies a real person.

### When folding creates a duplicate

This is the one thing the phone normalization never had to deal with, and it is
most likely on exactly the columns that need normalizing most: folding can make
two rows **equal**, and fourteen of the fifty-eight template columns are
`unique` precisely because someone expected one row per person.

A collision is **detected and reported, never resolved**:

```
· dry run customers.email: 812 would be rewritten, 4013 already canonical, 2 duplicate (left as-is)
  duplicate rows (another row already holds the folded address): c_01H…, c_01H…
```

Which of two rows is the real customer is a question about the business, not
about the data — one may have the orders and the other the support tickets — and
merging them is irreversible. The pass leaves both exactly as they are and hands
back the ids. Run the dry run first on a unique column; that list is the point of
it.

## In the admin

The value input shows what will actually be stored, from the same parser the
server uses. It only says so when folding changed something — printing
"saved as ada@example.com" underneath `ada@example.com` is noise on the common
case and trains people to stop reading it.

What the operator sees is local state; what the form holds is the canonical
value. That split is not a refinement: the first version of the phone input
committed the raw text and canonicalized on blur, so pressing Save without
leaving the box submitted the pre-canonical value while the hint underneath
promised the one that would have worked.

## The schema templates

All fifty-eight columns converted at once, because an email field's storage is
identical to `text` — the conversion is metadata only. (Money, by contrast, could
convert 51 of 182: its storage genuinely differs.)

`email-surfaces.test.ts` gates three things about them: every sample row is
already canonical (sample seeding inserts straight into the physical table, so it
never goes through the folding), nothing is left behind as `text` with the old
`interface: "email"` hint, and the fourteen `unique` columns are still fourteen.

## Limits, stated plainly

- **254 characters total, 64 in the local part, 63 per domain label** (RFC 5321 /
  RFC 1035). The length is checked before any pattern runs, so no regex in the
  module can be handed an unbounded string.
- **No `default`, `computed`, `rollup`, `sequence`, `localized` or `vectorize`.**
  A DDL default would give every unfilled row the same real person's mailbox and
  then mail it; an embedding of an address matches on domain and spelling, which
  is noise, and puts a real mailbox into a vector store; the rest own the value
  by another rule.
- **`unique`, `indexed` and `searchable` are allowed and are the point.** The
  index is usable now precisely because nothing has to fold the column first.
- **The stored form is not the readable form** for an international domain. Use
  `display: "unicode"` in the admin; never use the decoded form to address mail.
