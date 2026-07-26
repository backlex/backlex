# backlex capability map

A single page that answers: **for every backlex feature, where do I see it?**

The example apps are *frontend* SDK consumers, so they can only exercise the
**consumer-facing** surface (everything the [`backlex`](../packages/client)
client exposes). Many platform capabilities — webhooks, jobs, the functions
sandbox, SSO, backups — are **admin / server-side**: you configure them in the
admin dashboard (or drive them from the CLI / server), and their *effects* show
up through the same data the apps read. This map covers both halves.

Legend — **Where:** `SDK` = callable from an example app · `admin` = configured
in the dashboard · `server`/`CLI` = backend or tooling.

## Shown live in the example apps

| Capability | Where | Demonstrated by | Docs |
|---|---|---|---|
| Workspace auth (end-user sign-up / sign-in / session) | SDK | all three (`AuthForm`) — `auth.signUp/signIn/getSession/signOut` | [auth-planes](../docs/auth-planes.md) |
| Collection CRUD | SDK | all three — `from(c).list/create/update/delete` | [querying](../docs/querying.md) |
| Query API + filtering | SDK | **showcase** & **ecommerce** — fluent `query().where(f=>…).orderBy().limit().withMeta()`; `.toQuery()` → `ListQuery` in **blog** | [querying](../docs/querying.md) |
| Aggregates (count / sum / avg / min / max, `groupBy`) | SDK | **blog** (count by status), **ecommerce** (count + avg price), **showcase** (Aggregates panel) | [querying](../docs/querying.md) |
| Full-text / hybrid / vector search | SDK | **blog** (`search({mode:"fts"})`), **showcase** (Search panel) — `mode` also takes `vector` / `hybrid` | [full-text-search](../docs/full-text-search.md) |
| Realtime (SSE) | SDK | all three — `subscribe("items:<c>", …)`; **showcase** has a live event log | [realtime](../docs/realtime.md) |
| Draft / publish + scheduled publishing | SDK | **blog** & **showcase** — `publish` / `unpublish` / `schedulePublish` + `list({status})` | [draft-publish](../docs/draft-publish.md) |
| File storage + image transforms | SDK | **ecommerce** (product photos: `storage.put` + `download`→objectURL; transform-URL note), **showcase** (Storage panel) | [storage](../docs/storage.md) |
| Batch writes (`createMany` / `updateMany` / `deleteMany` / `batch` / `bulkUpdate`) | SDK | **ecommerce** (checkout writes order lines via `createMany`), **showcase** | [querying](../docs/querying.md) |
| Offline-first sync (changefeed + local store) | SDK | **showcase** (Offline sync panel) — `sync({collection, store: memoryStore()})` → `start/pull/flush/create/update/remove` | [offline-sync](../docs/offline-sync.md) |
| Feature flags + remote config | SDK + admin | **showcase** (Feature flags panel) — `flags.all/isEnabled/get`; flags are defined in the admin | [feature-flags](../docs/feature-flags.md) |
| Permissions (owner-scoped) | SDK + admin | all three — every collection is created **owner-scoped**, so each user sees only their own rows; configured at collection-create | [permissions](../docs/permissions.md) |
| Multi-language (localized) | SDK + admin | **blog** — `title` / `body` are localized; the composer writes a `{ en, tr }` map and the EN/TR switcher re-lists with `list({ locale })` to collapse each field | [locale-timezone](../docs/locale-timezone.md) |
| Push + SMS registration and self-send | SDK | **showcase** (Messaging panel) — `messaging.registerDevice` (real Web Push subscription via `public/sw.js`) / `registerPhone` / `listDevices` / `listPhones` / `sendPush` / `sendSms`; providers are configured in the admin | [push-messaging](../docs/push-messaging.md), [sms-messaging](../docs/sms-messaging.md) |
| Raw REST (no SDK) | HTTP | **showcase** (REST panel) — plain `fetch` to `/api/items/<c>` with a `Bearer` token | [querying](../docs/querying.md) |
| GraphQL API | HTTP | **showcase** (GraphQL panel) — `POST /api/graphql` `{ query, variables }`; schema generated from your collections | [graphql](../docs/graphql.md) |

## Also on the SDK (not built into a panel, but one call away)

| Capability | Call | Docs |
|---|---|---|
| Resumable uploads (TUS) | `storage.uploadResumable({ key, data, onProgress })` | [resumable-uploads](../docs/resumable-uploads.md) |
| Export / import a collection | `from(c).exportItems("csv")` / `importItems(rows)` | [backup-restore](../docs/backup-restore.md) |
| Single-item read with relations | `from(c).one(id, { expand })` | [querying](../docs/querying.md) |
| Outbound webhook signature verify | `verifyWebhook(payload, sig, secret)` | [webhooks](../docs/webhooks.md) |

## Why the SDK's other namespaces aren't in a browser panel

`createClient()` also returns `agents`, `jobs`, `flows`, `forms`, `dashboards`,
`permissions`, `templates`, `schema`, `migrate`, `usage`, `backups`,
`extensions`, and `appUsers`. None of them appear in the example apps, and that
is **deliberate, not a gap**: every one of those routes is guarded by
`requireAdmin` on the server. A workspace end-user — which is what all four
example apps sign in as — gets a `403` from them by construction.

They're reachable from a **server-side** caller holding an admin API key: a
backend route, a script, CI, or a framework loader. `messaging` is the one
exception on this list — it's genuinely end-user scoped (you register *your*
devices and may only send to *yourself*), which is why it has a panel.

[`react-router-app`](./react-router-app) is that server-side caller: React Router
8 in framework mode, where every read and write happens in a loader/action and
the `pak_…` key stays in `process.env`. It covers:

| Capability | Where | Demonstrated by | Docs |
|---|---|---|---|
| Usage metering + quotas | SDK (admin) | **react-router-app** `/` — `usage.overview({ days })`: month totals, per-key traffic, limit breaches | [usage-metering](../docs/usage-metering.md) |
| Durable job queue (retry / DLQ / scheduled) | SDK (admin) | **react-router-app** `/jobs` — `jobs.enqueue` (with `runAt` + `maxAttempts`) / `list` / `retry` / `cancel` / `remove` | [jobs](../docs/jobs.md) |
| Flows (event/cron/manual automation) | SDK (admin) | **react-router-app** `/flows` — `flows.list` / `run(id, input)` / `update(id, { active })` | [flows](../docs/flows.md) |
| AI agents (reason→act loop + tools) | SDK (admin) | **react-router-app** `/agents` — `agents.run(id, message)` with the full tool-call trace | [agents](../docs/agents.md) |
| Permission simulation | SDK (admin) | **react-router-app** `/permissions` — `permissions.simulate(...)`: allow/deny verdict, matched rules, compiled SQL predicate, resolved DSL vars | [permissions](../docs/permissions.md) |

Minting the key: [`docs/api-keys-and-email.md`](../docs/api-keys-and-email.md).

## Admin / server-side capabilities

Configure these in the admin dashboard (`http://localhost:5173`) or via the
CLI / server. They don't need a frontend panel — their effect flows back through
the data and auth the example apps already use. To "use all of them," wire one up
in the admin while an example app is running and watch the behaviour change.

| Capability | Where | How to exercise it against an example | Docs |
|---|---|---|---|
| Granular permissions DSL (conditions, field allow-lists, roles) | admin | Add a role + permission with a `condition` on a collection; the apps' reads/writes get filtered automatically | [permissions](../docs/permissions.md) |
| Outbound webhooks (signing, retry, auto-disable) | admin | Add a webhook on `items.created`; create a row in an app and watch it fire | [webhooks](../docs/webhooks.md) |
| Durable job queue (retry / DLQ / scheduled) | admin / SDK | `jobs` surface + admin queue view | [jobs](../docs/jobs.md) |
| Functions sandbox | admin | Author a function; trigger it on a collection event from an app write | [sandbox](../docs/sandbox.md) |
| Flows (event/cron/manual automation) | admin / SDK | Build a flow (admin flow-builder, `POST /api/flows`, the SDK `client.flows.*`, or GraphQL `createFlow`/`runFlow` — all **admin-scoped**, so from a server/CI client, not an end-user app) triggered by `event:items:<slug>:created` (or cron/manual/webhook); create a row in an example app and watch its operations run (log, notification, email, push, function, item.create/update, request/webhook, condition, delay). **Worked demo:** [blog-react README → "react to new posts with a Flow"](./blog-react/README.md#bonus-react-to-new-posts-with-a-flow-server-side-automation) | [flows](../docs/flows.md) |
| Audit logs + sensitive-read auditing | admin | Every app write is recorded; view under Audit logs | [audit-logs](../docs/audit-logs.md) |
| API keys & access tokens | admin | Mint a key and call the same endpoints the SDK uses | [api-keys-and-email](../docs/api-keys-and-email.md) |
| Backup / restore + per-collection export-import | admin / CLI | `bun backlex` backup/restore; round-trips the apps' data | [backup-restore](../docs/backup-restore.md) |
| Feature flags / remote config (authoring) | admin | Define the flags the **showcase** Flags panel reads | [feature-flags](../docs/feature-flags.md) |
| Advisor rules | admin | Surfaces schema/perf/security advice for the collections you create | [advisor](../docs/advisor.md) |
| SSO (SAML / LDAP) | admin | Configure an IdP for the workspace; end-users sign in via SSO | [sso](../docs/sso.md) |
| Email & OAuth providers | admin | Enable social sign-in / transactional email for the workspace | [api-keys-and-email](../docs/api-keys-and-email.md) |
| Push / SMS provider config | admin | Set FCM/APNs/Twilio creds so `messaging.*` registrations deliver | [push-messaging](../docs/push-messaging.md), [sms-messaging](../docs/sms-messaging.md) |
| Adopting existing tables | admin | Create a collection over a pre-existing physical table | [adopting-tables](../docs/adopting-tables.md) |
| Ask AI | admin | Natural-language queries over your collections in the dashboard | [ask-ai](../docs/ask-ai.md) |

## The example apps at a glance

| App | Port | Focus |
|---|---|---|
| [`todo-react`](./todo-react) | 5174 | The 200-line starter: auth + CRUD + realtime |
| [`blog-react`](./blog-react) | 5175 | Draft/publish, full-text search, aggregates, query builder |
| [`ecommerce-react`](./ecommerce-react) | 5176 | Filter/sort, storage image uploads + transforms, cart, batch order writes |
| [`showcase-react`](./showcase-react) | 5177 | One tab per capability — the broadest SDK sweep |
| [`react-router-app`](./react-router-app) | 5178 | The admin/server plane — jobs, flows, agents, permission simulation, usage |
