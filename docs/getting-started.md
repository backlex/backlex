# Getting started

Five minutes from clone to first item.

## Prerequisites

- Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Optional: Postgres 14+ for production. Dev defaults to Bun's built-in SQLite.

## Install + run

```bash
git clone https://github.com/your/workeros && cd workeros
bun install
cp apps/api/.env.example apps/api/.env

# Apply migrations to local SQLite
bun run workeros migrate

# Start API (8787) + admin UI (5173) in parallel
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
curl http://localhost:8787/api/items/posts?limit=10 \
  --cookie "$(cat /tmp/cookie.txt)"

# REST with filter (DSL — same as permissions)
curl "http://localhost:8787/api/items/posts?filter=$(echo '{"published":{"_eq":true},"views":{"_gt":10}}' | jq -sRr @uri)&sort=-views"

# GraphQL
curl -X POST http://localhost:8787/api/graphql \
  -H "content-type: application/json" \
  -d '{"query":"{ posts(sort:\"-views\", limit:5) { id title views } }"}'
```

## Generate types for your client

```bash
bun run workeros gen-types http://localhost:8787 --out src/types.ts
```

The CLI fetches `/api/collections` and emits one TypeScript interface per
collection plus a `Collections` registry. Use with `@workeros/client`:

```ts
import { createClient } from "@workeros/client";
import type { Posts } from "./types";

const wks = createClient({ url: "http://localhost:8787" });
const r = await wks.from<Posts>("posts").list({
  filter: { published: { _eq: true } },
  sort: "-views",
  limit: 10,
});
```

## What next

- [Permissions DSL](permissions.md) — granular role + condition rules
- [Functions](functions.md) — JavaScript code that runs in a sandbox
- [Deployment](deployment.md) — push to Bun, Workers, Vercel, or Netlify
