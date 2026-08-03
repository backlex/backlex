---
title: Phone fields
---

A `phone` field stores a number the one way every machine can dial it:
**E.164**, `+905321112233`. Whatever an operator types — `0532 111 22 33`,
`(532) 111-2233`, `+90 532 111 22 33` — is parsed and canonicalized on the way
in, on every write surface.

The column is `TEXT` / `varchar(255)`, exactly what a `text` field uses. That is
deliberate: turning an existing phone column into a phone field needs **no
migration**, only a pass over the values already in it.

## Why this is a field type and not a validation rule

Thirty-six columns across twenty-one of the twenty-seven schema templates are a
phone number, and every one of them used to be plain `text`. Three things were
broken at once, and none of them is fixable with a regex:

- **Identity.** The same person written two ways is two different strings, so
  `unique` enforced nothing, deduplication could not work, and looking a customer
  up by the number they read out over the phone missed.
- **Delivery.** backlex already sends SMS. Twilio, SNS, NetGSM and İletimerkezi
  all require E.164, and the `sms` flow op refuses a recipient that is not. So
  *every* reminder flow addressed at `{{ data.phone }}` — the most obvious thing
  to build on the appointments, clinic, restaurant and field-service templates —
  failed at run time, one row at a time, long after the write that caused it.
- **Validation.** A regex can reject a bad number. It cannot turn a good one
  written badly into a good one written well, which is the actual job.

## Configuring one

Every option is optional. A bare phone field accepts numbers in international
form (`+90…`, `0090…`) and **refuses national ones**.

```jsonc
{
  "name": "phone",
  "type": "phone",
  "phone": {
    "region": "TR",              // a bare 0532… is read as Turkish
    "regionField": "country",    // …or per row, from a sibling column
    "allowedRegions": ["TR"],    // refuse anything outside these
    "display": "spaced"          // "+90 5321112233" in lists; default "e164"
  }
}
```

**`region` is not a cosmetic default.** It decides which country a bare
`0532 111 22 33` dials, and the same national number exists in dozens of
countries. Without one, a national number is refused rather than guessed at —
because a guess produces a stored number that parses, looks right, and rings in
the wrong place, with nothing downstream to flag it.

`regionField` names a sibling text column holding this row's ISO 3166-1 alpha-2
code, for a contact list spread across countries. It is read on **write only**:
unlike a money amount, a canonical phone number carries its own country code, so
nothing on the read path needs the row.

## What is bundled, and what is refused

Canonicalizing needs each country's **calling code** and whether it uses a trunk
prefix. That is a closed dataset — about 250 rows, fixed by the ITU — so it ships
in `packages/db/src/phone.ts`.

Printing a number the way a local would write it needs each country's
**numbering plan**: which prefixes are mobile, how many digits a carrier block
holds, where the spaces go. That is an open dataset, it drifts, and tracking it
is the entire reason `libphonenumber` exists. So **there is no national-format
renderer here.** `display` offers exactly one alternative to raw E.164 — a space
after the calling code — because that is the only split the bundled table
justifies. A renderer that guessed the rest would print numbers that look right
and are not.

Same judgement `geo` made about geocoders, landing on the other side: bundle the
dataset that is closed, refuse the one that is not.

### Trunk prefixes worth knowing about

`0` is assumed for any country not listed as an exception. The exceptions that
matter:

| Countries | Rule |
|---|---|
| US, CA and the rest of the NANP | No trunk prefix — all ten digits are the number |
| **Italy**, San Marino, Vatican | Keeps the leading `0`: `06 …` in Rome is `+39 06 …` |
| Spain, Portugal, Norway, Denmark, Iceland | Closed plans, no trunk prefix |
| Russia, Belarus, Kazakhstan, Turkmenistan, Uzbekistan | Trunk code is `8` |
| Hungary | Trunk code is `06` |

Italy is the one a blanket "strip the leading zero" rule gets wrong, and the
symptom is a number that simply does not connect.

A value written with `+` is never subject to any of this — an explicitly
international number is taken at its word.

### Extensions are refused, not dropped

E.164 has no room for one, and silently discarding `x123` changes who the number
reaches. `+1 415 555 2671 x123` is a 422. Store the extension in its own column.

## Reading and writing

Reads always return canonical E.164. Writes accept anything the parser
understands, on every surface — REST, the SDK, GraphQL, MCP, the batch endpoint,
flows, integrations.

```ts
await client.from("customers").create({ name: "Jordan", phone: "0532 111 22 33" });
// → { phone: "+905321112233" }
```

### Filtering

Filter operands are canonicalized the same way values are, so the number as a
human says it matches the number as it is stored:

```
?filter={"phone":{"_eq":"0532 111 22 33"}}   → matches +905321112233
```

`_contains` / `_starts_with` / `_ends_with` are passed through **untouched**, on
purpose: a fragment is not a number, so parsing it would fail on the query an
operator actually types when they only remember the last few digits.

An operand that does not parse is compared literally rather than rejected —
which is what lets you find the rows a normalization pass has not reached yet, by
searching for the raw string still sitting in them.

## Fixing the rows you already have

Making a column a phone field fixes every write **from now on**. The rows already
there need one pass:

```bash
# See what would change, and how many rows cannot be read at all
bun backlex collections normalize-phones customers phone --dry-run

# Then do it
bun backlex collections normalize-phones customers phone
```

It walks the table in primary-key order, rewriting only what it can read.

- Values **already canonical** are skipped, so re-running is safe.
- Values it **cannot read** are left exactly as they are and reported **by row
  id**. Overwriting one with a guess — or with NULL — destroys the only copy of
  whatever it was, and the operator who typed it is the one who can say what it
  meant. The ids let you go and look; the *values* are never returned, because
  this report is a plausible thing to log and every one of them is a real
  person's phone number.

The same pass is available as `POST /api/phone/normalize/{slug}`, the SDK's
`normalizePhones(field, opts)`, and the `phone.normalize` MCP tool. All of them
page by **cursor** rather than by a remaining count — an already-canonical row
never leaves the candidate set, so "how many are left" would never reach zero.

It requires `update` on the collection, and it is scoped by the caller's row-level
`update` condition, the workspace, and the soft-delete filter — holding `update`
on a collection is not holding it on every row.

## In the admin

The item form shows the E.164 it will save, underneath the box, as you type —
produced by the same parser the server runs, so the two cannot disagree. Next to
the input is a country picker: it changes how a **national** number in the box is
read, greys out when the number already states its own country code, and is
**never stored**. It starts on the field's region, or on the browser's own
region when the field has none.

On blur, the box is rewritten to the canonical form. That is what makes a region
picked in the browser actually work: the server never sees that choice, so the
value it receives has to be one that needs no region at all.

## The schema templates

All thirty-six phone columns across the twenty-one templates that carry one are
now `phone` fields — the whole set, because the column type is unchanged and the
conversion is metadata only. (Money could convert only 51 of 182, since an
amount's column had to change.)

They deliberately ship with **no `region`**: these templates are country-neutral,
and baking one in would hand every workspace that seeded a template somebody
else's country. Setting one is a single change in the schema editor, and the item
form's own picker means an operator can type nationally without it.

## Limits, stated plainly

- **The envelope is checked; the numbering plan is not.** A value must be a known
  calling code plus 7–15 digits total. `+90 5320000000` is accepted even though
  no such subscriber exists. Per-country length and prefix rules are the open
  dataset this does not ship.
- **`searchable` folds in the canonical token**, so full-text search matches
  `+905321112233` and not a fragment of it. Use `_contains` for fragments.
- **Shared calling codes are not disambiguated.** `allowedRegions: ["US"]` allows
  every NANP territory, because E.164 does not distinguish them either and
  pretending otherwise would reject valid numbers.
- **`vectorize`, `localized`, `computed`, `rollup`, `sequence` and a column
  `default` are refused** on a phone field. `unique` and `indexed` are allowed,
  and are much of the point.
