---
title: Service map
description: A pointer-only inventory of the route + service files behind every major feature, so an agent can find them without grep.
---

This page is a pointer-only inventory. Each line: feature → primary
route / service paths → gotcha or deep-dive pointer. The four major
subsystems (Auth, Realtime, Query API, Hybrid schema) have their own
guides; this list is everything else.

## Data plane

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
  `services/webhooks.ts`) — outbound delivery with HMAC
  `X-Backlex-Signature` + retry. The trigger route is the inbound
  side that flows/functions hook into.
- **Flows** (`routes/flows.ts`, `services/flows.ts`) — visual
  workflow builder. Trigger keys are `event` / `cron` / `webhook` /
  `manual`; operations are a serialized DSL evaluated server-side.
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
- **Advisor** (`routes/advisor.ts`, `services/advisor.ts`) —
  security / performance / config rule checks surfaced in the admin
  UI with fix recommendations. See `docs/advisor.md`.
- **Panels** (`routes/panels.ts`) — dashboard widget definitions.
- **Metrics** (`routes/metrics.ts`) — request / error counters +
  time-series rollups for the admin dashboard.
- **Realtime admin + DB admin** (`routes/realtime-admin.ts`,
  `routes/db-admin.ts`) — subscriber counts + test-publish, and
  schema introspection + diagnostics. Both admin-only.
- **Backup** (`services/backup.ts`) — workspace export/restore
  primitives.

## Cross-cutting helpers worth knowing

- `services/permissions-cache.ts` — per-request L1 cache on top of
  the permissions resolver. Bulk loops hit it for free, no opt-in
  needed.
- `services/cors-origins.ts` — per-tenant allow-list reused by SAML
  relayState validation as the open-redirect guard.
