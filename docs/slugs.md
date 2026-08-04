---
title: Slug fields
---

A **slug** is the URL handle a row is addressed by — `my-first-post`,
`kadin-giyim`, `acme-ltd`. You declare an ordinary `text` column as one, and
backlex maintains it: a write that leaves it empty folds a slug out of the row's
own title, a value that *is* supplied is folded to the one canonical form rather
than refused, and a collision takes the next free suffix instead of failing at
the database.

```jsonc
{
  "name": "slug",
  "type": "text",
  "unique": true,
  "interface": "slug",
  "slug": { "from": ["title"] }
}
```

That is the whole declaration. Nothing about the storage changes — the column
stays ordinary text, sortable and filterable as itself — so an existing column
becomes a slug field with no migration and no DDL.

## Why this is not a validation rule

Every slug column in the schema-template catalog already carried a regex. A
regex can *reject* `My First Post!`. It cannot turn it into `my-first-post`.

That difference is the whole feature. Before this existed, the product had seven
separate slug implementations — for workspaces, organizations, SAML providers
(twice), agent handles, and two in the admin item form — and they disagreed with
each other on most real input:

| Input | Workspaces | Organizations | Admin auto-fill | Admin's own box |
|---|---|---|---|---|
| `Ürün Kataloğu` | `r-n-katalo-u` | `urun-katalogu` | `r-n-katalo-u` | `-r-n-katalo-u` |
| `Café Münch` | `caf-m-nch` | `cafe-munch` | `caf-m-nch` | `caf-m-nch` |
| `  Trailing space  ` | `trailing-space` | `trailing-space` | `trailing-space` | `-trailing-space-` |
| `Пример` | *(empty)* | `org` | *(empty)* | `-` |

The last column is the one operators actually typed into, and six of ten strings
in the corpus behind that table came out of it in a shape the column's own regex
**refuses**. Typing in the box the product supplied earned a 422 naming the
field you were typing into. There is now one fold, in one place
(`@backlex/db/slug`), and the admin previews with the same function the server
stores with.

## What gets folded, and what does not

The fold is Unicode NFKD plus a fourteen-character map, and it stops there.

NFKD splits a letter into its base plus combining marks, which are dropped:
`é`→`e`, `ü`→`u`, `ğ`→`g`, `ş`→`s`, `ç`→`c`. Fourteen Latin letters have no such
decomposition and survive it — `ı đ ħ ŀ ł ŉ ø ŧ ß æ œ þ ð ŋ` — so they carry an
explicit ASCII fallback (`ı`→`i`, `ß`→`ss`, `æ`→`ae`). That set is closed: it is
a finite list of letters that cannot grow.

**Cyrillic, Greek, Arabic, Hebrew, Devanagari and CJK are not transliterated.**
Romanization is a property of the *language*, not of the character, and the
competing standards disagree — Cyrillic alone has BGN/PCGN, ISO 9 and ALA-LC,
which romanize the same name three different ways. Guessing would print a URL
that looks right and is not. This is the same line
[phone fields](./phone.md) draw at national number formats and
[geo fields](./geo.md) draw at geocoders: bundle the dataset that is closed,
refuse the one that is not.

When a title folds to nothing, the slug is left **unset** rather than given an
invented token like `post-a3f9`. That would be a working URL, but also a
permanent unreadable one nobody asked for — and the operator is right there and
can type a better one. The admin says so under the box.

## The one rule for when a slug changes

**A slug is derived only when it is empty.**

- A create with no slug folds one from the source column.
- An update that does not mention the slug **leaves it alone** — always. A
  published URL must not move because somebody fixed a typo in the headline.
  That breakage is exactly what the `redirects` collections in the blog and
  ecommerce templates exist to repair by hand.
- An update that **clears** it re-derives from whatever the title now says. That
  makes "regenerate this slug" a discoverable action with no new API: empty the
  box and save.

## Collisions

A slug the server *derived* walks `summer-sale`, `summer-sale-2`,
`summer-sale-3` … and takes the first one free — one query, not one probe per
candidate.

A slug you **stated** is not suffixed. If it collides you get a `409` naming
your own choice, because "I want this exact URL and it is taken" deserves an
answer rather than a different URL. The server fills blanks; it does not overrule
decisions.

The check asks exactly what the column's `UNIQUE` constraint asks — no tenant
clause and no soft-delete clause — because that constraint is what actually
arbitrates, and it has no predicate. A dedupe scoped more narrowly than the
constraint would confidently propose a slug the database then refuses.

Two creates racing on the same title can still both see `summer-sale` free; the
`UNIQUE` constraint is what keeps that safe, and the loser gets a `409` that a
retry resolves. The same trade [sequences](./sequences.md) documents: the common
case is a person creating a second row hours later, and paying for the rare case
with a lock on every write is the wrong bargain.

## Filling in the slugs a workspace never had

Every slug in the template catalog is optional and nothing ever generated one,
so a workspace can hold years of rows with no handle at all.

```bash
bun backlex items backfill-slugs posts            # dry run — read this first
bun backlex items backfill-slugs posts --apply
```

```ts
await client.from("posts").backfillSlugs({ apply: true });
```

It is a **dry run by default**, bounded at 1000 rows per field per call, and
only ever fills what is empty — a row that already has a slug is never revised,
because that one may be a published URL. Text it cannot fold is reported as
`unfoldable` rather than given a token. Re-running is safe.

It needs `update` on the collection covering the slug column. A role whose
`update` names a field list excluding the slug is refused, the same as it is on
a direct `PATCH`. A role whose `update` carries a *row condition* has that
condition applied rather than being refused — unlike
[rearranging a list](./ordering.md), where renumbering a filtered subset would
collide with the rows it skipped. Each row's slug is independent, so filling the
ones a role can see is a complete and correct operation.

Also available as `POST /api/items/:slug/slugs/backfill`, the `backfillSlugs`
GraphQL mutation, and the `slug.backfill` MCP tool.

## Options

| Field | Meaning |
|---|---|
| `from` | Sibling columns an empty slug is folded from, in order — the first with text wins. `["title"]`, `["name"]`. Omit it and the field is simply a validated, folded slug the operator types: generation is opt-in, because silently deriving a public URL from a column the schema never nominated is worse than an empty box. Must name `text` or `longtext` columns. |
| `maxLength` | Longest slug to generate. Defaults to 80, capped at 180. A collision suffix fits *within* it by truncating the base. |

## Deliberately not supported

- **A uniqueness `scope`.** `unique` is emitted as a plain column-level
  constraint with no predicate, so a per-parent scope in the spec would be a
  claim the database does not enforce — the dedupe would allow a duplicate the
  index then rejects. The dedupe has to ask the same question the constraint
  answers.
- **Localized slugs.** A per-locale value lives in the translations sidecar
  while `unique` constrains the base column, so per-locale slugs would be
  deduplicated against the wrong table and constrained by nothing. Refused at
  save time rather than half-supported.
- **Slug history and redirects.** Changing a slug breaks links, and this feature
  deliberately makes that hard rather than tracking it. Building redirects on top
  is a content decision — the blog and ecommerce templates ship a `redirects`
  collection for exactly that.
- **Transliterating non-Latin scripts.** See above.
