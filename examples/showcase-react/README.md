# Showcase · React + `backlex`

A **kitchen-sink** demo that exercises as many consumer-facing backlex SDK
capabilities as possible in one app, organized as tabbed panels. To keep the
admin setup minimal, **every panel drives off a single `notes` collection** —
you only create one collection and toggle a couple of capabilities on it.

Panels:

1. **CRUD + Query builder** — `notes.query().where().orderBy().limit().withMeta("filter_count").list()`,
   plus `create` / `update` / `delete`.
2. **Aggregates** — `aggregate({ agg: "count" })`, `aggregate({ agg: "avg", field: "priority" })`,
   and `aggregate({ agg: "count", groupBy: "_status" })` as a tiny bar list.
3. **Search** — `notes.search({ q, mode: "fts" })` (needs full-text search enabled).
4. **Realtime** — a live event log fed by `backlex.subscribe("items:notes", …)`.
5. **Draft / publish** — `publish` / `unpublish` / `schedulePublish` + a
   `list({ status })` toggle (needs versioning enabled).
6. **Storage** — `storage.put` / `storage.list` / `storage.download` (→ object URL
   preview) / `storage.delete`.
7. **Offline sync** — `backlex.sync({ collection: "notes", store: memoryStore() })`
   with `start` / `pull` / `flush` / `stop` and optimistic `create` / `update` / `remove`.
8. **Feature flags** — `flags.all()` + `flags.isEnabled("beta")` gating a banner.
9. **REST (raw)** — the same endpoints **without the SDK**: plain `fetch` to
   `GET` / `POST /api/items/notes` with the workspace token as a `Bearer` header.
10. **GraphQL** — `POST /api/graphql` with `{ query, variables }`: a `notes`
    list query and a `createNotes` mutation against the auto-generated schema.

The last two show the wire protocol the SDK wraps — reach for them from any
language/runtime that can speak HTTP + JSON. The workspace session token
(`auth.getToken()`) is replayed as a bearer and also pins the request to the
right tenant, so no extra header is needed.

Each panel **degrades gracefully**: if a capability isn't enabled on the
collection (FTS off, versioning off, …), that panel shows an inline error and
the rest of the app keeps working — it never white-screens.

Dependency-light: React 19 + Vite + Tailwind, and `backlex`. In dev the app
talks to the API **same-origin** through a Vite proxy (`vite.config.ts`) — no
CORS to configure locally.

## 1. Run the backend

From the **repo root**:

```bash
bun install
bun run dev          # API + admin SPA on http://localhost:5173
```

First run? Create the admin account and sign in — see the repo `CLAUDE.md`
("Local test admin") or `docs/getting-started.md`.

## 2. Create a workspace + a `notes` collection

In the admin UI (`http://localhost:5173`):

1. **Workspaces → New** — give it a slug, e.g. `demo`. That slug goes in your
   `.env` below. (Background: [`docs/auth-planes.md`](../../docs/auth-planes.md).)
2. **Enable open signup** for the workspace so the app can self-register users
   (Workspace → Auth → policy), or pre-create an app-user.
3. **Collections → New collection** named `notes`:
   - **Owner-scoped: on** — auto-adds `owner_id` and seeds owner-scoped
     read/create/update/delete for the `authenticated` role, so each user only
     manages their own notes. (See [`docs/permissions.md`](../../docs/permissions.md).)
   - **Versioning / draft-publish: on** — gives notes a managed `_status`
     column and powers the **Draft / publish** panel (`publish` / `unpublish` /
     `schedulePublish` + the `list({ status })` filter). (See
     [`docs/draft-publish.md`](../../docs/draft-publish.md).)
   - **Full-text search: on** — enables the **Search** panel
     (`notes.search(...)`). (See [`docs/full-text-search.md`](../../docs/full-text-search.md).)
   - Fields: `title` (**text**, required), `body` (**text**, long), `priority`
     (**number**), `done` (**boolean**). (`_status` is supplied by versioning;
     `created_at` is added automatically.)

> If you skip the versioning / FTS toggles, those two panels surface a backend
> error inline — every other panel still works. Turn them on when you want the
> full tour.

## 3. (Optional) Add a feature flag for the Flags panel

In the admin UI → **Feature flags**:

- Create a flag with key **`beta`** and turn it **on** (a simple boolean rollout
  is enough). The Flags panel shows a 🎉 banner when `flags.isEnabled("beta")`
  resolves to `true`, and lists every evaluated flag with its enabled state /
  remote-config value. (See [`docs/feature-flags.md`](../../docs/feature-flags.md).)

With no flags configured the panel just shows an empty list — still valid.

## 4. Configure and run the example

```bash
cd examples/showcase-react
cp .env.example .env        # then set VITE_BACKLEX_WORKSPACE to your slug
bun install                 # already done if you ran it at the repo root
bun run dev                 # http://localhost:5177
```

If anything's missing, the app shows a **setup screen** instead of a blank page:
it validates the env vars and pings the backend to confirm your workspace is
reachable. Once it's green, sign up and click through the tabs.

## How it maps to the SDK

| Panel / file | SDK call(s) it demonstrates |
|---|---|
| `src/env.ts` + `src/SetupCheck.tsx` | declarative env spec + a gate that validates it and pings the backend (`auth.providers()`) before the app renders |
| `src/backlex.ts` | `createClient({ url, workspace, token })` + token persistence; `backlex.from<Note>("notes")` |
| `App.tsx` · `AuthForm` | `auth.signUp` / `auth.signIn` / `auth.getSession` / `auth.signOut` / `auth.getToken` |
| `App.tsx` · `CrudPanel` | `query().where().orderBy().limit().withMeta("filter_count").list()`, `create`, `update`, `delete` |
| `App.tsx` · `AggregatePanel` | `aggregate({ agg: "count" })`, `aggregate({ agg: "avg", field: "priority" })`, `aggregate({ agg: "count", groupBy: "_status" })` |
| `App.tsx` · `SearchPanel` | `search({ q, mode: "fts" })` |
| `App.tsx` · `RealtimePanel` | `subscribe("items:notes", …)` |
| `App.tsx` · `PublishPanel` | `publish`, `unpublish`, `schedulePublish`, `list({ status })` |
| `App.tsx` · `StoragePanel` | `storage.put`, `storage.list`, `storage.download`, `storage.delete` |
| `App.tsx` · `SyncPanel` | `sync({ collection, store: memoryStore() })` → `start` / `pull` / `flush` / `stop` / `create` / `update` / `remove` / `getAll` |
| `App.tsx` · `FlagsPanel` | `flags.all()`, `flags.isEnabled("beta")` |
| `App.tsx` · `RestPanel` | raw `fetch` → `GET` / `POST /api/items/notes` with a `Bearer` token (no SDK) |
| `App.tsx` · `GraphqlPanel` | raw `fetch` → `POST /api/graphql` `{ query, variables }`: `notes` query + `createNotes` mutation |

For the full list of backlex capabilities and which example demonstrates each,
see [`../CAPABILITIES.md`](../CAPABILITIES.md).

## Notes

- **Panels degrade gracefully.** Each panel wraps its SDK calls in try/catch and
  shows an inline error, so a capability that isn't enabled (FTS, versioning) —
  or a permission the role lacks — never crashes the app.
- **Offline sync uses `memoryStore()`** (non-persistent) so the demo resets on
  reload. Swap in `indexedDbStore({ collection: "notes" })` (also exported from
  `backlex`) to persist the local store across reloads. (See
  [`docs/offline-sync.md`](../../docs/offline-sync.md).)
- **Same-origin via the dev proxy** and **realtime over SSE** work exactly as in
  the `blog-react` / `todo-react` examples — see those folders' READMEs for the
  deeper notes.
- **Typed collections** — in a real project, run `bun backlex gen-types --sdk`
  to generate row types instead of the hand-written `Note` here.
