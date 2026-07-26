# Notes · Next.js App Router + `backlex`

The same end-user data plane as [`todo-react`](../todo-react), rendered on the
server. The point isn't the notes — it's **where the session token lives**.

The four Vite examples keep the workspace session token in `localStorage`. That
works for a client-rendered SPA and is useless the moment you server-render: a
Server Component runs before any browser JavaScript, so it can't read
`localStorage` — only what the browser *sent*, i.e. cookies.

So this app puts the token in an **httpOnly cookie**:

- Server Components read collections directly — the list is in the HTML, with no
  loading state and no client fetch waterfall.
- Server Actions handle every write, then `revalidatePath("/")` re-runs the page
  with fresh data. That replaces the manual refetch the SPA examples do by hand.
- `httpOnly` means page scripts can't read the token at all, closing the
  XSS-exfiltration path `localStorage` leaves open.
- No backlex client is ever constructed in the browser. Verified against the
  production build: `createClient`, the cookie name, and the workspace slug are
  all absent from `.next/static`.

Two Client Components exist, and neither holds data: the sign-in mode toggle and
a form that resets its input after a successful submit.

## Trade-off worth knowing

httpOnly cuts both ways: a browser-side client can't authenticate either, so
**realtime (SSE) and offline sync are not available in this shape**. If you want
live updates, either keep a readable token alongside the httpOnly one for the
subscription only, or drive updates from the server and stream them down. The
Vite examples show the realtime path; this one shows the server-rendered path.
Pick per screen — they compose fine in one app.

## 1. Run the backend

From the **repo root**:

```bash
bun install
bun run dev          # API + admin SPA on http://localhost:5173
```

## 2. Create a workspace + a `notes` collection

In the admin UI (`http://localhost:5173`):

1. **Workspaces → New** — give it a slug, e.g. `demo`.
2. **Enable open signup** so the app can self-register end-users
   (Workspace → Auth → policy).
3. **Collections → New collection** named `notes`, **owner-scoped: on**, with
   `title` (**text**, required) and `done` (**boolean**, default `false`).

Same schema as `todo-react` — point both at one workspace and they share data.

## 3. Configure and run

```bash
cd examples/nextjs-app
cp .env.example .env        # then set BACKLEX_WORKSPACE to your slug
bun install                 # already done if you ran it at the repo root
bun run dev                 # http://localhost:5179
```

```bash
bun run build && bun run start   # production build + server
```

## How it maps to the SDK

| File | What it shows |
|---|---|
| `lib/session.ts` | the httpOnly cookie: read / write / clear, and why not `localStorage` |
| `lib/backlex.ts` | a **per-request** client (`createClient({ workspace, token })`) — never a module singleton, since the token is per-user state |
| `app/actions.ts` | `"use server"`: `auth.signUp` / `signIn` → write cookie; `from("notes").create/update/delete` → `revalidatePath` |
| `app/page.tsx` | a Server Component calling `from("notes").list()` — plus `export const dynamic = "force-dynamic"`, required because the page reads a cookie |
| `app/sign-in/form.tsx` | `useActionState` wiring a form straight to a Server Action |

## Notes

- **No `NEXT_PUBLIC_` variables.** That prefix inlines a value into the browser
  bundle; nothing here needs to.
- **`redirect()` must sit outside `try/catch`.** It signals by throwing, so a
  surrounding catch swallows it and the redirect silently never happens — see
  `signInAction`.
- **`transpilePackages: ["backlex"]`** is a monorepo detail: the workspace
  package points `main` at TypeScript source. Outside this repo, install the
  published package and drop the line.
- **Admin-plane capabilities** (jobs, flows, agents, permissions) need an admin
  API key and are shown in [`react-router-app`](../react-router-app).
