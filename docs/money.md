---
title: Money fields
---

A `money` field stores an amount **and the currency it is denominated in**, as
one value, exactly.

```http
POST /api/items/products
{ "name": "Mug", "price": 19.99 }

→ 201 { "data": { "name": "Mug", "price": { "amount": 19.99, "currency": "TRY" } } }
```

The column holds `1999` — an integer count of kuruş. Nothing along the way went
through a float, and nothing will add that number to a dollar.

## Why this exists

Two hundred columns across twenty-three of the twenty-seven schema templates are
money: `price`, `total`, `subtotal`, `amount_paid`, `salary`, `budget`,
`balance_due`. Every one of them was a bare `number`, and thirty-seven `text`
columns named `currency` sat next to them with nothing tying the two together.

**Not all of them became `money` fields, and the ones that did not are a
deliberate stop rather than a backlog.** A `money` field must say what it is
denominated in, and a template cannot invent that. So a column became `money`
where the collection *states* its own denomination — it ships a `currency`
column beside the amount, which is what the invoice, deal and offer tables were
already doing by hand. Everything else stayed a plain decimal: line-item tables
whose currency belongs to the parent row, and catalogue prices that carry a
number without ever naming a unit. Those are a modelling decision per template
— give the table its own `currency`, or pin one — not a mechanical conversion.

Two consequences worth knowing before you pick:

- A plain decimal is a float. It has no currency, the admin prints `1234.5`
  rather than `₺1.234,50`, and a rollup summing a thousand of them accumulates
  the error described below.
- A `money` field denominated by a per-row `currency` column **cannot be summed
  without saying which currency** — `sum` over it is refused unless the query
  passes `groupBy: "currency"`, because adding ₺ to $ is not an amount. That is
  the trade the templates make, and why every bundled KPI over such a column
  groups by it.

That left three things broken at once:

- **The arithmetic.** `number` is `double precision` on Postgres and `REAL` on
  SQLite. `0.1 + 0.2` is not `0.3` in either, and a rollup summing a thousand
  invoice lines accumulates the error into a stored total.
- **The meaning.** A rollup, an aggregate or a dashboard panel would happily add
  ₺ to $ and report the sum as a number, because nothing in the schema said the
  rows were denominated differently.
- **The rendering.** `Intl.NumberFormat` needs a currency code and the admin had
  nowhere to get one, so an amount printed as `1234.5`.

## Adding one

In the admin, add a field and pick **Money**, then answer one question on the
Currency tab: is it the same for every row, or does each row say?

Over the API:

```http
POST /api/collections
{
  "slug": "products",
  "fields": [
    { "name": "name",  "type": "text" },
    { "name": "price", "type": "money", "money": { "currency": "TRY" } }
  ]
}
```

Or, for a table that bills in whatever the customer pays in:

```http
{
  "slug": "invoices",
  "fields": [
    { "name": "currency", "type": "text" },
    { "name": "total", "type": "money", "money": { "currencyField": "currency" } }
  ]
}
```

Exactly one of `currency` and `currencyField` is required. A money field with
neither has no way to interpret its own column; one with both has two answers
that can disagree. Both are refused at save time.

`currencyField` must name a `text` field on the same collection. It does not
have to be called `currency`.

## What is stored

**Minor units** — an integer count of the currency's smallest denomination, in a
`bigint` (Postgres) / `INTEGER` (SQLite) column.

| Written | Currency | Stored |
|---|---|---|
| `19.99` | USD | `1999` |
| `1000`  | JPY | `1000` |
| `1.234` | KWD | `1234` |

The exponent comes from ISO 4217, so the ~30 currencies that are not
two-decimal behave correctly without anyone configuring them: the yen has no
minor unit, the Gulf dinars have three. A code the table has never seen assumes
two.

Integers are exact in both dialects, they sum exactly, they sort correctly, and
every comparison SQL can make on them is the comparison you meant. The wire
format stays major units because that is what humans, invoices and every other
system speak; the conversion happens once on each edge of the API, on the
decimal *string* rather than by multiplying a double. (`12.34 * 100` is
`1233.9999999999998`, and the obvious `Math.round` around it gets `1.005`
wrong.)

## What a write accepts

| Form | Example |
|---|---|
| A number | `19.99` |
| A decimal string | `"19.99"` |
| A tagged string | `"19.99 USD"` |
| The canonical object | `{ "amount": 19.99, "currency": "USD" }` |
| Minor units | `{ "minor": 1999, "currency": "USD" }` |

A value that names a currency is checked against the field's. Writing
`{ "amount": 10, "currency": "EUR" }` to a USD column is a `422`, not ten
dollars — the two differ by whatever the exchange rate is, and backlex does not
know it.

### What the API will not guess

- **Thousands separators.** `"1,234"` is one thousand two hundred and thirty-four
  in one convention and one-and-a-bit in another, and nothing in the request says
  which. Rejected. The admin's amount input resolves it against the UI locale
  before it posts, which is the one place the answer is actually known.
- **Currency symbols.** `"$12.34"` is four different currencies. Rejected; use
  the ISO code.
- **Extra precision.** `19.999` in a two-decimal currency is not an amount that
  currency can express, and quantizing it would be the server deciding where
  half a cent goes. Rejected.

Floating-point noise is not precision: `0.1 + 0.2` arriving as
`0.30000000000000004` stores thirty cents, because the excess is a millionth of
a millionth of one and is an artifact of the caller's arithmetic rather than a
decision they made.

## Reading

Always `{ amount, currency }`, on every surface — REST, GraphQL, the SDK, the
changefeed, expanded relations, the sandbox bridge. `amount` is major units.

A `money` cell in the admin renders through `Intl` in the row's own currency,
with that currency's number of decimals, so a yen total is not printed with two
of them.

**CSV is the one exception, on purpose.** An export writes the bare amount
(`19.99`), because a column of `{"amount":19.99,"currency":"TRY"}` is text a
spreadsheet cannot total. The currency is either fixed on the field — so it is in
the schema, not the data — or already its own column in the same row. An import
reads that same bare amount back.

## Filtering

Operands are in major units, like everywhere else:

```http
GET /api/items/products?filter={"price":{"_gte":100}}
```

A hundred lira, not a hundred kuruş.

**On a per-row-currency field, a comparison must name its currency:**

```http
GET /api/items/invoices?filter={"total":{"_gte":{"amount":100,"currency":"USD"}}}
```

which compiles to `total >= 10000 AND currency = 'USD'`. Without that second
clause the comparison would range across denominations, where `10000` minor
units is a hundred dollars *and* a hundred yen — a page of rows nobody asked
for, with nothing in the response to show it. A bare number there is a `422`
that says so.

`_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_nin` and `_between` all
work. `_null` / `_nempty` work ("which rows have no price yet?"). The string
operators (`_contains`, `_starts_with`, …) are refused: they would match on the
digits of a stored integer.

## Sorting

`sort=price` orders by amount.

On a per-row-currency field it orders by **currency first, then amount inside
it**. Ordering by the raw integer alone would interleave denominations — `100`
yen ahead of `1.50` euro — and present that as "cheapest first". Grouping is the
only ordering of mixed money that is true, and it is still a total order, so
keyset pagination is unaffected.

## Totals

### Rollups

A `money` parent column can `sum`, `min` or `max` a `money` child column:

```json
{
  "name": "total",
  "type": "money",
  "money": { "currency": "TRY" },
  "rollup": { "from": "invoice_lines", "via": "invoice", "fn": "sum", "field": "amount" }
}
```

The refresh is `UPDATE … SET total = (SELECT SUM(amount) …)` — raw integers
moving from one column to another, with no scaling and no interpretation. So the
two ends have to mean the same thing, and four ways of them not meaning the same
thing are refused when the field is saved:

- a money child summed into a plain `number` column (the parent would store
  `199900` and print it as a number);
- two different currencies (a sum with no exchange rate in it);
- the same currency with different exponents;
- a child whose currency varies per row (the SUM would add denominations
  together before the parent ever saw it).

`avg` on a money column is also refused: an average falls between minor units far
more often than not, and an integer column would truncate a fraction of a cent
per parent, silently and forever. Roll up the sum and the count instead.

### Aggregates

```http
POST /api/items/products/aggregate
{ "agg": "sum", "field": "price" }

→ { "data": [{ "value": 4821.75, "currency": "TRY" }] }
```

Major units, with the code. On a per-row-currency field, `sum`/`avg`/`min`/`max`
require `groupBy` on the currency column:

```http
POST /api/items/invoices/aggregate
{ "agg": "sum", "field": "total", "groupBy": "currency" }

→ { "data": [
     { "label": "USD", "value": 1240.00, "currency": "USD" },
     { "label": "JPY", "value": 98000,   "currency": "JPY" }
   ] }
```

Each bucket is scaled by its own exponent. Without the `groupBy` it is a `422`
naming the column to group by — adding ₺ to $ produces a number with no unit, and
a dashboard tile would print it as if it had one.

## Changing a row's currency

On a per-row-currency collection, a patch that changes the currency to one with
a **different number of decimals** without restating the amount is refused:

```http
PATCH /api/items/invoices/abc  { "currency": "JPY" }
→ 422 changing this row from USD to JPY changes how many decimals "total" has —
      restate "total" in the same write
```

The column holds minor units. Re-labelling `1999` from USD to JPY does not
convert nineteen dollars ninety-nine into yen; it reads the same integer through
a different exponent and turns it into one thousand nine hundred and ninety-nine
yen. Sending the amount in the same write is the escape hatch, and the right
move anyway.

When the exponent is unchanged the relabel goes through: `19.99 USD` becoming
`19.99 EUR` is a decision an operator can legitimately make, and refusing it
would mean inventing a currency-conversion policy.

## Adopted tables

An existing table whose amount column is already a `numeric` / `REAL` of major
units keeps that layout:

```json
{ "name": "price", "type": "money", "money": { "currency": "USD", "storage": "decimal" } }
```

backlex reads and writes the column as it is, so other systems writing to the
same table keep working. The cost is exactness: on SQLite that column is a
`REAL`, and sums drift in the last places. The schema applier never *creates* a
`decimal` column — it exists so a table you adopted does not have to be rescaled
by a hundred because backlex started reading it.

## What is deliberately not here

**Currency conversion.** There is no FX rate source, no `convert` operator and no
"show me everything in USD" mode.

A rate is a point in time. A stored conversion is wrong tomorrow and nothing
would come along to fix it; a live conversion would make every list query depend
on a third-party provider being up, and every total in the workspace change
without a write. Instead, money is exact, mixed aggregation is refused loudly,
and a workspace that needs a consolidated figure computes it where the rate and
the as-of date are a deliberate choice — which is what an accounting system
does.

**Per-locale prices.** `localized` is refused on a money field. A price is not a
different amount in French; a per-locale price list is a per-locale *row*, or a
second column.

## Client-side

`@backlex/db/money` (in-repo) and the `backlex` SDK (npm) both export the
`MoneyValue` type and `formatMoney`, so a table cell, the item form and the
server all render an amount with the same function.

The SDK deliberately ships no helper that *adds* money. Totals over rows are what
rollup fields and `aggregate` are for, and both refuse to mix currencies — a
client-side sum would be a second implementation of that rule, in floating point,
with no way to enforce it.

## Reference

| Spec key | Meaning |
|---|---|
| `currency` | Fixed ISO-4217 code for the whole column. |
| `currencyField` | Sibling `text` field holding the code per row. |
| `exponent` | Override the minor-unit count (0–6). Fixed-currency fields only. |
| `storage` | `minor` (default) or `decimal` (adopted tables). |

| Flag | On a money field |
|---|---|
| `required`, `unique`, `indexed` | Allowed — an ordinary integer column. |
| `default` | Allowed, in major units. Only `0` when the currency is per row. |
| `computed` | Allowed; the expression works in **stored** units. |
| `rollup` | Allowed under the rules above. |
| `searchable`, `vectorize` | Refused — matching on the digits of an integer is noise. |
| `localized`, `sequence` | Refused. |
