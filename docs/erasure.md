---
title: Data-subject erasure
description: Erase or anonymize one person across collections, revisions, activity, comments, notifications, analytics, crash reports, devices and files — with a preview first and a report after.
---

A deletion request is not a `DELETE`. One person's data sits in the end-user
record, the collections that reference them, the **revision history** of those
rows, the activity log, comments, notifications, analytics, crash reports, their
devices and their uploaded files.

An operator cannot see all of that from one screen — which is why this belongs in
backlex rather than in an app on top of it. The relation graph and the physical
tables are here.

## Two steps, always

```bash
# 1. What would this touch? Destroys nothing.
curl -X POST /api/admin/erasure/preview \
  -d '{"subject":{"type":"email","value":"alice@example.com"},"mode":"anonymize","reference":"DSR-42"}'

# 2. Carry it out. Irreversible.
curl -X POST /api/admin/erasure/<id>/run \
  -d '{"subject":{"type":"email","value":"alice@example.com"},"confirm":true}'
```

The subject is supplied on **both** calls, and that is not an oversight — see
[the record must not re-create what it removes](#the-record-must-not-re-create-what-it-removes).

## Two modes

| Mode | What happens | When |
|---|---|---|
| `anonymize` | Rows survive with identifying fields scrubbed; the end-user record becomes a tombstone (`Erased user`, `…@erased.invalid`, `is_anonymous`) | Usually the only lawful option — an invoice generally cannot be deleted |
| `delete` | Rows and the end-user record are removed outright | When nothing obliges you to keep them |

**Revisions are deleted in both modes.** Anonymizing a row while keeping its
history is theatre: the old address is sitting in the snapshot.

## Finding the subject

Two mechanisms, and the split is deliberate:

- **Ownership is authoritative.** An owner-scoped collection says outright whose
  row it is.
- **Email matching.** A field of the [`email` type](/docs/email/) is matched
  outright — declaring it *is* the declared intent. So is any **text** field
  declared as an email another way (`interface: "email"`,
  `validation.format: "email"`, or simply named `email`), which is the
  heuristic half. Together they find the common case — a `customers` table
  keyed by address — with no configuration.

The heuristic can only match when the **value** equals the subject's address, so
a false positive is a row that genuinely contains their email. The preview exists
so you see exactly what was found before anything is destroyed.

**Adopted tables are skipped.** They belong to somebody else's application and
you never told backlex what their columns mean.

An address with **no account** is still a subject: it may appear in a collection,
and "no user row" is not "nothing to erase".

## A cookie-consent visitor is a subject you cannot look up

Erasure takes three kinds of subject: `app_user`, `email` and `consent_id`. The
third is different in a way that matters operationally.

A consent record carries no email and no account. The only handle on it is the
opaque id the banner minted **in the visitor's own browser**, and there is no
table anywhere that maps a person to it. Two consequences, both deliberate:

- **An `email` or `app_user` request will not reach consent records**, and will
  honestly report `consent: 0`. That zero means "not reachable by this handle",
  not "they had none". If you are answering a data-subject request and consent
  is in scope, you have to ask them for the id.
- **You cannot discover the id yourself.** A request that names one is acting on
  a value the subject supplied. That is the same property that makes the id
  privacy-preserving in the first place.

**Where the visitor gets the id to give you.** Reopening the banner shows it,
under "Your consent id" — that is what makes this right exercisable rather than
merely documented. See [Withdrawal](./cookie-consent.md#withdrawal) for the two
ways to reopen it.

The visitor's own way out does not involve you at all: the banner's **Withdraw**
link deletes exactly the same rows, with no operator in the loop and no request
to file.

## What a run reaches

| Surface | Action |
|---|---|
| `collections` | Anonymized or deleted per mode |
| `revisions` | Deleted — always |
| `files` | Stored object deleted first, then the row — deleting only the row leaves the bytes in the bucket with nothing pointing at them. Objects the adapter could not remove are counted as `filesUnreachable` |
| `comments` | Deleted |
| `notifications` | Deleted |
| `activity` | Deleted, not scrubbed — the row carries IP and user agent beside the id, so nulling the id alone leaves the person identifiable |
| `analytics` | Deleted — **but keyed on the end-user id only.** A visitor who was never signed in is identified in `analytics_events` by `distinct_id`, which erasure does not match on, so their events are not reached. Stated here rather than left for someone to discover: this is a real limit of the current implementation, not a design choice |
| `errors` | Deleted — a crash report carries a stack and a free-form context blob |
| `devices` | Push tokens deleted |
| `identity` | Sessions, accounts, roles, org memberships, external identities and phone numbers deleted; the user record deleted or tombstoned per mode |
| `consent` | Every recorded cookie-consent decision for the subject, **deleted in both modes** — the `subject_id` *is* the identifier, so scrubbing it would leave a row carrying a user agent, an IP hash and a timestamp that identifies nobody and proves nothing. Reachable **only** with `subject.type = "consent_id"` — see [a cookie-consent visitor is a subject you cannot look up](#a-cookie-consent-visitor-is-a-subject-you-cannot-look-up) |

### The derived indexes go with the row

A value does not live in one place. The write path puts a searchable field into
the full-text shadow table, a `vectorize` field into the embedding store, and a
`localized` field into the `__i18n` sidecar — so a sweep that only touched the
base table left the address searchable through `?q=` and retrievable through
vector search while reporting `completed`. Erasure therefore runs the same index
maintenance an ordinary delete or update runs: `delete` drops the FTS row, the
vectors and the sidecar rows per id; `anonymize` clears the scrubbed fields'
sidecar values and **re-indexes from the scrubbed row**, because both indexes
are built from field values and leaving them alone keeps the old text findable
under the pseudonymized row.

## What it cannot reach

Returned on every request as `limits`, because a tool that ignored them while
reporting `completed` would say a legal obligation is discharged when it is not:

- **Backups taken before the request** still contain the subject. That is a
  retention-policy matter, not something erasure can reach.
- **Data already delivered to third parties** through integrations, webhooks or a
  warehouse sync must be erased at those destinations separately.

## The record must not re-create what it removes

An audit row reading *"we erased alice@example.com"* outlives every row it
deleted — it is the one place the address would survive the erasure.

So the request row stores **no** address and no user id. It keeps:

- `subject_hash` — SHA-256 of `AUTH_SECRET + tenant + type + normalized subject`.
  Salted on purpose: an unsalted hash of an email is not a pseudonym, because the
  space of real addresses is small enough to enumerate.
- `subjectRef` — the first 12 hex characters, enough to see that two requests
  concerned the same person and useless on its own.
- `reference` — your own ticket id. Yours to keep free of personal data.
- Per-surface counts in `plan` and `report`. Counts, never values.

That is also why the run re-supplies the subject: there is no stored address to
act on, and matching the hash is what proves the second call means the same
person.

## Guards

- A run **refuses a request that was never previewed**.
- A run **refuses a different subject** than the one previewed.
- A run **refuses to replay** a completed request.
- `confirm: true` is required, so an empty body cannot trigger one.
- The run **re-locates the subject** rather than acting on the stored plan — a
  preview may be days old, and a stale list would both miss rows written since
  and try to delete rows already gone. The plan is a preview, not a work order.
- A failed run is left `failed` with the reason rather than rolled back. Erasure
  is not transactional across these surfaces, so a partial run is a fact the
  operator has to see and re-run.

## Surfaces

| Surface | Entry point |
|---|---|
| REST | `/api/admin/erasure` (+ `/surfaces`, `/preview`, `/{id}/run`) |

Admin-only, and scoped to the active workspace throughout — another workspace's
request cannot be read or run, and its collection rows are never counted or
touched.
