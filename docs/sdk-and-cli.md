---
title: SDK & CLI
description: The backlex typed fetch wrapper and the backlex CLI for project scaffolding.
---

Two packages ship for client-side and developer-side use.

> Not on TypeScript? backlex also ships native clients for Python, Go, Rust,
> Java, Kotlin, Swift, Dart/Flutter, .NET, Ruby, and PHP — same API, idiomatic in
> each language. See [Client SDKs](/docs/client-sdks/).

## `backlex`

Typed fetch wrapper, browser + Node.

```ts
import { createClient } from "backlex";

const wks = createClient({
  url: "https://api.your.app",
  // For server-to-server / CI; browser apps use the cookie session and skip:
  apiKey: process.env.BACKLEX_API_KEY,
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
const session = await wks.auth.getSession();

// OAuth: returns { url } the browser navigates to (provider id from auth.providers()).
const { url } = await wks.auth.signInSocial("google", { callbackURL: "/" });
// Magic-link sign-in (requires the magic-link plugin on the workspace).
await wks.auth.signInMagicLink({ email, callbackURL: "/" });
// Describes the sign-in surface (provider list + policy flags) for rendering UI.
const surface = await wks.auth.providers();

// Workspace token (app mode) — persist across reloads and restore via createClient({ token }).
const token = wks.auth.getToken();
wks.auth.setToken(token);

// Storage — folderId is optional and scopes the file under a system_folders row.
await wks.storage.put("avatars/me.png", file, "image/png", folderId);
const res = await wks.storage.download("avatars/me.png");
const blob = await res.blob();
await wks.storage.list("avatars/");
await wks.storage.delete("avatars/me.png");
```

### Errors

Failed requests throw `BacklexError`:

```ts
import { BacklexError } from "backlex";
try {
  await wks.from("posts").create({});
} catch (e) {
  if (e instanceof BacklexError) {
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
bun run backlex gen-types https://api.your.app --out src/backlex-types.ts
# Or with API key:
bun run backlex gen-types https://api.your.app --key pak_xxx --out src/backlex-types.ts
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

#### Typed SDK (`--sdk`)

Add `--sdk` to also emit a typed client factory, so you skip the manual
`<T>` on every call:

```bash
bun run backlex gen-types https://api.your.app --sdk --out src/backlex.ts
```

The output adds an import of `backlex` plus:

```ts
export const createTypedClient = (opts: ClientOptions): TypedClient<Collections> =>
  typedCollections<Collections>(createClient(opts));
```

Use it — every collection is keyed by slug and fully typed:

```ts
import { createTypedClient } from "./backlex";

const db = createTypedClient({ url: "https://api.your.app", apiKey: "pak_…" });

const { data } = await db.collections.posts.list();   // data: Posts[]
await db.collections.posts.create({ title: "Hello" }); // typed Partial<Posts>

// The raw client surface (auth, storage, from<T>, …) is still available:
await db.auth.signIn({ email, password });
```

`db.collections.<slug>` is a thin proxy over `db.from(slug)` — no
per-collection runtime code is generated; the types live in `Collections`.

## `backlex` CLI

Run from any project that has `@backlex/cli` (root has it as
`bun run backlex ...`).

```
backlex help
backlex migrate [db-path]                      apply SQLite migrations
backlex gen-types <api-url> [--out <file>] [--key <pak_...>] [--sdk]
                                                 generate TS types (+ typed client with --sdk)
```

### `backlex migrate`

Applies the same Drizzle migrations the API uses. Default path is
`./.data/backlex.sqlite` (or `$DATABASE_PATH`).

```bash
bun run backlex migrate
bun run backlex migrate /var/lib/backlex/data.sqlite
```

For Postgres, use `bun run db:migrate:pg` directly — the CLI is
SQLite-only for now.

### `backlex gen-types`

Fetches `/api/collections` (admin-readable; `--key` for API key auth)
and emits a TypeScript module. Wire into your build:

```jsonc
// package.json
{
  "scripts": {
    "predev": "backlex gen-types $BACKLEX_URL --out src/types/wks.ts"
  }
}
```

Re-run after schema changes. The output is deterministic — safe to commit.

## Adding the SDK to a separate repo

The SDK is published as `backlex` (workspace today; NPM package
in a follow-up). To use locally:

```bash
bun add file:../backlex/packages/client
```

Or, once published:

```bash
bun add backlex
```

The SDK has zero dependencies beyond `@backlex/core` (types only) and
the runtime's `fetch` / `EventSource`.
