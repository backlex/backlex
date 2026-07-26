# Examples

End-to-end apps that **consume** backlex through its client SDKs — the fastest
way to see how a real frontend talks to a backlex backend.

Each example is a self-contained workspace under `examples/*`. They depend on the
in-repo SDKs by `workspace:*`, so they always track the current API. Copying one
out of the monorepo? Swap the `workspace:*` dependency for the published package.

| Example | Stack | Shows |
|---|---|---|
| [`todo-react`](./todo-react) | React 19 + Vite + `backlex` | Workspace auth, collection CRUD, realtime (SSE) |
| [`blog-react`](./blog-react) | React 19 + Vite + `backlex` | Draft/publish + scheduled publish, full-text search, aggregates, fluent query builder, realtime, **multi-language (localized fields) + locale switcher** |
| [`ecommerce-react`](./ecommerce-react) | React 19 + Vite + `backlex` | Filter/sort via query builder, storage image uploads + transforms, cart, batch order writes, aggregates |
| [`showcase-react`](./showcase-react) | React 19 + Vite + `backlex` | One tab per capability: query builder, aggregates, search, realtime, draft/publish, storage, offline sync, feature flags, messaging (real Web Push), **raw REST + GraphQL** |
| [`react-router-app`](./react-router-app) | React Router 8 (framework mode, SSR) + `backlex` | The **admin/server plane**: loaders + actions drive jobs, flows, agents, permission simulation, and usage with an API key that never reaches the browser |
| [`nextjs-app`](./nextjs-app) | Next.js 16 App Router + `backlex` | The end-user plane **server-rendered**: Server Components read, Server Actions write + `revalidatePath`, session token in an **httpOnly cookie** instead of `localStorage` |

**Want the full feature picture?** [`CAPABILITIES.md`](./CAPABILITIES.md) maps
every backlex capability — including the admin / server-side ones (webhooks,
jobs, sandbox, SSO, audit logs…) — to where you can see or configure it.

Three axes to pick along:

- **Which plane?** The first four and `nextjs-app` sign in as a **workspace
  end-user** (the consumer half of the SDK). `react-router-app` covers the other
  half — the `requireAdmin` namespaces a browser app can't reach.
- **Where does it render?** The four Vite apps are client-rendered SPAs;
  `nextjs-app` and `react-router-app` render on the server.
- **Where does the session live?** SPAs use `localStorage` (readable by JS, so
  realtime and offline sync work). `nextjs-app` uses an **httpOnly cookie**
  (unreadable by JS, so server rendering works and XSS can't exfiltrate it — but
  a browser-side client can't authenticate).

See [`CAPABILITIES.md`](./CAPABILITIES.md) for the full feature split.

More to come — mobile (Swift/Kotlin) and other frameworks. Contributions
welcome: add a folder here, keep it minimal and runnable in a couple of
commands, and list it in this table.

## Running any example

1. Start the backend from the repo root: `bun install && bun run dev`
   (API + admin on `http://localhost:5173`).
2. `cd examples/<name>` and follow its README — typically `cp .env.example .env`,
   set a value or two, then `bun run dev`.
