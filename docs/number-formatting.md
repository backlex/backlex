---
title: Number formatting
---

A field's `format` block is a **display** hint. It changes how the admin renders
a value in lists and detail views, and nothing else — storage, the API, sorting
and filtering always use the raw value.

```jsonc
{
  "name": "discount_pct",
  "type": "integer",
  "validation": { "min": 0, "max": 100 },
  "format": { "style": "percent100" }
}
```

| Key | Applies to | Meaning |
|---|---|---|
| `style` | `integer` / `number` | `plain`, `decimal`, `currency`, `percent`, `percent100` |
| `precision` | `integer` / `number` | Fixed fraction digits |
| `currency` | `style: "currency"` | ISO 4217 code |
| `thousandSeparator` | `style: "decimal"` | Group thousands (default on) |
| `dateStyle` | `timestamp` | `relative`, `date`, `datetime`, `time` |
| `prefix` / `suffix` | any | Wrap the rendered value |

A [`money` field](./money.md) ignores `style` entirely: the currency is carried
on the value, which is strictly better information than a display hint someone
typed. A [`phone` field](./phone.md) renders through its own `display` for the
same reason.

## The two percent styles

`percent` and `percent100` differ by **what the column holds**, and picking the
wrong one is off by a factor of a hundred:

| Style | Column holds | Renders as |
|---|---|---|
| `percent100` | `20` | `20%` |
| `percent` | `0.2` | `20%` |

**`percent100` is almost certainly the one you want.** It is what every schema
template means: all seventeen percentage columns validate `{min: 0, max: 100}`,
which says the stored number is `20`, not `0.2`.

`percent` exists because it is the older token and follows
`Intl.NumberFormat`'s own convention. It keeps that meaning so that a workspace
already storing fractions is not silently re-rendered. But it is a trap on a
0–100 column — two template fields carried exactly that combination and printed
`20` as **2,000%** until `percent100` was added.

The admin's format editor names both by what the column holds rather than
offering one ambiguous "Percent", because the label was the whole problem.

### Locale placement is not hand-assembled

`percent100` divides by a hundred and hands the result to `Intl`, rather than
formatting a plain number and appending `%`. That is deliberate: Turkish writes
the sign **first**, so the same value renders `20%` in English and `%20` in
Turkish. Appending the sign would have been wrong in every locale that does not
put it last.

## What is deliberately not a percentage

The conversion of the templates went by **meaning**, not by matching
`{min: 0, max: 100}`. A lead score of 80 is not "80%" — that range is a scale,
not a proportion — so `crm.leads.score`, `hr.training_attendance.score` and
`lms.quiz_attempts.score` keep printing as plain numbers.

`lms.quizzes.passing_score` is the exception, and a deliberate one: its own label
is "Passing score (%)", so the template already meant a percentage.

A test pins both halves of that rule, because "it has a 0–100 range" is exactly
the shortcut that would quietly put a percent sign on a score.
