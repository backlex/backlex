---
title: Sync hooks
description: Let an external service participate in a write — validate it, enrich it, or reject it — instead of only being told about it afterwards.
---

Every other extension point in backlex runs **after** the fact. Outbound
webhooks, flows and extension event hooks all fire once the row is committed. A
**sync hook** runs *before* the write and its answer decides the outcome.

That difference is what lets somebody else own validation, enrichment, pricing
or tax without backlex shipping an integration for each one. It is the same
mechanism behind Saleor's synchronous webhooks and Shopify Functions.

```
POST https://your-app.example/guard
{
  "event": "orders.beforeCreate",
  "collection": "orders",
  "phase": "beforeCreate",
  "id": null,
  "data": { "total": 4200, "country": "DE" },
  "actor": { "userId": "…", "email": "…", "roles": ["editor"] },
  "at": "2026-07-30T09:00:00.000Z"
}
```

Your service answers one of:

```json
{ "allow": true }                                   // proceed
{ "allow": true,  "data": { "tax": 798 } }          // proceed, patched
{ "allow": false, "reason": "VAT id is required" }  // reject the write
```

A rejection surfaces to the caller as **403** with your `reason`.

## Phases

| Event | When | Notes |
|---|---|---|
| `<collection>.beforeCreate` | before the row is inserted | `id` is `null` — it does not exist yet |
| `<collection>.beforeUpdate` | before the patch is applied | `data` is the **patch**, not the whole row |
| `<collection>.beforeDelete` | before the row is removed | `data` is the row being deleted; only the verdict is used |

Patterns support `<collection>.<phase>`, `<collection>.*`, `*.<phase>` and `*`.
Deliberately no prefix or regex matching — a hook sits on the write path, and a
pattern language with surprises in it is a way to accidentally block every write
in the workspace.

## The decisions you have to make

### `onError` — there is no safe default

When a hook cannot answer (timeout, non-2xx, unreadable body) backlex does what
you configured:

| `onError` | Behaviour | Use when |
|---|---|---|
| `deny` | the write is blocked | the hook enforces something that must not be skipped — compliance, fraud, entitlement |
| `allow` | the write proceeds | the hook enriches, and stale data beats an outage |

This field is required. `allow` silently drops the guarantee the hook exists to
provide; `deny` converts your app's outage into your customer's. Only you can
say which is worse for a given hook.

A **200 response whose body cannot be read, or omits `allow`, is not an
approval** — it is a failure, and `onError` applies. A broken app must not be
able to quietly disable itself.

### `canMutate` — mutation is opt-in

A hook's `data` patch is ignored unless `canMutate` is set. A hook registered to
*validate* must not be able to rewrite rows just by returning a `data` key.

A patch is a **shallow merge**, and the merged body is **re-validated** against
the collection schema — the hook is external, so its output is trusted no more
than the client's.

### Timeouts

| Bound | Default | Max |
|---|---|---|
| One hook | 2000 ms | 10 000 ms |
| All hooks for one write, combined | — | 15 000 ms |

The per-hook bound uses a real `AbortController`, so a hanging app is cut off
rather than holding the request. The combined bound exists because several
slow-but-not-timing-out hooks would otherwise add up to a hung write; exceeding
it fails the write with **503**.

## Ordering

Hooks run **sequentially**, ordered by `priority` then age, and each one sees the
previous hook's patch. Running them in parallel would make two hooks patching
the same field a coin flip. The first rejection stops the chain.

## Signing

Give a hook a `secret` and every call carries:

```
x-backlex-timestamp: 1785400000
x-backlex-signature: <hex HMAC-SHA256 of `${timestamp}.${body}`>
```

The timestamp is in its own header *and* inside the signed string, so your app
can reject a stale call without parsing the signature. Custom headers are
applied first, so they can never override the signing headers.

## When hooks do not run

- **Disabled hooks**, and hooks belonging to another workspace. A hook with no
  workspace is instance-wide and runs for every workspace's writes.
- **After the breaker trips.** 15 consecutive failures disable the hook — a dead
  `deny` hook that stayed enabled would block every write forever. Any success
  resets the counter.

They *do* run on bulk paths (CSV import, batch, bulk update). That is a
deliberate choice: skipping them there would make the batch endpoint a way to
bypass a validation gate silently. If a hook makes an import too slow, disable
the hook — do not rely on backlex quietly not calling it.

## Placement in the write

Hooks run **last in the validation phase**: after schema validation, relation
checks, field conditions, validation rules, and after `hash` fields have been
digested — so a hook never sees a plaintext password.

## Managing hooks

`/api/admin/sync-hooks`, admin-only:

| Method | Path | |
|---|---|---|
| GET | `/` | list (secrets never included) |
| POST | `/` | create |
| PATCH | `/{id}` | update — omit `secret` to keep the stored one; re-enabling clears the breaker |
| DELETE | `/{id}` | remove |
| POST | `/{id}/test` | fire one synthetic call and report the verdict |

Use **test** before you rely on a hook. It sends a `__test__.beforeCreate`
payload and shows you what came back, so a misconfiguration surfaces there
rather than as a blocked write in production. It does not touch the failure
counter.

:::caution
A hook is bound to the workspace that created it, and the API has no way to
create an **instance-wide** one. That is deliberate rather than an omission: a
hook with no workspace receives the pending row data of *every* workspace on the
instance, so it would be a read channel into everyone else's writes. Instance
operators who genuinely want one insert the row directly.
:::
