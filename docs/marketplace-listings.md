---
title: Marketplace listings
description: Publish products to Trendyol, n11, Çiçeksepeti and Hepsiburada — map a category once, answer what it demands, and read the marketplace's verdict back onto the row it came from.
---

A **listing sync** puts your products on sale at a marketplace. It is the sixth
integration shape, and the only one whose form cannot be filled in before you
have connected the account — because the questions are the marketplace's, not
ours.

Everything else in [Integrations](/docs/integrations/) is configurable from a
static declaration: a source declares its settings, a destination declares its
columns. A listing cannot be. Which of Trendyol's ~3,900 categories does this
product belong to? Then which of the ~24 attributes that category demands? Then
which of the hundreds of values each attribute allows? None of that is knowable
until an operator picks a category, so a listing provider is **interrogated
while the form is being filled in** and the answers are stored.

The other half is the writeback. A destination mirrors rows out and hears
nothing back. A listing is refused **one unit at a time, minutes or hours
later, with a reason a person has to read** — so where the answer lands is part
of the configuration, not an afterthought.

:::note
Publishing is **manual by default**. A publish is an outward, hard-to-undo act
at a live marketplace, so a listing sync is created with no schedule and runs
when you press **Publish now**. You can give it one afterwards.
:::

## What you need first

1. A **connected marketplace integration** — the same connection its order sync
   uses. One credential does both jobs.
2. A **products collection**, and a column on it naming your own category.
   The ecommerce template's `product_type` ("Apparel", "Accessories") is the
   natural one; any text column works, and the value is matched verbatim.
3. Optionally a **variants collection** holding the sellable units. Without one
   the product row *is* the unit, which is a perfectly ordinary configuration —
   see [Products without variants](#products-without-variants).

## Setting one up

**Integrations → Add sync**, and pick the connection whose label ends
`· put products on sale`. A marketplace normally appears three times — once to
pull orders in, once to push stock and price out, once to list — because they
are three different jobs off one credential.

The form asks for five things:

| | |
|---|---|
| **Products in** | the collection holding your products |
| **Category column** | the column whose value the category mapping is keyed by |
| **Field mapping** | your columns → the marketplace's product fields |
| **Variants** | optional: where the sellable units live, and their per-unit fields |
| **Write the verdict back to** | where the marketplace's answer lands |

The last one is required and the server refuses a sync without it. Without
somewhere to put the answer, a batch is published and every verdict is
discarded — which reads as "nothing happened" for ever.

:::caution
The verdict lands on the row the **unit** came from. If you point the sync at a
variants collection, the writeback columns are the **variant's** — a unit's
listing status is not a product column. The form follows this automatically the
moment you choose a variants collection.
:::

## Mapping a category

Once the sync exists, its row grows a **Categories** button. That panel is
where the interrogation happens.

**Map a category** asks for three things in the order they become answerable:

1. **Your category value** — exactly what the category column holds, e.g.
   `Apparel`. Matched verbatim; a product holding anything else is skipped.
2. **The marketplace category** — searched, not browsed. The search matches the
   whole path, so `abiye` finds a category whose own name is just `Takım`. Only
   the deepest categories are offered: every one of these marketplaces refuses a
   listing against a parent.
3. **What that category demands** — asked only once a category is chosen,
   because until then there is nothing to ask.

Each attribute is answered one of three ways:

- **Pick a value** — from the marketplace's own closed set.
- **Read it from a column** — the answer differs per unit, so name the column
  to read it from. This is what a size or a colour wants.
- **Type it** — free text, offered only where the marketplace accepts it.

:::caution
An attribute badged **splits variants** is what tells two units apart. Giving it
a fixed answer gives *every* unit the same size, and the marketplace collapses
your variants into one listing. Read it from a column instead — the form says so
in place when you pick a fixed answer for one.
:::

A product whose category nobody has mapped is **skipped, not published
uncategorised**, and the run reports how many — that is the single most likely
reason a publish looks like it did nothing.

## Publishing, and what comes back

**Publish now** sends one bounded batch and reports what it did: how many units
were sent, how many were refused before sending, and how many products sat in
unmapped categories.

None of these marketplaces answers a create with a result. They answer with a
**queue ticket**, and the verdict lands minutes or hours later — up to 24 hours
at Çiçeksepeti. So a publish records a batch, and a separate sweep asks about
open batches until every unit in them has been ruled on.

:::note
The sweep runs on its **own** schedule, not the sync's. A listing sync defaults
to manual, and the scheduler only considers syncs with an interval — so a batch
you published by hand would otherwise never be asked about, and every product in
it would read "pending" for ever.
:::

The **Categories** panel lists recent batches with what is still undecided.
Per-unit answers land in the columns you mapped:

| Output | What it holds |
|---|---|
| Listing status | `pending`, `accepted` or `rejected` |
| Listing ID | the marketplace's handle for the listing |
| Rejection reason | verbatim from the marketplace, never parsed |
| Listed at | when it was accepted |

Three of the four marketplaces mint no id of their own and echo your seller code
back, so **Listing ID is often the same value as your SKU**. That is the answer,
not a bug.

## Products without variants

A workspace that models one sellable unit per product simply leaves the
**Variants** block empty. The product row is then mapped through both column
lists — the product's fields and the per-unit ones — and the verdict lands on
the product row.

This is a configuration, not a special case: no provider branches on it, which
is why "no variants" costs nothing.

## The four marketplaces

The shape held for all four, and they agree on almost nothing. What differs is
worth knowing before you map one.

### Trendyol

- The category tree and a category's attributes are **public** — you can browse
  them before finishing the credentials.
- Needs a **brand ID**, which is a searchable registry rather than a category
  attribute. Map it onto a product column.
- Echoes the **barcode**, so that is the reference; a unit without one is left
  for the next run.
- Batch results are kept for four hours after completion.

### n11

- **There is no brand field.** The brand is an ordinary category attribute
  ("Marka"), so it is answered in the mapping form like any other.
- Echoes the **stock code**. The barcode is optional here and used only to match
  n11's own catalog.
- Needs a **shipment template name** — the one you created under
  *Hesabım → Teslimat Bilgilerim* — and refuses the whole task without it.
- Its category tree needs the credential, unlike Trendyol's.

### Çiçeksepeti

- Every attribute is a **closed set**; free text is refused.
- Attributes that ask the *buyer* for text at checkout
  ("Kişiselleştirilebilir Özellik") are not offered — they are not yours to
  answer.
- A verdict of **`Warning` means the product listed**; the note is usually about
  pricing law. It is recorded as accepted, with the reason kept.
- The description minimum is measured on the **plain text**, so markup does not
  count towards it.
- Product creation can take up to 24 hours.

### Hepsiburada

- Categories are **paged**, and an attribute's values are a **second request**,
  so the mapping form takes longer to draw than the others.
- Publishing sends a **file**. You will not notice; it is mentioned because the
  batch size behaves differently: one publish covers **one category**, and
  products in another category are taken by the next run.
- A verdict of **`FAILED` is a technical error at Hepsiburada, not a refusal** —
  where the same word at the other three means the product was rejected. The
  reason says so, because re-sending is your decision.
- Echoes the **merchant SKU**; `hbSku` is Hepsiburada's own id and arrives only
  once the product exists.

## Template columns

The ecommerce template's **Variants** collection ships the four writeback
columns under *Marketplace listing* — `listing_status`, `listing_id`,
`listing_error`, `listed_at`. They are on the variant rather than the product
because a marketplace rules on one unit at a time: one size can be refused for a
missing attribute while its siblings go live.

## Beyond the admin

Everything here is reachable from the [SDK, GraphQL, MCP and the CLI](/docs/sdk-and-cli/).
The taxonomy reads hang off the **connection**, not a sync — you browse
categories while deciding whether to make a sync at all — while the mapping and
the batches hang off the **sync**, which is what they configure and what they
record.

```bash
bun backlex integrations categories <integration-id>
bun backlex integrations attributes <integration-id> --category <id>
bun backlex integrations map <sync-id> --value Apparel --category 3535 \
  --attr '338=field:colour' --attr '47=custom:Siyah'
bun backlex integrations batches <sync-id>
bun backlex integrations sync-run <sync-id>
```

`--attr` takes one flag with a named half, rather than three flags, because
which of the three answers an attribute takes is decided by the attribute — and
three flags would invite sending two.
