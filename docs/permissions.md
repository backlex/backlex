---
title: Permissions DSL
description: JSON permission language shared by REST, GraphQL, realtime filters, and DB persistence.
---

Backlex has its own JSON permission language. Same DSL is used for:

- Role permission `condition` field (DB persistence)
- REST `?filter=...` query string
- GraphQL filter argument

Compiler emits Drizzle `SQL` fragments (parameterized) for the SQL path,
and an in-process matcher (`matchesCondition`) for realtime/sandbox.

## Operators

| Op             | Means                          | Example                                  |
|----------------|--------------------------------|------------------------------------------|
| `_eq`          | equal                          | `{ "status": { "_eq": "published" } }`   |
| `_neq`         | not equal                      |                                          |
| `_in`          | in array                       | `{ "status": { "_in": ["a", "b"] } }`    |
| `_nin`         | not in array                   |                                          |
| `_gt`/`_gte`/`_lt`/`_lte` | numeric / lexical   | `{ "views": { "_gt": 100 } }`            |
| `_null`        | is/is-not null (boolean)       | `{ "deleted_at": { "_null": true } }`    |
| `_contains`    | LIKE %x%                       | `{ "title": { "_contains": "foo" } }`    |
| `_starts_with` | LIKE x%                        |                                          |
| `_ends_with`   | LIKE %x                        |                                          |
| `_between`, `_icontains`/`_istarts_with`/`_iends_with`, `_empty`/`_nempty` | range, case-insensitive LIKE, null-or-empty | see [Querying › Operators](/docs/querying/#operators) |

Conditions speak the **same DSL as REST `filter`** — the full operator set,
relation dot-paths, the `_and`/`_or`/`_not` aliases, and relative dates
(`{ "$now": { "sub": { "months": 1 } } }`) all work in a `permission.condition`
too. See [the Querying reference](/docs/querying/) for the complete operator set.

## Logical combinators

```jsonc
{
  "$or": [
    { "owner_id": { "_eq": "$user.id" } },
    { "published": { "_eq": true } }
  ]
}
```

- `$and: [...]` — all must match. Top-level keys are also implicit AND.
- `$or:  [...]` — any.
- `$not: {...}` — negation.
- `_and` / `_or` / `_not` are accepted aliases (normalized to the `$`-forms).

## Variables

Resolved against the request's auth subject:

- `$user.id` — current user's id (null when anonymous)
- `$user.email`
- `$user.roles` — array of role names
- `$tenant.id` (aka `$user.tenant_id`) — active workspace id
- `$now` — `Date.now()`

App-plane only (see [Organizations](/docs/app-organizations/)) — these are
resolved for workspace end-users and are always null/empty for control-plane
identities:

- `$org.id` — the organization this request is acting in
- `$org.role` — the caller's membership role in it (`owner` / `admin` / `member`)
- `$user.orgs` — array of every organization id they belong to

`$user.id` resolving to null short-circuits comparison ops to false, so
anonymous users never accidentally match `{ owner_id: { _eq: "$user.id" } }`.
`$org.id` behaves the same way: with no organization selected an
`{ org_id: { _eq: "$org.id" } }` rule matches nothing rather than falling
through to another org's rows.

The array-valued variables (`$user.roles`, `$user.orgs`) can stand in for the
whole right-hand side of `_in` / `_nin`:

```jsonc
{ "org_id": { "_in": "$user.orgs" } }   // every org they belong to
```

An array variable that resolves to nothing makes `_in` match no rows and
`_nin` match all of them — the same reading an explicitly empty list has.

## Permission rows

Each row in `permissions` binds a role to a (collection, action) pair:

```json
{
  "role_id": "<authenticated-role-uuid>",
  "collection": "posts",
  "action": "read",
  "condition": { "$or": [
    { "published": { "_eq": true } },
    { "owner_id":  { "_eq": "$user.id" } }
  ] },
  "fields": ["title", "body", "published", "views"]
}
```

- `collection: "*"` matches every collection.
- `action`: one of `read | create | update | delete | publish`. `publish` gates
  the publish/unpublish/schedule endpoint on [versioned collections](/draft-publish/)
  and lets a caller see drafts; it's separate from `update` so editors can draft
  without going live.
- `condition: null` → no row-level filter (full access).
- `fields: null` → all fields readable/writable. Otherwise allow-list.

## Resolution flow

1. `loadRolesForUser` — fetch the user's roles. Anonymous = `public`;
   any signed-in user gets `authenticated` implicitly.
2. If any role has `admin: true` → bypass all checks.
3. Else find permission rows matching `(role IN roles) AND action AND
   collection IN (slug, '*')`.
4. None found → 403.
5. OR-combine the conditions across matching rows (most permissive
   wins). `null` condition on any matching row = unrestricted.
6. Field allow-list = union of `fields` across matching rows.

The compiled `whereSql` is AND'd with any user-supplied `filter` from
the request, so users can never widen their access via filter.

## `ownerScoped: true` shortcut

When a collection is created with `ownerScoped: true`, the API auto-seeds
four permissions for the `authenticated` role:

| Action | Condition                              |
|--------|----------------------------------------|
| read   | `{ owner_id: { _eq: "$user.id" } }`    |
| create | (none — ownership set by route)        |
| update | `{ owner_id: { _eq: "$user.id" } }`    |
| delete | `{ owner_id: { _eq: "$user.id" } }`    |

These are real permission rows — admin can edit them in `/settings`
afterward.

## System roles

| Role          | Bypass | Auto-assigned                                       |
|---------------|--------|-----------------------------------------------------|
| `admin`       | yes    | First user to sign up                               |
| `authenticated` | no   | Implicit on every signed-in request                 |
| `public`      | no     | Anonymous requests                                  |

System roles cannot be deleted from the admin UI.

### `admin` is workspace-scoped — the instance operator is separate

`admin` is resolved **per workspace**: `tenantMiddleware` recomputes
`auth.roles` from the active workspace on every request, and `POST /api/tenants`
grants `admin` to whoever creates a workspace. It is therefore a self-serve
role, and it deliberately does **not** authorize anything that spans workspaces
or the whole database.

Those surfaces take `requireOperatorMw`
(`services/roles/guards.ts::isInstanceOperator`) instead. The instance operator
is:

- `admin` in the **default/bootstrap workspace** — the first user to sign up is
  seeded there, so existing single-workspace installs are unaffected; **or**
- the address pinned in `OWNER_EMAIL`, when a provisioner set one.

API keys and app-plane end-users are never operators, whatever roles they hold.
Today this gates the raw SQL console and the instance-wide table/migration
inventory (`routes/db-admin.ts`), and acts as the cross-workspace escape hatch
on `/api/tenants/{id}/*`. Backups stay on workspace `admin` — they run against
`auth.tenantId` and `services/backup.ts::TENANT_WHERE` narrows every system
table to that workspace, including the four with no `tenant_id` column of their
own. A backup row with `tenant_id = NULL` is different: that one **is** a full
instance dump, and it is reachable only to the operator.

> **Recovering a lost operator.** Nothing in the API renames or deletes a
> workspace, so the default one is normally permanent. If it was removed by
> hand, `ensureDefaultTenant` recreates an empty `default` that nobody admins
> and the operator-gated routes start returning 403. Set `OWNER_EMAIL` to your
> address to get back in without touching the database.

## Worked example: per-team posts

Two collections, `teams` and `posts` with `team_id` relation field.
Visibility rule: a user reads posts of teams they belong to.

```json
{
  "role_id": "<authenticated>",
  "collection": "posts",
  "action": "read",
  "condition": {
    "team_id": {
      "_in": ["$team_ids"]
    }
  }
}
```

`$team_ids` isn't a built-in variable — for runtime-resolved arrays
you'd use a `condition` that references stable user metadata, or
denormalize `member_team_ids` into the user record. The DSL is
intentionally narrow; complex flows belong in functions.

## Tester / simulator

Granular rules are powerful but hard to debug — *why* can't user X read
`posts`? The **permission simulator** dry-runs the resolver for a subject
against a `(collection, action)` and returns the full reasoning trace, without
touching any data. It's read-only and admin-only, scoped to the active
workspace.

What it returns:

- **decision** — `allowed` + `isAdmin` + a human-readable `reason`.
- **roles** — every role the subject holds in the workspace (with the admin flag).
- **matchedRules** — each `permissions` row that granted the action: which role,
  the normalized `condition`, and the field allow-list.
- **resolvedVars** — the concrete values the DSL variables bound to for this
  subject (`$user.id`, `$user.email`, `$user.roles`, `$tenant.id`, `$now`).
- **whereSql** — the OR-combined `WHERE` clause the REST/GraphQL layers would
  apply, rendered to parametrized SQL (`null` = unrestricted).
- **fields** — the union of allowed fields (`null` = all).
- **rowMatch** — when you pass a `sampleRow`, whether that concrete row would
  pass the combined condition (per-rule and overall).

The subject is either an **existing user** (`userId` — roles read live from the
DB) or an **ad-hoc** one (`roles` by name; with none it's anonymous — the
`public` role). An ad-hoc subject has no `userId`, so `$user.id` resolves to
`null` and an `owner_id _eq $user.id` clause collapses to `1=0` — pass a real
`userId` to see owner-scoped filters compile to a real predicate.

### Surfaces

Admin UI lives under **Roles & permissions → Tester**. Every programmatic
surface mirrors the same call:

```bash
# REST
curl -X POST $API/api/permissions/simulate \
  -H 'content-type: application/json' \
  -d '{ "userId": "<id>", "collection": "posts", "action": "read",
        "sampleRow": { "owner_id": "<id>" } }'

# CLI
backlex permissions simulate --collection posts --action read --user <id>
backlex permissions simulate --collection posts --action read --roles authenticated

# SDK
await client.permissions.simulate({ userId: "<id>", collection: "posts", action: "read" });

# MCP (so Ask AI / agents can answer "why can't user X read posts?")
permissions.simulate { "userId": "<id>", "collection": "posts", "action": "read" }
```

```graphql
query {
  permissionSimulation(collection: "posts", action: "read", userId: "<id>") {
    allowed
    isAdmin
    reason
    matchedRules { roleName condition fields }
    whereSql { sql params }
    fields
  }
}
```
