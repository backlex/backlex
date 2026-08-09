---
title: Row-level security
description: Compile the permission DSL into Postgres policies, so psql, a BI tool and a warehouse connector are filtered the way the API is.
---

Your [permission rules](/docs/permissions) are enforced by the API. Every read
goes through `compileCondition`, which turns a stored rule into a `WHERE`
fragment, and every row you get back is one your role was allowed to see.

That is complete for anything that comes through the API — and it is **nothing
at all** for anything that does not. `psql`, Metabase, a warehouse connector, an
analytics job: each opens a connection and reads the physical table, and every
row condition you wrote is simply absent.

This compiles the same rules into Postgres row-level security, so the database
enforces them too.

```bash
backlex rls plan     # the exact statements, and what they cannot carry
backlex rls apply    # install them
backlex rls status   # what is installed, and whether it still matches
```

Postgres only. On SQLite/D1 there is nothing to compile into, and the commands
say so rather than pretending.

## It cannot break backlex

Row security exempts a table's **owner** unless the table is set to `FORCE ROW
LEVEL SECURITY`. backlex connects as the owner, and this feature never forces —
so applying cannot change one thing the API does. The policies only ever apply
to somebody else's connection.

If backlex is *not* the owner of a covered table, applying is **refused**, with
the table named. There the same statement would start filtering the product
itself — with none of the session settings a policy reads set, which means every
read would return nothing.

## Who the database thinks you are

A policy needs an identity, and a raw connection has none. It reads one from
session settings:

```sql
SET backlex.user_id   = 'usr_123';
SET backlex.roles     = 'editor,viewer';   -- comma-separated
SET backlex.tenant_id = 'wsp_abc';
SET backlex.org_id    = 'org_9';           -- optional
SET backlex.orgs      = 'org_9,org_4';     -- optional
```

A PostgREST-shaped `request.jwt.claims` JSON blob is accepted too, with the same
keys — so a client that already sets one works unchanged.

A connection that sets **none** of them is nobody, and sees nothing. An
unreadable claims blob is also nobody: `backlex.claim()` catches the parse
failure and returns NULL rather than anything more forgiving.

Every DSL variable has one expression:

| DSL | SQL |
|---|---|
| `$user.id` | `backlex.uid()` |
| `$user.email` | `backlex.email()` |
| `$user.roles` | `backlex.roles()` |
| `$tenant.id` | `backlex.tenant_id()` |
| `$org.id` | `backlex.org_id()` |
| `$org.role` | `backlex.org_role()` |
| `$user.orgs` | `backlex.orgs()` |
| `$now` | `now()` |

The helper functions live in a `backlex` schema, granted to `PUBLIC` — every
policy calls them, so a connection without access would get
`permission denied for schema backlex` instead of a narrower result set.

## What gets installed

One policy per (collection, role, action), named
`backlex_<collection>_<role>_<action>`:

```sql
CREATE POLICY backlex_notes_reader_read ON c_ab12_notes
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (backlex.has_role('reader')
     AND "tenant_id" = backlex.tenant_id()
     AND "deleted_at" IS NULL
     AND ("holder" = backlex.uid()));
```

- **`TO PUBLIC`**, unless you set `RLS_APP_ROLE`. That is the strict choice, not
  the loose one: a policy bound to one named role leaves every *other* role
  unfiltered, so the next connection somebody creates would be a hole.
- **`INSERT` gets `WITH CHECK`; `UPDATE` gets both.** `USING` decides which rows
  you can see, `WITH CHECK` which rows you may produce. An `UPDATE` with only
  `USING` would let a session move a row out of its own scope.
- **Soft-deleted rows are excluded from read/update/delete**, so a direct reader
  sees what the API would.
- **An admin role gets no policy.** Its API access is unconditional, and a
  policy saying `TRUE` for it would be a standing bypass sitting in the database
  for anyone who can set `backlex.roles`.

Applying is idempotent — each policy is dropped and recreated, so re-running
after a rule change replaces rather than accumulates.

## What a policy cannot carry

`plan`, `apply` and `status` all return an `omissions` list. **Read it.** Each
entry is a part of your permission model the database will not enforce, so a
direct reader sees a *coarser* view than the API there:

| Not represented | Why |
|---|---|
| A field allow-list | Column privileges are per database role, and the union across the backlex roles one session holds cannot be expressed as one. A direct reader sees every column of the rows it may read. |
| A condition that walks a relation (`author_id.name`) | It lowers to a correlated subquery that would need the joined table's own policy to agree. |
| `_near` | It filters against a query origin, and a policy has no caller to take one from. |
| Actions with no SQL command (`publish`, …) | There is no statement for a policy to attach to. The API still enforces them. |

A condition that cannot be compiled gets **no policy at all**, rather than being
downgraded to "no condition" — the downgrade would install a rule strictly wider
than the one it came from.

## Drift

Policies are a snapshot of the rules at the moment they were applied. Editing a
role afterwards changes the API immediately and the database not at all, so
`status` reports the gap:

```
applies to  PUBLIC
installed   14
expected    16
stale       0
missing     2
```

Re-run `apply` to close it. Applying automatically on every permission edit was
deliberately not built: DDL against every physical table is not something a
checkbox toggle should trigger, and a failure there would surface as a failed
permission save.

## Turning it off

```bash
backlex rls disable
```

Drops the policies backlex installed. Row security itself is disabled only on
tables left with **no** policies at all — a hand-written policy somebody else
added keeps its table protected.

## Surfaces

| Surface | Where |
|---|---|
| REST | `/api/admin/rls/{status,plan,apply,disable}` |
| SDK | `backlex.rls.*` |
| GraphQL | `rlsStatus`, `rlsPlan`, `applyRls`, `disableRls` |
| MCP | `rls.status`, `rls.plan`, `rls.apply`, `rls.disable` |
| CLI | `backlex rls …` |
