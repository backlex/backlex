# Blog · React + `backlex`

A small editor + reader that shows the publishing-focused side of backlex:

1. **Auth** — workspace end-users sign up / sign in against `/api/t/<slug>/auth/*`
   (the app-plane pool, separate from the admin dashboard). The session token is
   persisted to `localStorage` and replayed as a bearer.
2. **Draft / publish** — posts are created as **drafts**, then `publish()` /
   `unpublish()` / `schedulePublish()` move them through their lifecycle (a
   *versioned* collection). The status tabs use the SDK's `status` filter.
3. **Full-text search** — `posts.search({ q, mode: "fts" })` against the keyword
   index.
4. **Fluent query builder** — `posts.query().orderBy().limit().withMeta().list()`.
5. **Aggregates** — `posts.aggregate({ agg: "count", groupBy: "_status" })` powers
   the published/draft counts in the header (`_status` is the versioned
   collection's managed lifecycle column).
6. **Realtime** — `client.subscribe("items:posts", …)` keeps the list live.
7. **Multi-language** — `title` and `body` are **localized** `text` fields (a
   per-locale `{ en, tr }` map). The composer writes both languages; the header
   **EN / TR switcher** re-lists with `list({ locale })`, which collapses every
   localized field to the chosen language (with a fallback chain).

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

## 2. Create a workspace + a `posts` collection

In the admin UI (`http://localhost:5173`):

1. **Workspaces → New** — give it a slug, e.g. `demo`. That slug goes in your
   `.env` below. (Background: [`docs/auth-planes.md`](../../docs/auth-planes.md).)
2. **Enable open signup** for the workspace so the app can self-register users
   (Workspace → Auth → policy), or pre-create an app-user.
3. **Add the languages** — Settings → Languages: keep `en` and add `tr` (or any
   BCP-47 code). This drives the admin Translations UI; the data-layer
   `?locale=xx` collapse works regardless. (See
   [`docs/locale-timezone.md`](../../docs/locale-timezone.md).)
4. **Create the `posts` collection.** It needs two **localized** fields
   (`title`, `body`). In the admin **New collection** flow, add `title` / `body`
   as **Text** and flip the **Localized** toggle on each (the others are plain
   **text**), and turn on **Owner-scoped**, **Versioning**, and **Full-text
   search**. The admin item editor then shows one input **per workspace
   language** for those fields (add languages under Settings → Languages, step
   3).

   Prefer scripting it? The same thing via the API — sign in as admin in the
   browser (so the cookie is set), then from your terminal:

   ```bash
   curl -X POST http://localhost:5173/api/collections \
     -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
     --cookie "$(your admin session cookie)" \
     -d '{
       "slug": "posts",
       "ownerScoped": true,
       "versioned": true,
       "fts": true,
       "fields": [
         { "name": "title",   "type": "text",     "localized": true, "required": true },
         { "name": "slug",    "type": "text" },
         { "name": "excerpt", "type": "text",     "searchable": true },
         { "name": "body",    "type": "longtext", "localized": true }
       ]
     }'
   ```

   What each flag does:
   - **`ownerScoped`** — adds `owner_id` + seeds owner-scoped
     read/create/update/delete for the `authenticated` role, so each author only
     manages their own posts. ([`docs/permissions.md`](../../docs/permissions.md))
   - **`versioned`** — gives posts a managed `_status` column and powers
     `publish` / `unpublish` / `schedulePublish`.
     ([`docs/draft-publish.md`](../../docs/draft-publish.md))
   - **`fts`** — enables `posts.search(...)`. `excerpt` stays plain text +
     `searchable` so it feeds the keyword index.
     ([`docs/full-text-search.md`](../../docs/full-text-search.md))
   - **`title` / `body` = localized** — one value per locale stored as a
     `{ en, tr }` map; `?locale=xx` collapses it on read.
     ([`docs/locale-timezone.md`](../../docs/locale-timezone.md))

## 3. Configure and run the example

```bash
cd examples/blog-react
cp .env.example .env        # then set VITE_BACKLEX_WORKSPACE to your slug
bun install                 # already done if you ran it at the repo root
bun run dev                 # http://localhost:5175
```

If anything's missing, the app shows a **setup screen** instead of a blank page:
it validates the env vars and pings the backend to confirm your workspace is
reachable. Once it's green, sign up, write a draft, publish it, search, and open
a second tab to watch realtime propagate.

## How it maps to the SDK

| File | What it shows |
|---|---|
| `src/env.ts` + `src/SetupCheck.tsx` | declarative env spec + a gate that validates it and pings the backend before the app renders |
| `src/backlex.ts` | `createClient({ url, workspace, token })` + token persistence |
| `src/App.tsx` (`AuthForm`) | `auth.signUp` / `auth.signIn` / `auth.getSession` / `auth.signOut` |
| `src/App.tsx` (`Blog`) | `query().orderBy().withMeta().list({ status, locale })`, `aggregate({ groupBy })`, `search({ mode: "fts", locale })`, `subscribe("items:posts")`, EN/TR locale switcher |
| `src/App.tsx` (`Composer`) | writes localized fields as a `{ en, tr }` map |
| `src/App.tsx` (`PostCard`) | `publish` / `unpublish` / `schedulePublish` / `delete` |

For the full list of backlex capabilities and which example demonstrates each,
see [`../CAPABILITIES.md`](../CAPABILITIES.md).

## Bonus: react to new posts with a Flow (server-side automation)

**Flows** are backlex's server-side automation engine — a *trigger* plus a list
of *operations* that run on the server when the trigger fires. They're
**admin-only**, so this end-user app doesn't call them — but a flow's effect
flows right back through the data the app reads. You manage them from the admin
**Flows** page, raw `POST /api/flows`, or — for an admin/server-side script —
the SDK (`client.flows.create/run/list/...`) and GraphQL (`createFlow` /
`runFlow`). Here's one that fires whenever this blog creates a post.

Create it via the API (sign in as admin in the browser so the cookie is set):

```bash
curl -X POST http://localhost:5173/api/flows \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  --cookie "$(your admin session cookie)" \
  -d '{
    "name": "Notify on new post",
    "trigger": "event:items:posts:created",
    "active": true,
    "operations": [
      { "type": "log", "message": "New post: {{ data.slug }} (id {{ data.id }})" },
      { "type": "notification", "title": "New blog post",
        "body": "Draft \"{{ data.slug }}\" was just created.", "userId": null }
    ]
  }'
```

- **Trigger** — item events publish on the channel `items:<slug>`, so the key is
  `event:items:posts:created` (use `event:items:posts:*` for any post event, or
  `:updated` / `:deleted`). The flow's `data` payload is the row that changed, so
  `{{ data.slug }}`, `{{ data.id }}`, `{{ data.owner_id }}`, … are all available.
- **Operations** — this one logs a line and drops an admin **notification**
  (`userId: null` broadcasts to admins). Other op types: `email`, `push`,
  `function` (run a saved sandbox function), `item.create` / `item.update`,
  `request` / `webhook`, `condition` (branch), `delay`, `transform`.

Now **create a post in the app** (or publish one) → the flow runs server-side:
you'll see the `[flow] New post: …` line in the `bun run dev` output and a new
row in the admin notification feed. See [`../CAPABILITIES.md`](../CAPABILITIES.md)
for where Flows sits among the other admin/server-side capabilities.

## Notes

- **Versioning required for draft/publish.** If the collection isn't versioned,
  `publish`/`unpublish`/`schedulePublish` 4xx and every row reads as published.
  Toggle it on in the collection settings.
- **Search needs the FTS capability.** Until "Full-text search" is enabled on
  `posts`, the search box surfaces a backend error — the rest of the app works.
- **Same-origin via the dev proxy** and **realtime over SSE** work exactly as in
  the `todo-react` example — see that folder's README for the deeper notes.
- **Typed collections** — in a real project, run `bun backlex gen-types --sdk`
  to generate row types instead of the hand-written `Post` here.
