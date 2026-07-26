# Ops console · React Router 8 + `backlex`

The other examples are browser apps: they sign in as a **workspace end-user** and
use the consumer half of the SDK. This one is the missing other half.

`createClient()` also returns `agents`, `jobs`, `flows`, `forms`, `dashboards`,
`permissions`, `usage`, `backups`, `templates`, `schema`, and `migrate`. Every
one of those routes is guarded by `requireAdmin` on the server — a workspace
end-user gets a `403` by construction, which is why no browser example
demonstrates them. They need an **admin API key**, and an API key needs
somewhere to live that isn't the browser.

React Router 8 in **framework mode** is that somewhere. Loaders and actions run
on the server, so:

- the key is read from `process.env` and never enters a bundle (the
  `.server.ts` suffix makes an accidental client import a build error);
- pages arrive server-rendered, with no client fetch waterfall;
- mutations are plain `<Form method="post">` submissions — React Router
  revalidates the loader afterwards, so there is no client cache to invalidate.

## Pages

| Route | SDK surface |
|---|---|
| `/` — Overview | `usage.overview({ days })` (month totals, per-key traffic, limit breaches) + `jobs.list()` |
| `/jobs` | `jobs.enqueue` / `list` / `retry` / `cancel` / `remove` — durable queue with backoff, dead-lettering, and `runAt` scheduling |
| `/flows` | `flows.list` / `run(id, input)` / `update(id, { active })` — drive an automation from code |
| `/agents` | `agents.list` + `agents.run(id, message)` — one reason→act turn with its full tool-call trace |
| `/permissions` | `permissions.simulate(...)` — read-only allow/deny trace, matched rules, compiled SQL predicate, resolved DSL variables |

Each page degrades on its own: no AI provider configured means `/agents` shows an
inline error while the other four keep working.

## 1. Run the backend

From the **repo root**:

```bash
bun install
bun run dev          # API + admin SPA on http://localhost:5173
```

First run? Create the admin account and sign in — see the repo `CLAUDE.md`
("Local test admin") or `docs/getting-started.md`.

## 2. Mint an admin API key

In the admin UI (`http://localhost:5173`) → **API keys** → **New key**, with
admin scope. Copy the `pak_…` value — it is shown exactly once. (See
[`docs/api-keys-and-email.md`](../../docs/api-keys-and-email.md).)

## 3. Configure and run

```bash
cd examples/react-router-app
cp .env.example .env        # then set BACKLEX_API_KEY
bun install                 # already done if you ran it at the repo root
bun run dev                 # http://localhost:5178
```

With no key set, every page renders a setup screen telling you what to do rather
than a wall of 401s.

```bash
bun run build && bun run start   # production build + Node server
```

## Notes

- **The env vars are deliberately not `VITE_`-prefixed.** That prefix is exactly
  what inlines a value into the browser bundle — the one thing an admin key must
  never do. React Router reads them through `process.env` inside
  loaders/actions.
- **`app/backlex.server.ts`** builds the client lazily so a missing key surfaces
  as a setup screen instead of crashing the server at import time, and maps
  `401`/`403` to a message that names the likely cause (wrong key scope).
- **Filters live in the URL.** `/jobs?status=failed` is a `<Form method="get">`,
  so the list is shareable and the back button works — the framework-mode
  alternative to holding filter state in React.
- **One action per route**, discriminated by an `intent` field, returning
  `{ error }` rather than throwing so failures render inline.
- **Why no end-user data plane here?** That's what `todo-react`,
  `blog-react`, `ecommerce-react`, and `showcase-react` are for. Mixing the two
  planes in one app would blur exactly the boundary this example exists to show.
- **Typed collections** — in a real project, run `bun backlex gen-types --sdk`
  to generate row types. See [`docs/sdk-and-cli.md`](../../docs/sdk-and-cli.md).
