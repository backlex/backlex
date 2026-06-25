---
title: GraphQL
description: graphql-yoga endpoint with a schema generated on the fly from your collection metadata.
---

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
  batch<Slug>(operations: [JSON!]!, atomic: Boolean): BatchResult!
  bulkUpdate<Slug>(keys: [String!]!, data: JSON!): BulkUpdateResult!
}

type BatchResult {
  atomic: Boolean!
  total: Int!
  succeeded: Int!
  failed: Int!
  results: [JSON!]!   # { index, op, ok, id?, data?, error? } per operation
}

type BulkUpdateResult {
  total: Int!
  updated: Int!
  failed: Int!
  results: [JSON!]!   # { id, ok, error? } per key
}
```

`batch<Slug>` mirrors the REST `…/batch` endpoint: each operation is a JSON
`{ op: "create"|"update"|"delete", id?, data? }`. Pass operations **as a
variable** (the `JSON` scalar rejects inline literals). `atomic: true` runs the
whole set all-or-nothing — see the [Batch & transactional writes](/querying/#batch--transactional-writes)
runtime matrix; an atomic failure surfaces as a GraphQL error and commits
nothing.

```graphql
mutation Bulk($ops: [JSON!]!) {
  batchPosts(operations: $ops, atomic: true) { succeeded failed results }
}
# variables: { "ops": [ { "op": "create", "data": { "title": "A" } },
#                       { "op": "delete", "id": "p2" } ] }
```

`bulkUpdate<Slug>` mirrors the REST `…/bulk-update` endpoint: one shared `data`
patch applied to every id in `keys` (only the named fields change). It is
partial-success — a key the caller can't write is reported `NOT_FOUND` in
`failed`. See [Bulk-update a selection](/querying/#bulk-update-a-selection).

```graphql
mutation BulkSet($keys: [String!]!, $data: JSON!) {
  bulkUpdatePosts(keys: $keys, data: $data) { total updated failed results }
}
# variables: { "keys": ["p1","p2","p3"], "data": { "status": "archived" } }
```

The schema is rebuilt only when collection metadata changes (cache key
is a hash of all collection definitions).

## Flows

Visual workflows ([flows](/flows/)) are exposed as **static** query/mutation
fields — they don't vary with collection schema, so they're present on every
workspace's schema (even one with zero collections). The surface mirrors REST
`/api/flows` and the MCP `flows.*` tools one-to-one, and is **admin-only**: a
non-admin caller gets a `FORBIDDEN` error rather than a silent empty list.

```graphql
type Flow {
  id: ID!
  tenantId: String
  name: String!
  trigger: String!
  operations: JSON!   # serialized op DSL
  layout: JSON        # presentational builder graph
  active: Boolean!
}

input FlowInput {
  name: String
  trigger: String
  operations: JSON
  layout: JSON
  active: Boolean
}

type FlowRunResult { ok: Boolean!  error: String }

type Query {
  flows: [Flow!]!
  flow(id: ID!): Flow
}

type Mutation {
  createFlow(data: FlowInput!): Flow      # operations must be non-empty
  updateFlow(id: ID!, data: FlowInput!): Flow
  deleteFlow(id: ID!): Boolean!
  runFlow(id: ID!, input: JSON): FlowRunResult!   # synchronous manual trigger
}
```

`runFlow` mirrors REST `…/{id}/run`: `input` is passed as the flow's trigger
payload and the run is executed synchronously. A paused (`active: false`) flow
returns `{ ok: false, error: "flow is paused" }`.

```graphql
mutation Run($id: ID!, $input: JSON) {
  runFlow(id: $id, input: $input) { ok error }
}
# variables: { "id": "flw_…", "input": { "hello": "world" } }
```

## Schema templates

Like flows, the schema-template catalog is a **static, admin-only** surface
present on every workspace schema. It mirrors REST `/api/admin/templates`, the
MCP `templates.*` tools, and the SDK `client.templates.*` namespace. `templates`
lists the catalog; `applyTemplate` seeds a vertical's collections **and** sample
data into the active workspace (idempotent — collections that already exist are
skipped, and `seeded` counts the example rows inserted).

```graphql
type TemplateCollectionSummary { slug: String!  label: String!  fieldCount: Int! }

type TemplateSummary {
  id: ID!
  label: String!
  description: String!
  category: String!
  recommended: Boolean!
  sampleRows: Int!
  collections: [TemplateCollectionSummary!]!
}

type ApplyTemplateResult {
  templateId: String!
  created: [String!]!   # collections materialized this call
  skipped: [String!]!   # already existed
  seeded: Int!          # sample rows inserted
}

type Query {
  templates: [TemplateSummary!]!
}

type Mutation {
  applyTemplate(templateId: String!): ApplyTemplateResult!   # unknown id → VALIDATION
}
```

## Draft / published

For [versioned collections](/draft-publish/) GraphQL applies the same
published-only default as REST: callers without `publish`/`update` permission
see only published rows on both `<slug>(...)` and `<slug>ById(...)`. Privileged
callers see all and can still narrow with a `_status` filter.

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
