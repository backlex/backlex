---
title: Getting started
description: Clone, install, run — five minutes from zero to your first collection.
---

Five minutes from clone to first item.

## Prerequisites

- Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`) — the dev toolchain
  (workspaces, scripts, `bun run dev`) runs on Bun.
- Optional: Postgres 14+ for production. Dev defaults to Bun's built-in SQLite.

> Bun is only required for local development. The same source **runs** on
> Bun, Node, Deno, Cloudflare Workers, Vercel, and Netlify — see
> [Deployment](/docs/deployment/) for the Node and Deno self-host steps.

## Install + run

```bash
git clone https://github.com/backlex/backlex && cd backlex
bun install
cp apps/web/.dev.vars.example apps/web/.dev.vars

# Apply migrations to local SQLite
bun run db:migrate:sqlite

# Start Vite + Cloudflare miniflare in one process on :5173
# (admin SPA + Worker bundled — no separate API port, no proxy)
bun run dev
```

Open `http://localhost:5173/sign-up` and create the first user — they
auto-receive the `admin` role. Subsequent sign-ups get `authenticated`.

## Your first collection

In the admin UI, go to **Collections → New** and define:

```
slug: posts
fields:
  - title (text, required)
  - body (longtext)
  - published (boolean)
  - views (integer)
ownerScoped: true
```

Click **Create**. The API runs `CREATE TABLE c_posts (...)` against the
live database — no redeploy.

## Your first items

Click on `posts` in the list, then **+ New item**. Type-aware inputs
render based on field type (textarea for longtext, checkbox for boolean,
number input for views). Save.

The owner-scoped flag auto-seeds permissions for the `authenticated`
role: each user only reads/writes their own items. Admin sees all.

## Query

```bash
# REST
curl http://localhost:5173/api/items/posts?limit=10 \
  --cookie "$(cat /tmp/cookie.txt)"

# REST with filter (DSL — same as permissions)
curl "http://localhost:5173/api/items/posts?filter=$(echo '{"published":{"_eq":true},"views":{"_gt":10}}' | jq -sRr @uri)&sort=-views"

# GraphQL
curl -X POST http://localhost:5173/api/graphql \
  -H "content-type: application/json" \
  -d '{"query":"{ posts(sort:\"-views\", limit:5) { id title views } }"}'
```

## Generate types for your client

```bash
bun run backlex gen-types http://localhost:5173 --out src/types.ts
```

The CLI fetches `/api/collections` and emits one TypeScript interface per
collection plus a `Collections` registry. Use with `@backlex/client`:

```ts
import { createClient } from "@backlex/client";
import type { Posts } from "./types";

const wks = createClient({ url: "http://localhost:5173" });
const r = await wks.from<Posts>("posts").list({
  filter: { published: { _eq: true } },
  sort: "-views",
  limit: 10,
});
```

## Deploy

One-click deploy clones the repo into your own Git account and ships it —
`vercel.ts` (Build Output API) and `netlify.toml` are already in the repo,
so no extra config is needed:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/backlex/backlex&env=APP_URL,AUTH_SECRET,DATABASE_URL,DATABASE_DRIVER,S3_BUCKET,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY,CRON_SECRET&envDescription=Backlex%20runtime%20secrets%20(Postgres%2C%20S3%2C%20auth)&envLink=https://github.com/backlex/backlex/blob/main/docs/deployment.md)
&nbsp;
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/backlex/backlex)

After the clone you still set the runtime env vars — backlex needs a
Postgres URL (`DATABASE_DRIVER=neon-http`), S3-compatible storage, and
`AUTH_SECRET`. Full per-platform steps + every variable:
[Deployment](/docs/deployment/) — also covers Bun, Node, Deno, and
Cloudflare Workers.

**[Deno Deploy](/docs/deployment/#deno-deploy-managed)** is also supported
(managed, experimental). There's no one-click button — it ships via the
`deno deploy` CLI or a dashboard Git link rather than a clone URL — but the
same source runs on it (verified live), with `neon-http` + Upstash forced
automatically.

## What next

- [Permissions DSL](/docs/permissions/) — granular role + condition rules
- [Auth planes](/docs/auth-planes/) — admin pool vs workspace end-user pool
- [Sandbox functions](/docs/sandbox/) — JavaScript code that runs in a sandbox
- [MCP server](/docs/mcp/) — expose the workspace to Claude Desktop / Cursor / IDE agents
- [Deployment](/docs/deployment/) — push to Bun, Workers, Vercel, or Netlify
- [Testing](/docs/testing/) — three-layer pyramid (bun test / build-targets / runtime-smoke)
