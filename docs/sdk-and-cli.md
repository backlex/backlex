---
title: SDK & CLI
description: The @workeros/client typed fetch wrapper and the workeros CLI for project scaffolding.
---

Two packages ship for client-side and developer-side use.

## `@workeros/client`

Typed fetch wrapper, browser + Node.

```ts
import { createClient } from "@workeros/client";

const wks = createClient({
  url: "https://api.your.app",
  // For server-to-server / CI; browser apps use the cookie session and skip:
  apiKey: process.env.WORKEROS_API_KEY,
});

// CRUD
const list = await wks.from<Posts>("posts").list({
  filter: { published: { _eq: true } },
  sort: ["-views", "title"],
  fields: ["id", "title", "views"],
  limit: 25,
  offset: 0,
  meta: "filter_count",
});
const one = await wks.from<Posts>("posts").one("uuid");
const created = await wks.from<Posts>("posts").create({ title: "hi" });
const updated = await wks.from<Posts>("posts").update("uuid", { views: 42 });
await wks.from<Posts>("posts").delete("uuid");

// Realtime (SSE)
const off = wks.subscribe<Posts>("items:posts", (e) => {
  console.log(e.event, e.data); // created | updated | deleted
});
// later:
off();

// Auth
await wks.auth.signUp({ email, password, name });
await wks.auth.signIn({ email, password });
await wks.auth.signOut();
const session = await wks.auth.session();

// Storage
await wks.storage.put("avatars/me.png", file, "image/png");
const res = await wks.storage.download("avatars/me.png");
const blob = await res.blob();
await wks.storage.list("avatars/");
await wks.storage.delete("avatars/me.png");
```

### Errors

Failed requests throw `WorkerosError`:

```ts
import { WorkerosError } from "@workeros/client";
try {
  await wks.from("posts").create({});
} catch (e) {
  if (e instanceof WorkerosError) {
    e.status   // 422
    e.code     // "VALIDATION"
    e.message  // 'Field "title" is required'
    e.details  // raw response payload
  }
}
```

### Type generation

Pair the SDK with auto-generated types so `wks.from<Posts>("posts")` is
type-safe:

```bash
bun run workeros gen-types https://api.your.app --out src/workeros-types.ts
# Or with API key:
bun run workeros gen-types https://api.your.app --key pak_xxx --out src/workeros-types.ts
```

Output:

```ts
export interface Posts {
  id: string;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  title: string;
  body: string | null;
  published: boolean | null;
  views: number | null;
}
// + 1 interface per collection
export interface Collections {
  posts: Posts;
  // ...
}
```

## `workeros` CLI

Run from any project that has `@workeros/cli` (root has it as
`bun run workeros ...`).

```
workeros help
workeros migrate [db-path]                      apply SQLite migrations
workeros gen-types <api-url> [--out <file>] [--key <pak_...>]
                                                 generate TS types
```

### `workeros migrate`

Applies the same Drizzle migrations the API uses. Default path is
`./.data/workeros.sqlite` (or `$DATABASE_PATH`).

```bash
bun run workeros migrate
bun run workeros migrate /var/lib/workeros/data.sqlite
```

For Postgres, use `bun run db:migrate:pg` directly — the CLI is
SQLite-only for now.

### `workeros gen-types`

Fetches `/api/collections` (admin-readable; `--key` for API key auth)
and emits a TypeScript module. Wire into your build:

```jsonc
// package.json
{
  "scripts": {
    "predev": "workeros gen-types $WORKEROS_URL --out src/types/wks.ts"
  }
}
```

Re-run after schema changes. The output is deterministic — safe to commit.

## Adding the SDK to a separate repo

The SDK is published as `@workeros/client` (workspace today; NPM package
in a follow-up). To use locally:

```bash
bun add file:../workeros/packages/client
```

Or, once published:

```bash
bun add @workeros/client
```

The SDK has zero dependencies beyond `@workeros/core` (types only) and
the runtime's `fetch` / `EventSource`.
