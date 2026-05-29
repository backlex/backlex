---
title: Getting started
description: Clone, install, run — five minutes from zero to your first collection.
---

Five minutes from clone to first item.

## Prerequisites

- Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Optional: Postgres 14+ for production. Dev defaults to Bun's built-in SQLite.

## Install + run

```bash
git clone https://github.com/your/backlex && cd backlex
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

## What next

- [Permissions DSL](permissions.md) — granular role + condition rules
- [Auth planes](auth-planes.md) — admin pool vs workspace end-user pool
- [Sandbox functions](sandbox.md) — JavaScript code that runs in a sandbox
- [MCP server](mcp.md) — expose the workspace to Claude Desktop / Cursor / IDE agents
- [Deployment](deployment.md) — push to Bun, Workers, Vercel, or Netlify
- [Testing](testing.md) — three-layer pyramid (bun test / build-targets / runtime-smoke)
