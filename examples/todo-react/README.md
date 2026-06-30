# Todo · React + `backlex`

A ~200-line app that shows the three things every backlex app needs:

1. **Auth** — workspace end-users sign up / sign in against `/api/t/<slug>/auth/*`
   (the app-plane pool, separate from the admin dashboard). The session token is
   persisted to `localStorage` and replayed as a bearer.
2. **CRUD** — `client.from<Todo>("todos")` for list / create / update / delete.
3. **Reactive query** — `useLiveQuery(client, "todos", { … })` (from
   `backlex/react`) keeps the list live with zero reducer code: it runs the
   initial page, then maintains the array as rows change. Flip **Active only**
   to send a server-side `filter: { done: false }` — the subscription then gets
   only matching events plus enter/leave transitions, so checking a todo off
   makes it slide out of the list live (no refetch). Mutations just call the
   API; the live query reflects them.

It's intentionally dependency-light: React 19 + Vite + Tailwind, and `backlex`.

In dev the app talks to the API **same-origin** through a Vite proxy (see
`vite.config.ts`) — so there's no CORS to configure locally.

## 1. Run the backend

From the **repo root**:

```bash
bun install
bun run dev          # API + admin SPA on http://localhost:5173
```

First run? Create the admin account and sign in — see the repo `CLAUDE.md`
("Local test admin") or `docs/getting-started.md`.

## 2. Create a workspace + a `todos` collection

In the admin UI (`http://localhost:5173`):

1. **Workspaces → New** — give it a slug, e.g. `demo`. That slug goes in your
   `.env` below. (Background: [`docs/auth-planes.md`](../../docs/auth-planes.md).)
2. **Enable open signup** for the workspace so the app can self-register users
   (Workspace → Auth → policy), or pre-create an app-user.
3. **Collections → New collection** named `todos`:
   - **Owner-scoped: on** — this auto-adds an `owner_id` column and seeds
     owner-scoped read/create/update/delete permissions for the `authenticated`
     role, so each user only ever sees their own todos. No manual permission
     wiring needed. (See [`docs/permissions.md`](../../docs/permissions.md) →
     "ownerScoped".)
   - Field `title` — type **text**, required.
   - Field `done` — type **boolean**, default `false`.

   (`created_at` is added automatically; the app sorts newest-first on it.)

## 3. Configure and run the example

```bash
cd examples/todo-react
cp .env.example .env        # then set VITE_BACKLEX_WORKSPACE to your slug
bun install                 # already done if you ran it at the repo root
bun run dev                 # http://localhost:5174
```

If anything's missing, the app shows a **setup screen** instead of a blank page:
it validates the env vars (with a one-line explanation of each) and pings the
backend to confirm your workspace is reachable — so you see exactly what to fix.
Once it's green, sign up with any email + password (≥8 chars), add a todo, toggle
it, delete it. Open a second tab to watch realtime propagate.

## How it maps to the SDK

| File | What it shows |
|---|---|
| `src/env.ts` + `src/SetupCheck.tsx` | declarative env spec + a gate that validates it and pings the backend before the app renders |
| `src/backlex.ts` | `createClient({ url, workspace, token })` + token persistence |
| `src/App.tsx` (`AuthForm`) | `auth.signUp` / `auth.signIn` / `auth.getSession` / `auth.signOut` |
| `src/App.tsx` (`Todos`) | `from("todos").create/update/delete` + `useLiveQuery(client, "todos", …)` for the live, filterable list |

## Notes

- **Same-origin via the dev proxy.** `vite.config.ts` forwards `/api/*` to the
  backend (default `http://localhost:5173`) and rewrites the `Origin` header so
  better-auth's CSRF check passes — no `EXTRA_TRUSTED_ORIGINS` setup needed
  locally. Going **cross-origin** in production? Set `VITE_BACKLEX_URL` to your
  API origin and register this app's origin as trusted on the backend (the
  `EXTRA_TRUSTED_ORIGINS` env var, or the workspace's auth redirect URLs).
- **Realtime over SSE** uses `EventSource`, which can't attach a bearer header,
  so live events arrive only when the `todos` channel is readable by the request's
  cookie/anon scope. Every mutation also updates state from its direct response,
  so the UI stays correct regardless — the subscription is a cross-tab bonus.
- **Using this outside the monorepo?** Swap the `backlex` `workspace:*`
  dependency for the published package and point `VITE_BACKLEX_URL` at your
  deployed backlex.
- **Typed collections** — in a real project, run
  `bun backlex gen-types --sdk` to generate row types instead of the hand-written
  `Todo` here. See [`docs/sdk-and-cli.md`](../../docs/sdk-and-cli.md).
