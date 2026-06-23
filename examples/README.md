# Examples

End-to-end apps that **consume** backlex through its client SDKs — the fastest
way to see how a real frontend talks to a backlex backend.

Each example is a self-contained workspace under `examples/*`. They depend on the
in-repo SDKs by `workspace:*`, so they always track the current API. Copying one
out of the monorepo? Swap the `workspace:*` dependency for the published package.

| Example | Stack | Shows |
|---|---|---|
| [`todo-react`](./todo-react) | React 19 + Vite + `backlex` | Workspace auth, collection CRUD, realtime (SSE) |
| [`blog-react`](./blog-react) | React 19 + Vite + `backlex` | Draft/publish + scheduled publish, full-text search, aggregates, fluent query builder, realtime, **multi-language (`i18n_text`) + locale switcher** |
| [`ecommerce-react`](./ecommerce-react) | React 19 + Vite + `backlex` | Filter/sort via query builder, storage image uploads + transforms, cart, batch order writes, aggregates |
| [`showcase-react`](./showcase-react) | React 19 + Vite + `backlex` | One tab per capability: query builder, aggregates, search, realtime, draft/publish, storage, offline sync, feature flags, **raw REST + GraphQL** |

**Want the full feature picture?** [`CAPABILITIES.md`](./CAPABILITIES.md) maps
every backlex capability — including the admin / server-side ones (webhooks,
jobs, sandbox, SSO, audit logs…) — to where you can see or configure it.

More to come — mobile (Swift/Kotlin) and other frameworks. Contributions
welcome: add a folder here, keep it minimal and runnable in a couple of
commands, and list it in this table.

## Running any example

1. Start the backend from the repo root: `bun install && bun run dev`
   (API + admin on `http://localhost:5173`).
2. `cd examples/<name>` and follow its README — typically `cp .env.example .env`,
   set a value or two, then `bun run dev`.
