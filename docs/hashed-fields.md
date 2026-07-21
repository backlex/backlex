---
title: Hashed fields (passwords & secrets)
description: Store one-way hashed secrets in a collection — write-only, verify-only, never read back.
---

A `hash` field stores a **one-way hashed secret** — a password, PIN, API
secret, or any value you must be able to *check* but never *read*. Backlex
scrypt-hashes the plaintext on write and stores only the digest; reads always
return `null`; the only way to test a value is the verify endpoint.

> **Not the same as end-user login.** If you want real account authentication
> (sign-in, sessions, OAuth, password reset), use the
> [workspace end-user auth plane](/auth-planes/) — it already manages
> `app_users` password storage for you. A `hash` field is for the *other*
> secrets your app owns: device codes, redeemable coupons, second PINs, shared
> webhook secrets a customer sets, and so on.

## Declaring the field

Add a field of type `hash` (admin UI: the **Password / Secret** interface):

```jsonc
POST /api/collections
{
  "slug": "devices",
  "fields": [
    { "name": "label", "type": "text" },
    { "name": "pairing_pin", "type": "hash", "required": true,
      "validation": { "minLength": 6 } }
  ]
}
```

Validation rules (`minLength` / `maxLength` / `regex`) run against the **plaintext**
before it's hashed, so you can enforce a password policy. `unique`, `indexed`,
`searchable`, `vectorize`, `default`, and `computed` are rejected on a `hash`
field — a salted digest can't be meaningfully indexed, searched, or defaulted.

## Writing

Write the plaintext like any other field — the server replaces it with the
digest:

```ts
await backlex.from("devices").create({ label: "Kiosk 1", pairing_pin: "8461-22" });
await backlex.from("devices").update(id, { pairing_pin: "new-pin-99" }); // re-hash
await backlex.from("devices").update(id, { pairing_pin: "" });           // keep current
```

An **empty / omitted** value on update leaves the existing digest untouched
("leave blank to keep"). A value already in stored digest form
(`<salt>:<key>` hex) passes through unchanged, so a database migration or
restore that feeds pre-hashed rows is never double-hashed.

The digest is scrubbed from the write response, the realtime event, and the
audit log — it exists only in the column.

## Reading

`hash` fields always resolve to `null` on every read surface — REST list/get,
GraphQL, the offline changefeed, and CSV export. Raw backups are the one
exception: they `SELECT *` without deserializing, so restore round-trips the
digest.

Filtering and sorting on a `hash` field are rejected with `422` — allowing them
would turn the list endpoint into a guessing oracle.

## Verifying

Check a plaintext against the stored digest without ever exposing it:

```ts
const { valid } = await backlex.from("devices").verify(id, "pairing_pin", "8461-22");
```

- **REST:** `POST /api/items/:slug/:id/verify` with `{ field, value }` →
  `{ valid }`. Requires the `read` permission on the item.
- **GraphQL:** `verify<Collection>(id, field, value): Boolean!` (emitted only
  for collections that have a hash field).
- **MCP:** the `items.verify` tool.
- **CLI:** `backlex items verify <slug> <id> --field <name> --value <plaintext>`.

Every attempt is throttled per `(collection, item, field)` and audit-logged
(field name + boolean result only — never the plaintext or digest), so a leaked
read credential can't brute-force a secret.

## How it's hashed

The digest is produced by better-auth's own scrypt primitives (the same
algorithm the auth planes use for account passwords) — pure-JS scrypt, so it
runs identically on Cloudflare Workers, Bun, Vercel, and Netlify with no native
dependency. The stored format is `<salt-hex>:<key-hex>`.
