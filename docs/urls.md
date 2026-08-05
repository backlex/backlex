---
title: URL fields
---

A web address stored the one way every client resolves it.

A `url` field takes whatever a person types or pastes — `acme.com`,
`HTTPS://Acme.COM`, `https://acme.com:443`, `https://örnek.com` — and stores one
canonical string. On SQLite the column is `TEXT`, byte-for-byte the same storage
a plain `text` field uses. On Postgres it is `text` rather than the
`varchar(255)` a `text` field gets, which is the one place this type differs from
`email` and `phone`, and it is deliberate: see [Storage](#storage).

```jsonc
// A "Website" column on a brands collection
{ "name": "website", "type": "url" }
```

```bash
# Everything below stores exactly https://acme.com/
curl -X POST /api/items/brands -d '{"name":"Acme","website":"acme.com"}'
curl -X POST /api/items/brands -d '{"name":"Acme","website":"HTTPS://Acme.COM"}'
curl -X POST /api/items/brands -d '{"name":"Acme","website":"https://acme.com:443"}'
```

## What the fold does

In order: trim, supply the default scheme when none was written, parse with the
WHATWG URL Standard, refuse anything the field did not ask for, fold the host to
its A-labels, drop a default port, and rebuild the string from the parts.

| Written | Stored | Why |
|---|---|---|
| `HTTPS://Acme.COM/Path` | `https://acme.com/Path` | scheme and host are case-insensitive; the path is **not** |
| `acme.com` | `https://acme.com/` | the scheme is supplied — this is what people type |
| `https://acme.com` | `https://acme.com/` | the empty path is `/` |
| `https://acme.com:443/` | `https://acme.com/` | a default port means the same endpoint |
| `https://acme.com:8443/x` | `https://acme.com:8443/x` | a non-default port is load-bearing |
| `https://örnek.com/a` | `https://xn--rnek-4qa.com/a` | the form a resolver answers for |
| `https://acme.com./x` | `https://acme.com/x` | the root's trailing dot names the same host |
| `https://acme.com/a/../b` | `https://acme.com/b` | dot segments resolve |
| `https://acme.com/?b=2&a=1#F` | unchanged | query and fragment belong to the server that defined them |

The fold is **idempotent** — a canonical value passed through it again is
unchanged — which is what lets it run on every write without churning the column.

## Why this is a type and not a validation rule

Before this, sixteen columns across ten of the schema templates were a `text`
column carrying the string `^https?://.+`, and there were **five different
answers in the codebase to "is this a URL"** that did not agree with each other:
the field-level pattern, the catalog's string twin of it, a prefix-only check on
`previewUrl`, the admin's client-side mirror, and GraphQL's `new URL()` in a
`try`/`catch` — which pinned no scheme at all, so `javascript:` passed there and
was refused everywhere else.

A regex can reject a bad value; it cannot fold a good one. `HTTPS://Acme.COM/`
and `https://acme.com/` are one address and two strings, so `unique` on a URL
column meant nothing and a lookup by the address someone reads off a page found
no row.

**A canonicalizing field and a validating regex on the same column are mutually
exclusive.** Validation runs on the raw value, *before* the fold, so a pattern
demanding `https://` rejects the bare `acme.com` this type exists to accept —
and the fold that would have fixed it never runs. When you convert a column,
remove its regex. The fold is the stricter check.

`validation.format: "url"` still exists for plain `text` columns and still
requires the scheme to be written out, because nothing folds a `text` column. It
now judges everything after the scheme with the same parser this type uses.

## Configuration

Every setting is optional. A bare `url` field accepts any well-formed
`https`/`http` address and folds it, which is the right default — a "Website"
column has no business refusing a host it has not heard of.

```jsonc
{
  "name": "webhook_url",
  "type": "url",
  "url": {
    "form": "url",              // or "host" — see below
    "schemes": ["https"],       // default: ["https", "http"]
    "allowedHosts": ["partner.example"],
    "display": "ascii"          // or "unicode"
  }
}
```

### `form: "host"` — a bare domain

```jsonc
{ "name": "domain", "type": "url", "url": { "form": "host" } }
```

Stores `acme.com`, not `https://acme.com/`. This is for the column a CRM matches
a company by — it is the right-hand side of an email address, so it folds the
same way one does and can be compared with one.

The two templates that have such a column (`crm.companies.domain`,
`support.organizations.domain`) were forced to hold `https://acme.example` by the
old shared regex, which is a value that can never match an email domain. Typing
`acme.com` into one returned a 422. The schema had been distorted to satisfy a
validator that was wrong for it.

A scheme, a path, a single-label host and an IP address are all refused on a host
column.

### `schemes`

The **first** entry is also the scheme the autofill supplies, so a field
declaring `["https"]` both refuses `http://` and turns `acme.com` into
`https://acme.com/`. Only `https` and `http` are accepted: every consumer of a
stored URL either fetches it or renders it as a link, and no other scheme is safe
to do either with.

### `allowedHosts`

A subdomain of a listed host matches, so `example.com` admits
`https://docs.example.com/x`. Write it in whatever form is readable
(`örnek.com`); it is folded to A-labels on save so the rule and the values it
judges are compared in the same alphabet.

This is a schema rule about what may be **stored**. It is **not** what decides
whether a URL may be fetched — see [Storing a URL is not agreeing to fetch
it](#storing-a-url-is-not-agreeing-to-fetch-it).

### `display`

`unicode` renders an internationalized host back in its own alphabet —
`https://xn--rnek-4qa.com/a` reads as `https://örnek.com/a`. The column always
holds the A-label form; this only changes how the admin and CSV export show it.

## Filtering

Whole-value operands are folded, so a filter written the way a person types it
matches the row:

```bash
# finds the row stored as https://acme.com/
?filter={"website":{"_eq":"Acme.COM"}}
```

`_eq`, `_neq`, `_in` and `_nin` all fold. `_starts_with` folds too, but only the
part of the prefix that covers the scheme and the host.

**`_contains` and `_ends_with` are deliberately not folded.** A canonical URL is
lowercase only as far as the host; everything from the path onwards is
case-sensitive by RFC 3986 §6.2.2.1. A fragment in the middle of a URL could be a
host or a path segment and there is no way to tell which, so lowercasing it would
silently stop `_contains: "/Invoices/"` matching the rows it should. Use
`_icontains` for a case-insensitive search.

This is where the type parts company with `email`, whose stored value is
lowercase all the way through and which therefore folds every fragment operator.

## Storing a URL is not agreeing to fetch it

A `url` field does **no network call**. It does not check that the address
resolves, does not follow redirects, and does not expand a shortener. All three
are network calls on the write path whose answer is true only at the instant it
is asked, and on a field an operator controls the first of them is a
request-forgery primitive.

Whether a URL may be *fetched* is a separate question, asked at fetch time by
`fetchOutbound` — which blocks private hosts and re-validates every redirect hop.
That guard is on for managed-cloud tenants and off by default on self-host, so
that a self-hosted install can keep pointing webhooks at
`http://localhost:9000/hook`. For the same reason this type **accepts** internal
hosts: refusing `localhost`, a bare service name or an RFC1918 address would
break the deployments the product is most used in.

## What is deliberately refused

- **No tracking-parameter stripping.** Dropping `utm_*` is a policy about someone
  else's query string, the list is open and drifts, and two URLs differing only
  in `?utm_source` really are two URLs.
- **No query-parameter sorting.** `?b=2&a=1` and `?a=1&b=2` are the same request
  to almost every server and not to all of them — some APIs sign the order.
- **No trailing-slash folding on a path.** `/a/` and `/a` are different resources
  to most servers. Only the empty path is normalized, to `/`.
- **No credentials.** `https://user:pass@host/` is refused outright rather than
  stored: the column is exported, logged and shown in list cells, and a password
  does not belong in any of them. Send a header instead.
- **No reachability check, no redirect following, no shortener expansion.**

This is the same judgement `email` made about typo correction, `phone` made about
numbering plans and `geo` made about geocoders: bundle the dataset that is closed,
refuse the one that is not. Canonicalizing a URL *is* closed — it has a written
standard — which is why the parse leans on the platform's `URL` rather than a
sixth hand-written regex. The host is folded by backlex's own IDNA
implementation, the same one the `email` type uses, so the two types cannot
disagree about what a domain is.

## Storage

| Dialect | Column | Conversion from `text` |
|---|---|---|
| SQLite / D1 | `TEXT` | metadata only |
| Postgres | `text` | a widening `ALTER` |

`email` and `phone` share `text`'s `varchar(255)` because RFC 5321 caps an
address at 254 and E.164 caps a number at 16 — for those, the narrow column and
the validator agree. A URL has no such bound: a `canonical_url` or a
`tracking_url` with campaign parameters goes past 255 routinely. Storing one in a
`varchar(255)` would let a value pass validation and then be refused by Postgres,
which is exactly the write-time/act-time disagreement this type exists to end.

`applyCollection` is additive and never emits an `ALTER`, so an existing
Postgres workspace keeps whatever column it had; a fresh one gets `text` from the
start. On SQLite there is nothing to trade — `TEXT` is unbounded either way.

## Flags

Allowed, and the point of the type:

- **`unique`** — it finally means one endpoint.
- **`indexed` / `searchable`** — the index is usable precisely because nothing
  has to fold the column first.
- **`default`** — allowed here and *not* on `email`, where a default would give
  every unfilled row the same real person's mailbox and then mail it. A default
  website reaches nobody. It still has to be a URL the field would accept.

Refused:

- **`vectorize`** — an embedding of a URL matches on host and path spelling,
  which is noise; the page's content is what anyone means to search and this
  column does not hold it.
- **`localized`** — a localized URL is a genuinely different value per locale,
  which is not what this column stores.
- **`computed` / `rollup` / `sequence`** — all three own the value by another
  rule, and none of them produces something that goes through the URL parser.

## Templates

All sixteen URL columns in the schema-template catalog are `url` fields, and none
of them carries a regex any more. The two named `domain` are `form: "host"`.
