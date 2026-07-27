---
title: Service map
description: A pointer-only inventory of the route + service files behind every major feature, so an agent can find them without grep.
---

This page is a pointer-only inventory. Each line: feature → primary
route / service paths → gotcha or deep-dive pointer. The four major
subsystems (Auth, Realtime, Query API, Hybrid schema) have their own
guides; this list is everything else.

## Data plane

- **Full-text & hybrid search** (`services/fts.ts`, DDL in
  `packages/db/schema-applier.ts::ensureFtsObjects`) — keyword index
  maintained by the item-write hooks (`services/items/write.ts`); the
  `POST /:slug/search` route + `?q=` upgrade live in `routes/items.ts`,
  the backfill in `routes/collections.ts`. Hybrid fuses FTS + vector with
  RRF. Managed collections only. Deep dive: `docs/full-text-search.md`.
- **Revisions** (`routes/revisions.ts`, `services/revisions.ts`) —
  change history per item. `routes/items.ts` already snapshots
  before mutating, don't double-write.
- **Comments** (`routes/comments.ts`) — item-scoped threads,
  permission-checked via the parent collection (no separate
  permission row).
- **Activity log** (`routes/activity.ts`, `services/activity.ts`) —
  central audit trail. Mutating routes call `logActivity(...)` after
  success. Add it when introducing new write endpoints.
- **Storage + folders** (`routes/storage.ts`, `routes/folders.ts`,
  `services/storage/*`) — uploads, folder tree, signed serves,
  on-the-fly image transforms. See `docs/storage.md`.

## Query surfaces

- **GraphQL** (`routes/graphql.ts`, `routes/graphql.openapi.ts`,
  `services/graphql.ts`) — schema auto-generated from collections.
  Uses the L1 permission cache so deep queries don't N+1 the
  resolver. See `docs/graphql.md`.
- **OpenAPI** (`routes/openapi.ts`, `routes/openapi-metadata.ts`,
  `services/openapi-dynamic.ts`) — spec generated dynamically from
  collection schemas + per-route `.openapi(...)` decorators
  (`@hono/zod-openapi`); a new route shows up automatically if you
  decorate it.
- **Public surfaces** (`routes/i18n-public.ts`,
  `routes/shared-public.ts`, `routes/shared-links.ts`,
  `services/shared-links.ts`) — unauthenticated endpoints used by
  signed share-link URLs and the public i18n bundle. Never apply
  `requirePermission` here; gate via the share-link token instead.
- **i18n strings** (`routes/i18n.ts`, `services/i18n.ts`,
  `services/i18n-translate.ts`) — content-translation system
  (multilingual values for user-managed collections), distinct from
  the admin SPA's Lingui chrome translations.

## Automation

- **Webhooks** (`routes/webhooks.ts`, `routes/webhook-trigger.ts`,
  `services/webhooks.ts`) — outbound delivery with retry. Each delivery is
  signed three ways: legacy `X-Backlex-Signature` (HMAC of body) plus the
  replay-safe `X-Backlex-Signature-V2` over `{timestamp}.{body}` with
  `X-Backlex-Timestamp`. `applyDeliveryOutcome` is the auto-disable circuit
  breaker (15 consecutive failures → `active=false` + `disabled_reason` +
  broadcast notification; reset on success or manual resume). SDK receiver
  helper: `verifyWebhook` from `backlex/webhook`. The trigger route is
  the inbound side that flows/functions hook into. See `docs/webhooks.md`.
- **Flows** (`routes/flows.ts`, `services/flows.ts`) — visual
  workflow builder. Trigger keys are `event` / `cron` / `webhook` /
  `manual`; operations are a serialized DSL evaluated server-side.
  Admin-scoped CRUD + run is mirrored across REST, the SDK
  (`client.flows.*`), GraphQL (`runFlow` et al.), MCP (`flows.*`), and the
  CLI. See `docs/flows.md`.
- **AI agents + chat rooms** (`routes/agents.ts`,
  `services/agents/{store,runner,memory,mentions,send,async-run}.ts`)
  — reason→act AI agents over the MCP tool registry. An agent definition, plus
  **rooms** (`agent_threads`) that host several agents at once, their membership
  (`agent_thread_agents`), and one `agent_runs` row per turn — which is also the
  per-agent lock, so two agents answer in parallel but one can't run twice.
  - `send.ts` is the single entry point every surface funnels through: it
    persists the message once, then decides who answers.
  - `mentions.ts` resolves `@handle`s and the room's routing mode
    (`mention` / `default` / `auto`). Only user messages route, so agents can't
    trigger each other.
  - `runner.ts` executes one agent's turn, calling allow-listed tools through an
    identity-carrying in-process sub-fetch and streaming steps over
    `agent:thread:<id>`.
  - `async-run.ts` is the background path (`{"async": true}`): an `agent.turn`
    job enqueued with `maxAttempts: 1`, started inline via `waitUntil`, with a
    `queued`-only status guard so a non-idempotent turn is never replayed.
    Detached tool calls authenticate with a short-lived agent-run token
    (`lib/jwt.ts`) that carries no roles.
  - Optional per-(thread, agent) vector memory in `memory.ts`.

  Admin-scoped CRUD + rooms + run are mirrored across REST, the SDK
  (`client.agents.*`), GraphQL (`runAgent` et al.), MCP (`agents.*`), and the
  CLI. Admin UI: `pages/agents.tsx` (definitions) + `pages/chat.tsx` (rooms),
  sharing `pages/_agents-shared.tsx`. See `docs/agents.md`.
- **Functions** (`routes/functions.ts`, `services/functions.ts`,
  `services/sandbox/*`, `routes/sandbox-rpc.ts`) — sandboxed JS
  execution. Provider picked by runtime: QuickJS on Workers, Bun
  Worker on self-host, optional HTTP executor. The sandbox calls
  back into the host (e.g. `email.send`, `db.query`) through
  `sandbox-rpc.ts` — RPC surface, not direct imports. See
  `docs/sandbox.md`.
- **Scheduler** (`services/scheduler.ts`,
  `services/scheduled-tasks.ts`) — cron expression parsing +
  delayed-task ledger. Driven by the `scheduled` Worker entry and
  the Vercel/Netlify cron routes.
- **Job queue** (`routes/jobs.ts`, `services/jobs.ts`) — durable
  background jobs (`function` / `webhook.deliver`) with exponential
  backoff, dead-letter, and `runAt` scheduling. `processJobs` drains
  the `jobs` table inside the same `cronTick`; webhook dispatch
  enqueues here for retry. See `docs/jobs.md`.
- **Resumable uploads** (`routes/uploads.ts`, `services/uploads.ts`)
  — TUS 1.0.0 chunked uploads at `/api/uploads`, backed by native
  object-store multipart (R2/S3) or fs offset-append. The `uploads`
  table tracks session offset + parts; `sweepExpiredUploads` aborts
  stale sessions inside `cronTick`. See `docs/resumable-uploads.md`.
- **Offline sync** (`routes/items/changes.ts` + `/revisions`,
  `services/items/changefeed.ts`, `services/items/shape.ts`,
  `packages/client/src/sync.ts`) — incremental changefeed (keyset on
  `updated_at,id`, tombstones via `_deleted`) + revisions endpoint.
  `runChangefeed` is the ONE implementation behind REST, the SDK,
  `<collection>Changes` (GraphQL), `collections.changes` (MCP) and
  `backlex items changes` (CLI). A `shape` (flat filter) replicates a subset;
  rows leaving it come back as `{ id, _shape_exit: true }` — computed as a
  SELECT-list expression, not a WHERE clause, so move-outs stay observable.
  The client `sync` module pulls into a pluggable local store (memory /
  IndexedDB / SQLite), stays live over SSE with local shape matching, and
  queues offline writes with a configurable conflict policy (LWW by default;
  `server-wins` / `client-wins` / `merge` / `manual` send a per-op
  `ifUnmodifiedSince` precondition through the batch endpoint). Soft-delete
  bumps `updated_at` so deletes reach the feed. See `docs/offline-sync.md`.
- **Feature flags** (`routes/feature-flags.ts`, `services/feature-flags.ts`)
  — per-workspace/global flags + remote config in the `feature_flags` table;
  `evaluateFlags` resolves rollout % + permission-DSL targeting per caller;
  public read at `/api/flags`, admin CRUD at `/api/admin/feature-flags`. See
  `docs/feature-flags.md`.
- **Draft / publish** (`routes/items.ts` publish handler,
  `services/items/scheduled-publish.ts`, `draftFilter` in
  `services/items/sql-helpers.ts`) — versioned collections get
  `_status`/`_published_at`/`_publish_at`; reads hide drafts from
  callers without the `publish`/`update` permission; `publishDueItems`
  applies scheduled publishes inside `cronTick`. See `docs/draft-publish.md`.
- **Notifications** (`routes/notifications.ts`) — in-app
  notification feed; activity/flows write into it.
- **Email templates** (`routes/email-templates.ts`) — per-tenant
  overrides for transactional templates; pairs with the
  per-workspace email config in `docs/api-keys-and-email.md`.

## Workspace admin

- **App users + tenants** (`routes/app-users.ts`,
  `routes/tenants.ts`, `routes/tenant-auth.ts`) — multi-tenant
  end-user pool (distinct from the control-plane admin pool):
  invite flow, tenant switching, per-tenant sign-in routes.
- **Settings + workspace config** (`routes/settings.ts`,
  `services/settings.ts`, `routes/workspace-config.ts`,
  `services/workspace-config.ts`) — `settings` is the `app_settings`
  whitelist (i18n defaults, timezone, …); `workspace-config` is
  per-tenant overrides for runtime knobs.
- **Roles admin + collection rename** (`routes/roles.ts`,
  `services/collection-rename.ts`) — roles admin is the editor for
  the permission DSL. `collection-rename` is the only safe path to
  rename a collection (renames the physical table + updates
  permission rows in one transaction).
- **Advisor** (`routes/advisor.ts`, `services/advisor.ts`,
  `services/advisor-insights.ts`) — security / performance / config rule
  checks surfaced in the admin UI with fix recommendations. Performance
  covers both static schema-derived rules and traffic-derived ones computed
  from recorded spans; `POST /apply` carries out a finding's remediation by
  re-deriving the statement server-side. See `docs/advisor.md`.
- **Panels** (`routes/panels.ts`) — dashboard widget definitions.
- **Metrics** (`routes/metrics.ts`) — request / error counters +
  time-series rollups for the admin dashboard.
- **Realtime admin + DB admin** (`routes/realtime-admin.ts`,
  `routes/db-admin.ts`) — subscriber counts + test-publish, and
  schema introspection + diagnostics. Both admin-only.
- **Backup / restore** (`services/backup.ts`) — logical JSONL dumps
  (`runBackup`), additive `restoreBackup` (`ON CONFLICT DO NOTHING`,
  recreates missing `c_*` tables), and the scheduled-backup sweep +
  retention (`maybeRunScheduledBackups`, hooked into `services/scheduler.ts`).
  Routes in `routes/db-admin.ts`: `/backups`, `/backups/now`,
  `/backups/{id}/download`, `/backups/{id}/restore` (confirm-gated),
  `/backups/config` (GET/PUT schedule). See `docs/backup-restore.md`.
- **Per-collection export / import** (`routes/items.ts` +
  `services/items/csv.ts`) — `GET /:slug/export?format=json|csv` (reuses the
  list read-filter stack) and `POST /:slug/import` (per-row `performCreate`,
  system columns stripped, errors captured). SDK `exportItems`/`importItems`.
- **External-DB migration** (`routes/migrate.ts` + `services/migrate.ts` +
  `services/migrate-ingest.ts`) — `POST /api/admin/migrate/ingest/:slug`
  (bulk, PK-preserving, idempotent, side-effect-free row copy; D1
  param-budget chunking; the CLI pump's write path) + the server-side
  connector: `/sources` CRUD (URL encrypted at rest + SSRF guard),
  `/sources/:id/tables|plan`, `/runs` lifecycle. Runs advance on the
  scheduler tick in lease-reclaimed, cursor-resumable slices. Full parity:
  SDK `client.migrate.*`, GraphQL `migrate*`, MCP `migrate.*`, CLI
  `backlex import-db`, admin **Data → Database import**. See
  `docs/migrating-in.md`.

## Cross-cutting helpers worth knowing

- `services/permissions-cache.ts` — per-request L1 cache on top of
  the permissions resolver. Bulk loops hit it for free, no opt-in
  needed.
- `services/cors-origins.ts` — per-tenant allow-list reused by SAML
  relayState validation as the open-redirect guard.
