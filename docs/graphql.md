---
title: GraphQL
description: graphql-yoga endpoint with a schema generated on the fly from your collection metadata.
---

# GraphQL

`/api/graphql` exposes a `graphql-yoga` endpoint with a schema generated
on the fly from your collection metadata.

## Schema generation

For every collection `<slug>`:

```graphql
type <Slug> {
  id: ID!
  createdAt: String!
  updatedAt: String!
  ownerId: String           # only when ownerScoped
  # one field per collection field, mapped:
  #   text/longtext/uuid/timestamp → String
  #   integer → Int
  #   number  → Float
  #   boolean → Boolean
  #   json    → JSON         (custom scalar)
  #   relation → <Target>     (object type — see Relations)
}

input <Slug>Input {
  # same shape, all optional, relation fields as ID
}

type Query {
  <slug>(filter: JSON, sort: String, limit: Int, offset: Int): [<Slug>!]!
  <singular>(id: ID!): <Slug>
}

type Mutation {
  create<Slug>(data: <Slug>Input!): <Slug>!
  update<Slug>(id: ID!, data: <Slug>Input!): <Slug>!
  delete<Slug>(id: ID!): Boolean!
}
```

The schema is rebuilt only when collection metadata changes (cache key
is a hash of all collection definitions).

## Filter

The `filter` argument is the same JSON DSL as REST. Pass it as a GraphQL
variable — JSON literals aren't supported inline.

```graphql
query GetPublished($f: JSON!) {
  posts(filter: $f, sort: "-views", limit: 10) {
    id
    title
    views
  }
}
```

```json
{
  "f": {
    "$or": [
      { "owner_id": { "_eq": "$user.id" } },
      { "published": { "_eq": true } }
    ]
  }
}
```

## Relations

Fields with type `relation` and `to: <slug>` render as the target
collection's GraphQL type, not the raw id. Resolution is per-row (N+1
in v1; DataLoader batching is on the v2 list).

```graphql
{
  comments {
    id
    text
    post {
      id
      title
    }
  }
}
```

The stored value is the foreign id (TEXT column). The GraphQL resolver
fetches the related row through the same permission pipeline — if the
caller can't read the target row, the field is `null`, not an error.

## Mutations

```graphql
mutation Publish($id: ID!) {
  updatePosts(id: $id, data: { published: true }) {
    id
    title
    published
  }
}
```

Mutations publish realtime + webhook + flow events the same way REST does.

## Permissions

Resolvers go through the same `resolvePermission` REST does:

- Query: `read` action on the collection.
- Mutations: `create`/`update`/`delete` action.
- Field allow-list narrows what the caller can read/write — fields
  outside it return GraphQL errors with `code: "FORBIDDEN"`.

Filter fields are also validated against the allow-list — users can't
probe restricted fields via filters.

## Authentication

GraphQL uses the same session middleware as REST: cookie session
(better-auth) or `Authorization: Bearer pak_…` API key. Both work.

## What's not in the schema

- **Subscriptions** — use `/api/realtime/items:<slug>/subscribe` (SSE/WS)
  for the change feed. GraphQL subscriptions over WS are on the v3 list.
- **Aggregates** — count is via REST `meta=filter_count`. GraphQL-side
  aggregations defer to v2.
- **Custom scalars beyond `JSON`** — timestamps are ISO strings in `String`.

## Inspecting

GraphiQL ships at `/api/graphql` when accessed from a browser (no
landing page, but the IDE renders on GET with `accept: text/html`).
Use `__schema { ... }` for full introspection from any client.
