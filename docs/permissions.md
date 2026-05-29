---
title: Permissions DSL
description: JSON permission language shared by REST, GraphQL, realtime filters, and DB persistence.
---

backlex has its own JSON permission language. Same DSL is used for:

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

## Variables

Resolved against the request's auth subject:

- `$user.id` — current user's id (null when anonymous)
- `$user.email`
- `$user.roles` — array of role names
- `$tenant.id` (aka `$user.tenant_id`) — active workspace id
- `$now` — `Date.now()`

`$user.id` resolving to null short-circuits comparison ops to false, so
anonymous users never accidentally match `{ owner_id: { _eq: "$user.id" } }`.

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
- `action`: one of `read | create | update | delete`.
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
