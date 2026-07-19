---
title: Playground (demo mode)
description: Run a public, no-signup demo instance — one-click sign-in with published demo credentials, outbound/destructive endpoints blocked, and the whole workspace wiped + reseeded from a template on a timer.
---

Demo mode turns an instance into a **public playground**: visitors sign in with
one click (no signup), poke at a fully seeded workspace, and everything they
did is wiped on a timer. It powers the "try the live playground" funnel on the
website, and works the same on any self-hosted deploy.

## Enabling

Set the env vars and (re)start the instance:

| Var | Meaning |
|---|---|
| `DEMO_MODE` | `1`/`true` turns the playground on. **Never set it on a real instance** — it publishes the admin credentials by design. |
| `SEED_TEMPLATE` | Schema-template id (e.g. `ecommerce`, `blog`, `crm`) the workspace is reseeded from after every wipe. |
| `DEMO_EMAIL` | Demo-admin email shown on the sign-in screen. Default `demo@backlex.com`. |
| `DEMO_PASSWORD` | Demo-admin password (public by design). Default `playground`. |
| `DEMO_RESET_MINUTES` | Minutes between wipes. Default `60`. |

No manual provisioning is needed: on a brand-new database the first cron tick
bootstraps the demo admin, applies `SEED_TEMPLATE`, and the instance is ready.

## What visitors get

- The public auth surface (`GET /api/auth/providers`) carries a `demo:
  { email, password }` field, so the sign-in screen shows a one-click
  **Enter the playground** button.
- The admin shell shows a persistent banner ("shared demo — resets every
  hour") so nobody mistakes it for a private instance.
- The demo account is a normal instance admin: collections, items, flows,
  forms, dashboards, API keys, GraphQL, MCP — all real.

## What's blocked

Writes to endpoints that could send outbound traffic, break the instance, or
lock everyone out of the shared account return `403` ("This action is disabled
in the playground"):

- email / SMS / push **config and sends** (`/api/admin/email-config`,
  `/api/admin/sms-config`, `/api/admin/push-config`, `/api/messaging/*`)
- auth config + SSO (`/api/admin/auth`, `/api/admin/saml`,
  `/api/admin/ldap-config`, `/api/admin/platform-*`)
- external-DB migrations (`/api/admin/migrate`) and raw SQL (`/api/admin/db`)
- demo-account takeover (`/api/auth/change-password`, `change-email`,
  `delete-user`, `two-factor`)

Reads on all of those prefixes stay open so the admin pages render. The block
list lives in `apps/web/src/server/services/demo.ts` (`isDemoBlockedRequest`).
For abuse control beyond the guard, the usual knobs apply: `API_RATE_LIMIT_*`
and `USAGE_LIMIT_*`.

## The reset

`resetDemoWorkspace` (driven by the scheduler; also `POST /api/admin/demo/reset`
for a manual wipe) converges the instance back to its seeded state:

1. drops every managed collection's physical table + all collection metadata,
2. best-effort deletes stored file objects, then truncates every visitor-state
   system table (flows, webhooks, api keys, app users, forms, dashboards,
   settings, …),
3. deletes every workspace except the default one and every user except the
   demo admin — recreating the admin with the published password if a visitor
   changed or deleted it,
4. re-applies `SEED_TEMPLATE` (collections, sample rows, roles, dashboards).

The last-reset timestamp is persisted in `app_settings`, so the cadence
survives isolate restarts; each isolate re-checks it at most every 5 minutes.
Visitors signed in when the wipe lands keep their cookie but the shared
account's state resets under them — by design.

## Ops notes

- The playground is just a normal deploy (Workers, Bun, Vercel, Netlify) with
  the env vars above — nothing else is special about it.
- Storage blobs whose metadata rows were wiped past the per-reset cleanup cap
  (1000 objects) are orphaned; point the playground at a dedicated bucket.
- Tests: `apps/web/tests/demo-mode.test.ts`.
