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
collection's GraphQL type, not the raw id. Resolution is **batched** per
request: a query that returns N parents fires one `WHERE id IN (…)` per
target collection, not N single-row lookups — so `{ comments { post { … } } }`
costs one extra round-trip regardless of how many comments come back. The
loader applies the same read-permission, tenant, row-level, soft-delete, and
draft gates as a direct fetch, and dedupes repeated foreign keys within the
request. `relation_many` still returns the raw id array (its targets aren't
batched yet).

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

## Subscriptions (SSE)

`POST /api/graphql/stream` (or GET with `?query=…&variables=…`) opens a
[graphql-sse](https://github.com/enisdenjo/graphql-sse)
distinct-connections-mode stream — one SSE connection per operation:

```graphql
subscription {
  items(collection: "posts", filter: { published: { _eq: true } }) {
    event  # created | updated | deleted
    data   # the row, projected to your read allow-list
  }
}
```

Events arrive as `event: next` frames with `{ "data": { "items": … } }`
envelopes; the stream ends with `event: complete`. Aliases work
(`subscription { posts: items(...) { event } }`), field selection projects
the payload, and `filter` is the same live-query condition DSL the realtime
`?filter=` accepts (validated against your readable fields).

Under the hood the operation maps onto the realtime layer's
`items:<slug>` channel, so permissions, draft gating, transports
(Workers Durable Object / Redis long-poll on serverless / in-process on
Bun) and `Last-Event-ID` resume behave exactly like
[`/api/realtime`](realtime.md). On the serverless long-poll transport the
stream closes after each delivered batch — reconnect with the last seen
`id` to resume, which graphql-sse clients do automatically.

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

## Admin twins (webhooks / i18n / storage / backups)

Beyond collections, the schema carries static admin-scoped fields mirroring
their REST routes through the same service layer (gate:
`admin-graphql-parity.test.ts`, `backup-surfaces.test.ts`):

- **Webhooks** — `webhooks`, `webhookDeliveries(webhookId, limit)`;
  `createWebhook(data)`, `updateWebhook(id, data)`, `deleteWebhook(id)`,
  `testWebhook(id)`, `retryWebhookDelivery(id)`.
- **i18n** — `i18nStrings`, `i18nMatrix`; `setI18nString(data)`,
  `setI18nStrings(data)`, `deleteI18nString(id)`.
- **Storage (metadata plane)** — `files(prefix, folderId, search, limit,
  offset)`; `updateFile(key, data)`, `deleteFile(key)`. These ride the
  `system_files` permission DSL rows (row-level `whereSql` included) exactly
  like REST. Upload/download/transform stay REST-only (byte streams).
- **Backups** — `backups`, `backupConfig`; `runBackup(label)`,
  `restoreBackup(id, confirm: true)`, `setBackupConfig(data)`.

## What's not in the schema

- **Subscriptions over WebSocket** — subscriptions ship over SSE (see
  above); a WS transport is not planned while SSE covers all runtimes.
- **Aggregates** — count is via REST `meta=filter_count`. GraphQL-side
  aggregations defer to v2.
- **Custom scalars beyond `JSON`** — timestamps are ISO strings in `String`.
- **File byte streams** — upload/download/transform are REST-only; GraphQL
  covers the file *metadata* plane (see Admin twins above).

## Inspecting

GraphiQL ships at `/api/graphql` when accessed from a browser (no
landing page, but the IDE renders on GET with `accept: text/html`).
Use `__schema { ... }` for full introspection from any client.
